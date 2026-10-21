// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Integration: which cloud identities a CLI caller may bind, use and list, against real Postgres
// and real row-level security.
//
// The rule is `identityScopeWhere` (lib/runners/claim-identity.ts): an `org` identity of the active
// org, or — for a PERSON — their own `personal` one. A CLI service token is pinned to an org and
// acts as the profile that minted it, so its actor's `userId` is the minter's; it gets the org arm
// only. Each path below is driven through its real route:
//
//   1. POST /api/cli/projects/:id/design — the design write (updateProjectDesign) refuses an
//      identity the caller may not use, unless the project already stores it.
//   2. POST /api/jobs PLAN — buildConfigSnapshot refuses a token's job on a project bound to its
//      minter's personal identity. The same PLAN by that person is queued, and the claim hands the
//      runner that identity: the positive control, so the refusal cannot pass by the job failing
//      for some other reason.
//   3. POST /api/cli/runners/deploy — the identity a DEPLOY_RUNNER job carries.
//   4. GET /api/cli/cloud-identities and /:id/inventory — the identity list and inventory read.
//
// The CLI token, the runner token, the scope resolver, the PDP and the billing gates are stubbed
// (their own suites pin them); the SQL that decides which identity is found, the RLS scope the
// server actions run under, and the job the claim route hands out are real.

import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { describeIfDb } from "./db";

vi.mock("@/lib/cli/auth", () => ({ verifyCliToken: vi.fn() }));
vi.mock("@/lib/runners/auth", () => ({ verifyRunnerToken: vi.fn() }));
vi.mock("@/lib/runners/snapshot-sig", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/runners/snapshot-sig")>()),
	verifySnapshot: () => true,
}));
vi.mock("@/lib/auth/scope", () => ({ getActiveScope: vi.fn() }));
vi.mock("@/lib/authz/guard", async (importOriginal) => ({
	// Real: `userIdIsTheCaller`, the pure credential mapping the routes read.
	...(await importOriginal<typeof import("@/lib/authz/guard")>()),
	authorize: vi.fn(),
	currentActor: vi.fn(),
	authorizeCli: vi.fn(),
	ensureCliOrgAccess: vi.fn(),
	assertMintingProfileStillMember: vi.fn(),
}));
vi.mock("@/lib/authz", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/authz")>()),
	getPdp: () => ({
		can: async () => ({ allowed: true }),
		enforce: async () => undefined,
	}),
}));
vi.mock("@/lib/billing/usage-guard", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/billing/usage-guard")>()),
	assertUsageAllowed: vi.fn(async () => undefined),
}));
vi.mock("@/lib/billing/job-quota", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/billing/job-quota")>()),
	assertJobQuotaAllowed: vi.fn(async () => undefined),
}));
// The design document's own validation is not the subject; the body is the console's own export.
vi.mock("@/lib/validations/project-form.schema", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/validations/project-form.schema")>()),
	projectFormSchema: { safeParse: (raw: unknown) => ({ success: true, data: raw }) },
}));
vi.mock("@/lib/scaler", () => ({ notifyScaler: vi.fn() }));

import { getProjectAsFormData } from "@/app/server/actions/projects";
import { POST as designPost } from "@/app/api/cli/projects/[id]/design/route";
import { GET as identitiesGet } from "@/app/api/cli/cloud-identities/route";
import { GET as inventoryGet } from "@/app/api/cli/cloud-identities/[id]/inventory/route";
import { POST as deployRunnerPost } from "@/app/api/cli/runners/deploy/route";
import { POST as registerRunnerPost } from "@/app/api/cli/runners/register/route";
import { POST as claimPost } from "@/app/api/jobs/claim/route";
import { POST as jobsPost } from "@/app/api/jobs/route";
import { getActiveScope } from "@/lib/auth/scope";
import { getInjectedActor, runWithActor } from "@/lib/authz/actor-context";
import { actorWithCredential } from "@/lib/authz/actor-credential";
import {
	assertMintingProfileStillMember,
	authorize,
	authorizeCli,
	currentActor,
	ensureCliOrgAccess,
} from "@/lib/authz/guard";
import type { Actor } from "@/lib/authz/types";
import { verifyCliToken } from "@/lib/cli/auth";
import { getServiceDb } from "@/lib/db";
import {
	cloudIdentities,
	jobs,
	projectChanges,
	projectEnvironments,
	projectFabrics,
	projects,
	resourceHierarchy,
	runners,
} from "@/lib/db/schema";
import { insertProjectWithDefaultFabric } from "@/lib/queries/projects";
import { verifyRunnerToken } from "@/lib/runners/auth";

/** The member who mints the service token, and the author of PERSONAL. */
const MINTER = randomUUID();
/** Another member of the team org. */
const TEAMMATE = randomUUID();
/** The team org the token is pinned to. */
const TEAM = randomUUID();
const TOKEN_HASH = `hash-it-idb-${MINTER}`;
const HOME_TOKEN_HASH = `hash-it-idb-home-${MINTER}`;
const PERSONAL_CANARY = "arn:aws:iam::000000000000:role/CANARY-idb-minter-personal";
const HOME_CANARY = "arn:aws:iam::000000000000:role/CANARY-idb-minter-home";

/** `org` scope in TEAM: the org's shared identity. */
let orgIdentity: string;
/** `personal` scope, authored by MINTER, created while MINTER was acting in TEAM. */
let minterPersonal: string;
/** `personal` scope, authored by TEAMMATE, in TEAM. */
let teammatePersonal: string;
/** A TEAM project bound to the org identity: the design-write subject. */
let orgBoundProject: string;
/** A TEAM project bound to MINTER's personal identity (a member's legitimate choice). */
let personalBoundProject: string;
/**
 * `personal` scope, authored by MINTER, in MINTER's own personal workspace (`org_id = MINTER`): the
 * shape a personal identity has in production today, as opposed to `minterPersonal`'s older one.
 */
let minterHome: string;
/** A TEAM project bound to `minterHome`. */
let homeBoundTeamProject: string;
/** A project in MINTER's personal workspace, bound to `minterHome`. */
let workspaceProject: string;
let runnerId: string;
/** A runner in MINTER's personal workspace, for the workspace project's jobs. */
let homeRunnerId: string;

const SESSION: Actor = actorWithCredential({ userId: MINTER, orgId: TEAM }, "session");

/**
 * Makes every CLI route below see MINTER acting in `orgId` with `credential`, as `authorizeCli`
 * and the `/api/jobs` token check would resolve it. `orgId` is the token's pin for a token.
 */
function actAs(credential: "session" | "service_token", orgId = TEAM) {
	const actor = actorWithCredential({ userId: MINTER, orgId }, credential);
	vi.mocked(authorizeCli).mockResolvedValue(
		credential === "service_token"
			? { actor, credential, serviceTokenId: "tok-idb", orgScope: [orgId] }
			: { actor, credential, orgScope: [orgId, MINTER] },
	);
	vi.mocked(verifyCliToken).mockResolvedValue({
		payload:
			credential === "service_token"
				? { sub: MINTER, service_token_org_id: orgId, service_token_id: "tok-idb" }
				: { sub: MINTER },
		error: null,
	});
}

/** Inserts one verified aws identity and returns its id. */
async function seedIdentity(v: {
	user_id: string;
	scope: "personal" | "org";
	role_arn: string;
	org_id?: string;
}): Promise<string> {
	const [row] = await getServiceDb()
		.insert(cloudIdentities)
		.values({
			user_id: v.user_id,
			org_id: v.org_id ?? TEAM,
			scope: v.scope,
			provider: "aws",
			name: `it-idb-${randomUUID().slice(0, 8)}`,
			credentials: { role_arn: v.role_arn, account_id: "000000000000" },
			is_verified: true,
		})
		.returning({ id: cloudIdentities.id });
	return row.id;
}

/** Creates a project in `orgId` bound to `identityId`, the way the CLI create route does. */
async function seedProject(identityId: string, orgId = TEAM): Promise<string> {
	const { project } = await getServiceDb().transaction((tx) =>
		insertProjectWithDefaultFabric(tx, {
			project_name: `it-idb-${randomUUID().slice(0, 8)}`,
			region: "us-east-1",
			cloud_identity_id: identityId,
			iac_version: "1.9.5",
			environment_stage: "production",
			owner: MINTER,
			orgId,
		}),
	);
	return project.id;
}

/** The project's stored identity, read on the service role. */
async function storedIdentity(projectId: string): Promise<string | null> {
	const [row] = await getServiceDb()
		.select({ cloud_identity_id: projects.cloud_identity_id })
		.from(projects)
		.where(eq(projects.id, projectId))
		.limit(1);
	return row?.cloud_identity_id ?? null;
}

/** The project's design as the console exports it, with the project identity set to `identityId`. */
async function designNaming(projectId: string, identityId: string) {
	const { formData } = await runWithActor(SESSION, () => getProjectAsFormData(projectId));
	return { ...formData, project: { ...formData.project, cloud_identity_id: identityId } };
}

/** POSTs a design document to the CLI design route. */
function postDesign(projectId: string, body: unknown): Promise<Response> {
	return designPost(
		new Request(`https://console.local/api/cli/projects/${projectId}/design`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		}),
		{ params: Promise.resolve({ id: projectId }) },
	);
}

/** POSTs a PLAN of `projectId` to /api/jobs, assigned to `runner`. */
function postPlan(projectId: string, runner = runnerId): Promise<Response> {
	return jobsPost(
		new Request("https://console.local/api/jobs", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				job_type: "PLAN",
				configuration_id: projectId,
				assigned_runner_id: runner,
			}),
		}),
	);
}

/** The PLAN jobs queued for `projectId`. */
async function planJobs(projectId: string) {
	return getServiceDb()
		.select({ id: jobs.id, cloud_identity_id: jobs.cloud_identity_id, user_id: jobs.user_id })
		.from(jobs)
		.where(and(eq(jobs.project_id, projectId), eq(jobs.job_type, "PLAN")));
}

const claimBody = z.object({
	job: z.object({ id: z.string() }).nullable(),
	cloud_identity: z.object({ role_arn: z.string() }).nullable().optional(),
});

const identitiesBody = z.object({
	cloud_identities: z.array(z.object({ id: z.string() })),
});

describeIfDb("cloud identity binding — design writes, enqueue, runner deploy, identity reads", () => {
	beforeAll(async () => {
		orgIdentity = await seedIdentity({
			user_id: TEAMMATE,
			scope: "org",
			role_arn: "arn:aws:iam::111111111111:role/idb-org",
		});
		minterPersonal = await seedIdentity({
			user_id: MINTER,
			scope: "personal",
			role_arn: PERSONAL_CANARY,
		});
		teammatePersonal = await seedIdentity({
			user_id: TEAMMATE,
			scope: "personal",
			role_arn: "arn:aws:iam::222222222222:role/idb-teammate-personal",
		});
		minterHome = await seedIdentity({
			user_id: MINTER,
			org_id: MINTER,
			scope: "personal",
			role_arn: HOME_CANARY,
		});
		orgBoundProject = await seedProject(orgIdentity);
		personalBoundProject = await seedProject(minterPersonal);
		homeBoundTeamProject = await seedProject(minterHome);
		workspaceProject = await seedProject(minterHome, MINTER);
		const [homeRunner] = await getServiceDb()
			.insert(runners)
			.values({
				user_id: MINTER,
				org_id: MINTER,
				name: `it-idb-home-${MINTER.slice(0, 8)}`,
				operator: "self",
				provisioning: "registered",
				token_hash: HOME_TOKEN_HASH,
				status: "OFFLINE",
			})
			.returning({ id: runners.id });
		homeRunnerId = homeRunner.id;
		const [runner] = await getServiceDb()
			.insert(runners)
			.values({
				user_id: MINTER,
				org_id: TEAM,
				name: `it-idb-${MINTER.slice(0, 8)}`,
				operator: "self",
				provisioning: "registered",
				token_hash: TOKEN_HASH,
				status: "OFFLINE",
			})
			.returning({ id: runners.id });
		runnerId = runner.id;
	});

	afterAll(async () => {
		const db = getServiceDb();
		const ids = [orgBoundProject, personalBoundProject, homeBoundTeamProject, workspaceProject].filter(
			Boolean,
		);
		await db.delete(jobs).where(inArray(jobs.org_id, [TEAM, MINTER]));
		if (ids.length > 0) {
			await db.delete(projectEnvironments).where(inArray(projectEnvironments.project_id, ids));
			await db.delete(projectFabrics).where(inArray(projectFabrics.project_id, ids));
			await db
				.delete(resourceHierarchy)
				.where(
					and(
						eq(resourceHierarchy.child_type, "project"),
						inArray(resourceHierarchy.child_id, ids),
					),
				);
			await db.delete(projects).where(inArray(projects.id, ids));
		}
		await db.delete(runners).where(inArray(runners.org_id, [TEAM, MINTER]));
		await db
			.delete(cloudIdentities)
			.where(
				inArray(cloudIdentities.id, [orgIdentity, minterPersonal, teammatePersonal, minterHome]),
			);
	});

	beforeEach(() => {
		vi.clearAllMocks();
		// The server actions authorize through the PDP and read the actor the route bound; the PDP is
		// stubbed, so `authorize` answers with that actor exactly as the real one would.
		vi.mocked(authorize).mockImplementation(async () => getInjectedActor() ?? SESSION);
		vi.mocked(currentActor).mockImplementation(async () => getInjectedActor() ?? SESSION);
		vi.mocked(getActiveScope).mockImplementation(async (userId: string, orgId?: string) => ({
			userId,
			orgId: orgId ?? TEAM,
		}));
		vi.mocked(ensureCliOrgAccess).mockResolvedValue(null);
		vi.mocked(assertMintingProfileStillMember).mockResolvedValue(null);
		vi.mocked(verifyRunnerToken).mockResolvedValue({
			runnerId,
			tokenHash: TOKEN_HASH,
			operator: "self",
			error: null,
		});
		actAs("session");
	});

	// ── 1. The design write ───────────────────────────────────────────────────────────────────
	it("refuses a token's design that binds its minter's personal identity, and stores nothing", async () => {
		const doc = await designNaming(orgBoundProject, minterPersonal);
		actAs("service_token");

		const res = await postDesign(orgBoundProject, doc);

		expect(res.status).toBe(404);
		expect((await res.json()).error).toMatch(/service token can use only/i);
		expect(await storedIdentity(orgBoundProject)).toBe(orgIdentity);
	});

	it("refuses a member's design that binds ANOTHER member's personal identity", async () => {
		const doc = await designNaming(orgBoundProject, teammatePersonal);

		const res = await postDesign(orgBoundProject, doc);

		expect(res.status).toBe(404);
		expect(await storedIdentity(orgBoundProject)).toBe(orgIdentity);
	});

	it("applies the same document from the person who owns the identity (positive control)", async () => {
		const doc = await designNaming(orgBoundProject, minterPersonal);

		const res = await postDesign(orgBoundProject, doc);

		expect(res.status).toBe(200);
		expect(await storedIdentity(orgBoundProject)).toBe(minterPersonal);
		// Put it back for the cases below.
		await getServiceDb()
			.update(projects)
			.set({ cloud_identity_id: orgIdentity })
			.where(eq(projects.id, orgBoundProject));
	});

	it("lets a token edit a project whose stored identity it could not bind (unchanged)", async () => {
		const doc = await designNaming(personalBoundProject, minterPersonal);
		actAs("service_token");

		const res = await postDesign(personalBoundProject, doc);

		expect(res.status).toBe(200);
		expect(await storedIdentity(personalBoundProject)).toBe(minterPersonal);
	});

	// ── 2. The enqueue backstop ───────────────────────────────────────────────────────────────
	it("refuses a token's PLAN of a project bound to its minter's personal identity, and queues nothing", async () => {
		actAs("service_token");

		const res = await postPlan(personalBoundProject);

		expect(res.status).not.toBe(201);
		expect((await res.json()).error).toMatch(/personal cloud account, and a service token/);
		expect(await planJobs(personalBoundProject)).toEqual([]);
	});

	it("queues the same PLAN for the person, and the claim hands the runner that identity (positive control)", async () => {
		const res = await postPlan(personalBoundProject);

		expect(res.status).toBe(201);
		const queued = await planJobs(personalBoundProject);
		expect(queued).toHaveLength(1);
		expect(queued[0]).toMatchObject({ cloud_identity_id: minterPersonal, user_id: MINTER });

		const claim = await claimPost(
			new Request("https://console.local/api/jobs/claim", { method: "POST" }),
		);
		expect(claim.status).toBe(200);
		const body = claimBody.parse(await claim.json());
		expect(body.job?.id).toBe(queued[0].id);
		expect(body.cloud_identity?.role_arn).toBe(PERSONAL_CANARY);
	});

	// ── 3. The runner deploy ──────────────────────────────────────────────────────────────────
	it("refuses a token's runner deploy that names its minter's personal identity", async () => {
		actAs("service_token");

		const res = await deployRunnerPost(
			new Request("https://console.local/api/cli/runners/deploy", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					name: `it-idb-deploy-${randomUUID().slice(0, 6)}`,
					cloud_identity_id: minterPersonal,
					region: "us-east-1",
				}),
			}),
		);

		expect(res.status).toBe(404);
		const written = await getServiceDb()
			.select({ id: jobs.id })
			.from(jobs)
			.where(and(eq(jobs.org_id, TEAM), eq(jobs.job_type, "DEPLOY_RUNNER")));
		expect(written).toEqual([]);
	});

	// ── 4. The identity reads ─────────────────────────────────────────────────────────────────
	it("lists a member the org's identities and their own, never another member's personal one", async () => {
		const res = await identitiesGet(
			new Request("https://console.local/api/cli/cloud-identities"),
		);
		expect(res.status).toBe(200);
		const ids = identitiesBody.parse(await res.json()).cloud_identities.map((i) => i.id);

		expect(ids).toContain(orgIdentity);
		expect(ids).toContain(minterPersonal);
		expect(ids).not.toContain(teammatePersonal);
	});

	it("lists a service token the org's identities only", async () => {
		actAs("service_token");
		const res = await identitiesGet(
			new Request("https://console.local/api/cli/cloud-identities"),
		);
		const ids = identitiesBody.parse(await res.json()).cloud_identities.map((i) => i.id);

		expect(ids).toContain(orgIdentity);
		expect(ids).not.toContain(minterPersonal);
		expect(ids).not.toContain(teammatePersonal);
	});

	it("refuses another member's personal identity's inventory, and serves the org's", async () => {
		/** GETs the inventory of `id`. */
		const inventory = (id: string) =>
			inventoryGet(
				new Request(`https://console.local/api/cli/cloud-identities/${id}/inventory`),
				{ params: Promise.resolve({ id }) },
			);

		expect((await inventory(teammatePersonal)).status).toBe(404);
		expect((await inventory(orgIdentity)).status).toBe(200);
	});

	// ── 5. The same rule at staging time, for the production shape, and in a personal workspace ──
	it("refuses a token's STAGED design that binds its minter's personal identity, and stages nothing", async () => {
		const doc = await designNaming(orgBoundProject, minterPersonal);
		actAs("service_token");

		const res = await designPost(
			new Request(`https://console.local/api/cli/projects/${orgBoundProject}/design?stage`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(doc),
			}),
			{ params: Promise.resolve({ id: orgBoundProject }) },
		);

		expect(res.status).toBe(404);
		expect((await res.json()).error).toMatch(/service token can use only/i);
		const staged = await getServiceDb()
			.select({ id: projectChanges.id })
			.from(projectChanges)
			.where(eq(projectChanges.project_id, orgBoundProject));
		expect(staged).toEqual([]);
	});

	// A personal identity as production writes it today: in its author's own workspace.
	it("refuses a team-pinned token's PLAN of a team project bound to a personal identity from its minter's workspace", async () => {
		actAs("service_token");

		const res = await postPlan(homeBoundTeamProject);

		expect(res.status).not.toBe(201);
		expect((await res.json()).error).toMatch(/personal cloud account, and a service token/);
		expect(await planJobs(homeBoundTeamProject)).toEqual([]);
	});

	// A token pinned to its minter's OWN personal workspace acts for the only person there, so that
	// person's personal identities stay usable — and the claim hands the runner the one bound.
	it("queues a personal-workspace token's PLAN with its minter's personal identity, and the claim releases it", async () => {
		actAs("service_token", MINTER);
		vi.mocked(verifyRunnerToken).mockResolvedValue({
			runnerId: homeRunnerId,
			tokenHash: HOME_TOKEN_HASH,
			operator: "self",
			error: null,
		});

		const res = await postPlan(workspaceProject, homeRunnerId);

		expect(res.status).toBe(201);
		const queued = await planJobs(workspaceProject);
		expect(queued).toHaveLength(1);
		expect(queued[0]).toMatchObject({ cloud_identity_id: minterHome, user_id: MINTER });
		const claim = await claimPost(
			new Request("https://console.local/api/jobs/claim", { method: "POST" }),
		);
		expect(claim.status).toBe(200);
		const body = claimBody.parse(await claim.json());
		expect(body.job?.id).toBe(queued[0].id);
		expect(body.cloud_identity?.role_arn).toBe(HOME_CANARY);
	});

	// ── 6. The runner register route ─────────────────────────────────────────────────────────
	it("refuses a team-pinned token's runner registration on its minter's personal identity, and accepts the org's", async () => {
		actAs("service_token");
		/** POSTs a runner registration naming `identityId`. */
		const register = (identityId: string) =>
			registerRunnerPost(
				new Request("https://console.local/api/cli/runners/register", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						name: `it-idb-reg-${randomUUID().slice(0, 6)}`,
						cloud_identity_id: identityId,
					}),
				}),
			);

		expect((await register(minterHome)).status).toBe(400);
		expect((await register(orgIdentity)).status).toBe(201);
	});
});
