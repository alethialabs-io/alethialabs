// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Integration: a cloud identity reaches a job only inside the identity's own tenant (#5479), against
// real Postgres.
//
// Three seams, each driven through its real route:
//   1. POST /api/jobs/claim loads the claimed job's identity by id AND the job's tenancy, so a job row
//      that names another org's identity is handed no credentials. The job rows here are written
//      directly — the "bad row" the enqueue checks exist to prevent — because the claim route must
//      hold even when one exists.
//   2. POST /api/jobs (DESTROY_RUNNER) refuses an identity id from another org with a 404.
//   3. POST /api/cli/projects refuses to bind another org's identity to a new project.
//
// The CLI token, the runner token, the scope resolver and the PDP are stubbed (their own suites pin
// them); the SQL that decides which identity is found is real, and it is the subject.

import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { describeIfDb } from "./db";

vi.mock("@/lib/cli/auth", () => ({ verifyCliToken: vi.fn() }));
vi.mock("@/lib/runners/auth", () => ({ verifyRunnerToken: vi.fn() }));
// Partial: the jobs route signs the snapshot it inserts through this module (lib/db/signed-job.ts);
// only the claim-side check is stubbed.
vi.mock("@/lib/runners/snapshot-sig", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/runners/snapshot-sig")>()),
	verifySnapshot: () => true,
}));
vi.mock("@/lib/auth/scope", () => ({ getActiveScope: vi.fn() }));
vi.mock("@/lib/authz/guard", () => ({
	authorize: vi.fn(),
	authorizeCli: vi.fn(),
	ensureCliOrgAccess: vi.fn(),
	assertMintingProfileStillMember: vi.fn(),
}));
vi.mock("@/lib/authz", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/authz")>()),
	getPdp: () => ({ can: async () => ({ allowed: true }) }),
}));
vi.mock("@/app/server/actions/projects", () => ({
	planProject: vi.fn(),
	provisionProject: vi.fn(),
	destroyProject: vi.fn(),
}));
vi.mock("@/lib/scaler", () => ({ notifyScaler: vi.fn() }));

import { POST as cliProjectsPost } from "@/app/api/cli/projects/route";
import { POST as claimPost } from "@/app/api/jobs/claim/route";
import { POST as jobsPost } from "@/app/api/jobs/route";
import { getActiveScope } from "@/lib/auth/scope";
import { authorizeCli, ensureCliOrgAccess } from "@/lib/authz/guard";
import { verifyCliToken } from "@/lib/cli/auth";
import { getServiceDb } from "@/lib/db";
import {
	cloudIdentities,
	jobs,
	projectEnvironments,
	projectFabrics,
	projects,
	resourceHierarchy,
	runners,
} from "@/lib/db/schema";
import { verifyRunnerToken } from "@/lib/runners/auth";

/** The job creator, acting in ORG_A. */
const USER_A = randomUUID();
/** A member of ORG_B only. */
const USER_B = randomUUID();
const ORG_A = randomUUID();
const ORG_B = randomUUID();
const TOKEN_HASH = `hash-it-5479-${USER_A}`;
const FOREIGN_CANARY = "arn:aws:iam::000000000000:role/CANARY-5479-foreign";

let runnerId: string;
/** `org` scope, in ORG_A, authored by someone else: the org's shared credential. */
let ownOrgIdentity: string;
/** `org` scope, in ORG_B: another tenant's credential. */
let foreignIdentity: string;
/** `personal` scope, authored by USER_A, created in USER_A's personal org. */
let creatorPersonalIdentity: string;
/** `org` scope in ORG_B, authored by USER_A: an org USER_A no longer acts in. */
let creatorForeignOrgIdentity: string;

/** Inserts one identity and returns its id. */
async function seedIdentity(v: {
	user_id: string;
	org_id: string;
	scope: "personal" | "org";
	role_arn: string;
}): Promise<string> {
	const [row] = await getServiceDb()
		.insert(cloudIdentities)
		.values({
			user_id: v.user_id,
			org_id: v.org_id,
			scope: v.scope,
			provider: "aws",
			name: `it-5479-${randomUUID().slice(0, 8)}`,
			credentials: { role_arn: v.role_arn },
		})
		.returning({ id: cloudIdentities.id });
	return row.id;
}

/** Queues a DESTROY_RUNNER job in ORG_A for the runner, naming `identityId`, and returns its id. */
async function seedJob(identityId: string): Promise<string> {
	const [row] = await getServiceDb()
		.insert(jobs)
		.values({
			user_id: USER_A,
			org_id: ORG_A,
			job_type: "DESTROY_RUNNER",
			status: "QUEUED",
			config_snapshot: {},
			cloud_identity_id: identityId,
			assigned_runner_id: runnerId,
		})
		.returning({ id: jobs.id });
	return row.id;
}

/** The slice of the claim response this suite reads. */
const claimBody = z.object({
	job: z.object({ id: z.string() }).nullable(),
	cloud_identity: z.object({ role_arn: z.string() }).nullable().optional(),
});

/** Claims as the seeded runner and returns the parsed body plus its raw text. */
async function claim() {
	const res = await claimPost(
		new Request("https://console.local/api/jobs/claim", { method: "POST" }),
	);
	expect(res.status).toBe(200);
	const text = await res.text();
	return { body: claimBody.parse(JSON.parse(text)), text };
}

describeIfDb("cloud identity tenancy (#5479)", () => {
	beforeAll(async () => {
		const db = getServiceDb();
		const [runner] = await db
			.insert(runners)
			.values({
				user_id: USER_A,
				org_id: ORG_A,
				name: `it-5479-${USER_A.slice(0, 8)}`,
				operator: "self",
				provisioning: "registered",
				token_hash: TOKEN_HASH,
				status: "OFFLINE",
			})
			.returning({ id: runners.id });
		runnerId = runner.id;

		ownOrgIdentity = await seedIdentity({
			user_id: USER_B,
			org_id: ORG_A,
			scope: "org",
			role_arn: "arn:aws:iam::111111111111:role/own-org",
		});
		foreignIdentity = await seedIdentity({
			user_id: USER_B,
			org_id: ORG_B,
			scope: "org",
			role_arn: FOREIGN_CANARY,
		});
		creatorPersonalIdentity = await seedIdentity({
			user_id: USER_A,
			org_id: USER_A,
			scope: "personal",
			role_arn: "arn:aws:iam::222222222222:role/creator-personal",
		});
		creatorForeignOrgIdentity = await seedIdentity({
			user_id: USER_A,
			org_id: ORG_B,
			scope: "org",
			role_arn: FOREIGN_CANARY,
		});
	});

	afterAll(async () => {
		const db = getServiceDb();
		// Projects first: they reference the identities.
		const created = await db
			.select({ id: projects.id })
			.from(projects)
			.where(eq(projects.org_id, ORG_A));
		const ids = created.map((p) => p.id);
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
		await db.delete(jobs).where(eq(jobs.user_id, USER_A));
		await db.delete(runners).where(eq(runners.id, runnerId));
		await db
			.delete(cloudIdentities)
			.where(
				inArray(cloudIdentities.id, [
					ownOrgIdentity,
					foreignIdentity,
					creatorPersonalIdentity,
					creatorForeignOrgIdentity,
				]),
			);
	});

	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(verifyRunnerToken).mockResolvedValue({
			runnerId,
			tokenHash: TOKEN_HASH,
			operator: "self",
			error: null,
		});
		vi.mocked(verifyCliToken).mockResolvedValue({
			payload: { sub: USER_A },
			error: null,
		});
		vi.mocked(getActiveScope).mockResolvedValue({
			userId: USER_A,
			orgId: ORG_A,
		});
		vi.mocked(ensureCliOrgAccess).mockResolvedValue(null);
		vi.mocked(authorizeCli).mockResolvedValue({
			actor: { userId: USER_A, orgId: ORG_A },
			credential: "session",
			orgScope: [ORG_A],
		});
	});

	// ── 1. The claim route ─────────────────────────────────────────────────────────────────────
	it("hands a job no credentials when its row names ANOTHER org's identity", async () => {
		const jobId = await seedJob(foreignIdentity);

		const { body, text } = await claim();

		expect(body.job?.id).toBe(jobId);
		expect(body.cloud_identity ?? null).toBeNull();
		expect(text).not.toContain(FOREIGN_CANARY);
	});

	it("does not admit an org-scope identity in another org by authorship alone", async () => {
		const jobId = await seedJob(creatorForeignOrgIdentity);

		const { body, text } = await claim();

		expect(body.job?.id).toBe(jobId);
		expect(body.cloud_identity ?? null).toBeNull();
		expect(text).not.toContain(FOREIGN_CANARY);
	});

	it("still hands the job its own org's identity", async () => {
		const jobId = await seedJob(ownOrgIdentity);

		const { body } = await claim();

		expect(body.job?.id).toBe(jobId);
		expect(body.cloud_identity?.role_arn).toBe("arn:aws:iam::111111111111:role/own-org");
	});

	it("still hands the job its creator's personal identity from their personal org", async () => {
		const jobId = await seedJob(creatorPersonalIdentity);

		const { body } = await claim();

		expect(body.job?.id).toBe(jobId);
		expect(body.cloud_identity?.role_arn).toBe(
			"arn:aws:iam::222222222222:role/creator-personal",
		);
	});

	// ── 2. The enqueue: POST /api/jobs DESTROY_RUNNER ──────────────────────────────────────────
	it("404s a DESTROY_RUNNER that names another org's identity, and writes no job", async () => {
		const before = await getServiceDb()
			.select({ id: jobs.id })
			.from(jobs)
			.where(eq(jobs.cloud_identity_id, foreignIdentity));

		const res = await jobsPost(
			new Request("https://console.local/api/jobs", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					job_type: "DESTROY_RUNNER",
					cloud_identity_id: foreignIdentity,
					config_snapshot: { runner_name: "teardown" },
				}),
			}),
		);

		expect(res.status).toBe(404);
		const after = await getServiceDb()
			.select({ id: jobs.id })
			.from(jobs)
			.where(eq(jobs.cloud_identity_id, foreignIdentity));
		expect(after).toHaveLength(before.length);
	});

	it("queues a DESTROY_RUNNER that names the actor's own org's identity", async () => {
		const res = await jobsPost(
			new Request("https://console.local/api/jobs", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					job_type: "DESTROY_RUNNER",
					cloud_identity_id: ownOrgIdentity,
					config_snapshot: { runner_name: "teardown" },
				}),
			}),
		);

		// The body rides along so a failure names its cause instead of a bare status.
		expect({ status: res.status, body: await res.text() }).toMatchObject({ status: 201 });
	});

	// ── 3. The project binding: POST /api/cli/projects ─────────────────────────────────────────
	it("refuses to create a project bound to another org's identity", async () => {
		const name = `it-5479-foreign-${randomUUID().slice(0, 8)}`;
		const res = await cliProjectsPost(
			new Request("https://console.local/api/cli/projects", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					project_name: name,
					region: "us-east-1",
					cloud_identity_id: foreignIdentity,
				}),
			}),
		);

		expect(res.status).toBe(400);
		const rows = await getServiceDb()
			.select({ id: projects.id })
			.from(projects)
			.where(and(eq(projects.org_id, ORG_A), eq(projects.project_name, name)));
		expect(rows).toHaveLength(0);
	});

	it("creates a project bound to the actor's own org's identity", async () => {
		const res = await cliProjectsPost(
			new Request("https://console.local/api/cli/projects", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					project_name: `it-5479-own-${randomUUID().slice(0, 8)}`,
					region: "us-east-1",
					cloud_identity_id: ownOrgIdentity,
				}),
			}),
		);

		expect(res.status).toBe(201);
	});
});
