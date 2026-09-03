// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Integration: the org stamp the two CLI enqueue paths write, against real Postgres (#3874).
//
// WHY THIS IS AN INTEGRATION TEST AND NOT A MOCK. The defect being fixed is a DATABASE
// TRIGGER falling through. `set_org_id` / `set_org_id_from_project` resolve org_id in three
// steps — the parent project's org, the `app.current_org` GUC, then `NEW.user_id` — and both
// of these routes insert on `getServiceDb()`, whose role bypasses RLS and sets no GUC, on rows
// with no project. So both landed on the third branch and stamped the caller's PERSONAL org.
// A mock db proves what the route passed; only a real insert proves what the row ENDS UP
// holding, which is the thing `claim_next_job` reads. Every fixture here therefore LETS THE
// TRIGGER STAMP THE ROW and then asserts the stamp — a hand-written org_id would only prove a
// test can type a uuid twice.
//
// THE ASSERTION THE WHOLE DESIGN EXISTS TO PROTECT is the first one below. `claim_next_job`
// requires `j.org_id = v_runner_org_id` for a self runner — a hard equality, in both the
// assigned phase (programmables.sql:225) and the unassigned one (:306). #3874 stamps FORWARD
// ONLY: the maintainer's ruling refuses a backfill, so runner rows written before it keep
// `org_id = user_id`. Stamping a new DESTROY_RUNNER job with `actor.orgId` — the obvious
// reading — would therefore hand a team-org job to a personal-org runner, the equality would
// fail, and the job would sit QUEUED FOREVER: strictly worse than the defect. So the job's org
// follows the RUNNER that will execute it, and this file drives that against the real
// equality rather than against a promise.
//
// #4022 EXTENDED THAT RULE TO THE CASE WITH NO RUNNER TO FOLLOW. The unassigned enqueue was
// stamped `actor.orgId` on the reading that Phase B is the org-agnostic phase. Only its MANAGED
// arm is; the `ELSE` arm a self runner takes repeats Phase A's equality verbatim, so a Teams
// member whose fleet is entirely pre-#3874 got exactly the QUEUED-forever job the paragraph above
// exists to prevent. The org is now resolved from the fleet that would have to claim it, and cases
// 2b and 2c are the two fleets that resolve differently — which is why 2c seeds its own caller
// rather than reusing the shared one, whose fleet deliberately holds both vintages.
//
// 2c also depends on a property of the WHOLE runners table rather than of its own caller: the
// resolver moves a stamp only when the MANAGED pool cannot claim the old one either, because that
// arm has no org predicate at all. A managed row left behind by another file would make 2c measure
// the opposite arm and pass for the wrong reason, so 2c asserts the pool is empty before it reads
// the answer. The arm itself — the same fleet resolving the other way once a managed runner exists
// — is pinned in `runner-org-validate.test.ts`, which can empty the pool inside a rolled-back
// transaction because it calls the resolver directly rather than through the route.
//
// The PDP and the CLI token are stubbed (they are proven in the authz suite); the database is
// not, and it is the subject.

import { randomUUID } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { describeIfDb } from "./db";

vi.mock("@/lib/cli/auth", () => ({ verifyCliToken: vi.fn() }));
vi.mock("@/lib/auth/scope", () => ({ getActiveScope: vi.fn() }));
vi.mock("@/lib/authz/guard", () => ({
	authorize: vi.fn(),
	authorizeCli: vi.fn(),
	ensureCliOrgAccess: vi.fn(),
}));
// DESTROY_RUNNER / DEPLOY_RUNNER never reach the project actions, and importing them for real
// drags the whole server-action graph (next/cache, the PDP, the billing guards) into a suite
// whose subject is two INSERTs.
vi.mock("@/app/server/actions/projects", () => ({
	planProject: vi.fn(),
	provisionProject: vi.fn(),
	destroyProject: vi.fn(),
}));
vi.mock("@/lib/scaler", () => ({ notifyScaler: vi.fn() }));

import { POST as deployRunnerPost } from "@/app/api/cli/runners/deploy/route";
import { POST as jobsPost } from "@/app/api/jobs/route";
import { getActiveScope } from "@/lib/auth/scope";
import { authorizeCli, ensureCliOrgAccess } from "@/lib/authz/guard";
import { verifyCliToken } from "@/lib/cli/auth";
import { getServiceDb } from "@/lib/db";
import { cloudIdentities, jobs, runners } from "@/lib/db/schema";

/**
 * A user who belongs to two orgs: their personal one (their own id — the community model's
 * `org_id = user_id`) and a Teams org they are acting in. That pair is the entire subject:
 * the defect stamped the first where the second was meant, and the no-backfill ruling means
 * both now exist in the same table at the same time.
 */
const USER = randomUUID();
const TEAM_ORG = randomUUID();

/** A runner stamped by the TRIGGER — i.e. `org_id = user_id`, every pre-#3874 CLI deploy. */
let legacyRunner: string;
/** A runner stamped EXPLICITLY with the team org — what #3874 writes from now on. */
let modernRunner: string;
let identityId: string;

/**
 * Seeds a self-operated runner and returns its id, asserting the org it ENDED UP with.
 *
 * `orgId` omitted reproduces the pre-#3874 mechanism rather than its output: the row goes in
 * with `org_id` NULL and the `set_org_id` trigger's last branch stamps `user_id`. `expectOrg`
 * is the fixture's own premise, asserted here (inside a function, so the standalone-expect
 * rule is satisfied) because a "legacy" row that is not actually personal-org stamped would
 * make the regression test below test nothing.
 */
async function seedRunner(expectOrg: string, orgId?: string): Promise<string> {
	const name = `it-3874-${randomUUID().slice(0, 12)}`;
	const [row] = await getServiceDb()
		.insert(runners)
		.values({
			user_id: USER,
			...(orgId ? { org_id: orgId } : {}),
			name,
			operator: "self", // self ⇒ user_id NOT NULL + provisioning NOT NULL (CHECKs)
			provisioning: "deployed",
			token_hash: `hash-${name}`,
			status: "OFFLINE",
		})
		.returning({ id: runners.id, org_id: runners.org_id });
	expect(row.org_id).toBe(expectOrg);
	return row.id;
}

/** Reads back the org a row actually holds — the value claim_next_job compares. */
async function jobOrg(jobId: string): Promise<string | null> {
	const [row] = await getServiceDb()
		.select({ org_id: jobs.org_id })
		.from(jobs)
		.where(eq(jobs.id, jobId))
		.limit(1);
	return row.org_id;
}

/** Posts a DESTROY_RUNNER enqueue as USER acting in TEAM_ORG, and returns the created job id. */
async function destroyRunnerJob(assignedRunnerId: string | null): Promise<Response> {
	return jobsPost(
		new Request("https://console.local/api/jobs", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				job_type: "DESTROY_RUNNER",
				cloud_identity_id: identityId,
				config_snapshot: { runner_name: "teardown" },
				...(assignedRunnerId ? { assigned_runner_id: assignedRunnerId } : {}),
			}),
		}),
	);
}

/** The slice of the 201 body this suite reads — narrowed by parse, never by a cast. */
const createdJobSchema = z.object({ job: z.object({ id: z.uuid() }) });

/** Pulls the created job's id out of a 201 body. */
async function createdJobId(res: Response): Promise<string> {
	expect(res.status).toBe(201);
	return createdJobSchema.parse(await res.json()).job.id;
}

describeIfDb("CLI enqueue org stamp (#3874)", () => {
	beforeAll(async () => {
		const db = getServiceDb();
		const [identity] = await db
			.insert(cloudIdentities)
			.values({
				user_id: USER,
				org_id: TEAM_ORG,
				provider: "aws",
				name: `it-3874-identity-${TEAM_ORG.slice(0, 8)}`,
			})
			.returning({ id: cloudIdentities.id });
		identityId = identity.id;

		// The trigger stamps user_id when org_id is left NULL — the pre-#3874 shape.
		legacyRunner = await seedRunner(USER);
		// And it does NOT overwrite an explicit stamp (`IF NEW.org_id IS NULL`), which is what
		// makes the deploy route's forward fix possible at all.
		modernRunner = await seedRunner(TEAM_ORG, TEAM_ORG);
	});

	afterAll(async () => {
		const db = getServiceDb();
		await db.delete(jobs).where(eq(jobs.user_id, USER));
		await db.delete(runners).where(eq(runners.user_id, USER));
		await db.delete(cloudIdentities).where(eq(cloudIdentities.id, identityId));
	});

	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(verifyCliToken).mockResolvedValue({
			payload: { sub: USER },
			error: null,
		} as never);
		// The caller's ACTIVE org is the team org — the org the defect's "obvious fix" would
		// have stamped, and the one every assertion below is written to distinguish from.
		vi.mocked(getActiveScope).mockResolvedValue({
			userId: USER,
			orgId: TEAM_ORG,
		} as never);
		vi.mocked(ensureCliOrgAccess).mockResolvedValue(null);
		vi.mocked(authorizeCli).mockResolvedValue({
			actor: { userId: USER, orgId: TEAM_ORG },
		} as never);
	});

	// ── 1. THE REGRESSION THE NO-BACKFILL DESIGN EXISTS TO AVOID ────────────────────────────
	it("DESTROY_RUNNER for a PERSONAL-org runner takes the RUNNER's org, not the actor's — the runner stays claimable", async () => {
		const jobId = await createdJobId(await destroyRunnerJob(legacyRunner));

		const [runnerRow] = await getServiceDb()
			.select({ org_id: runners.org_id })
			.from(runners)
			.where(eq(runners.id, legacyRunner))
			.limit(1);

		// Stated three ways on purpose. The first is the claim; the second is the WRONG answer
		// named explicitly, so a stamp that happened to equal both cannot pass; the third is
		// the predicate claim_next_job actually evaluates.
		expect(await jobOrg(jobId)).toBe(USER);
		expect(await jobOrg(jobId)).not.toBe(TEAM_ORG);
		expect(await jobOrg(jobId)).toBe(runnerRow.org_id);

		// And the equality itself, evaluated BY POSTGRES rather than by JavaScript — the exact
		// join `claim_next_job` Phase A performs (`j.assigned_runner_id = p_runner_id AND
		// j.org_id = v_runner_org_id`). A row here means a self runner would claim this job; no
		// row means it sits QUEUED forever, which is the failure mode this issue is about.
		const claimable = await getServiceDb().execute(sql`
			select j.id from jobs j
			  join runners r on r.id = j.assigned_runner_id
			 where j.id = ${jobId}::uuid
			   and j.status = 'QUEUED'
			   and j.org_id = r.org_id
		`);
		expect(Array.from(claimable)).toHaveLength(1);
	});

	// ── 2. The forward case: a runner already in the actor's org ────────────────────────────
	it("DESTROY_RUNNER for a runner in the ACTOR's org gets the actor's org", async () => {
		const jobId = await createdJobId(await destroyRunnerJob(modernRunner));

		expect(await jobOrg(jobId)).toBe(TEAM_ORG);
		expect(await jobOrg(jobId)).not.toBe(USER);

		const claimable = await getServiceDb().execute(sql`
			select j.id from jobs j
			  join runners r on r.id = j.assigned_runner_id
			 where j.id = ${jobId}::uuid and j.org_id = r.org_id
		`);
		expect(Array.from(claimable)).toHaveLength(1);
	});

	// ── 2b. No runner named, MIXED fleet: the actor's org — and it is claimable ─────────────
	//
	// This assertion's VALUE survived #4022 and its reasoning did not, so both are restated.
	// It was written as "falls back to the ACTOR's org, not the personal org", on the ground
	// that the personal org was what the trigger chose and the trigger was the defect. That
	// half is still right: the stamp is explicit, so a GUC-less service connection no longer
	// picks the tenancy. What it did NOT establish — and what #4022 found — is that the actor's
	// org is the right VALUE whatever the fleet looks like. Nothing about the unassigned path
	// is org-agnostic: `claim_next_job` Phase B's self arm repeats Phase A's equality, so the
	// stamp is only correct here because THIS fixture's fleet contains `modernRunner`, a self
	// runner already in TEAM_ORG. Case 2c is the same enqueue against a fleet that has none,
	// where the old reasoning produced a job nothing could ever claim.
	//
	// So the claimability is now asserted rather than assumed, by the same Phase B predicate
	// Postgres evaluates — the thing the original assertion left to inference.
	it("DESTROY_RUNNER with no assigned runner takes the ACTOR's org when a runner of that org exists", async () => {
		const jobId = await createdJobId(await destroyRunnerJob(null));
		expect(await jobOrg(jobId)).toBe(TEAM_ORG);
		expect(await jobOrg(jobId)).not.toBe(USER);

		// `claim_next_job` Phase B, ELSE arm: an UNASSIGNED job is offered to a self runner only
		// where `j.org_id = v_runner_org_id`. A row means modernRunner would claim it.
		const claimable = await getServiceDb().execute(sql`
			select j.id from jobs j
			  join runners r on r.org_id = j.org_id
			 where j.id = ${jobId}::uuid
			   and j.status = 'QUEUED'
			   and j.assigned_runner_id is null
			   and r.id = ${modernRunner}::uuid
			   and r.operator = 'self'
		`);
		expect(Array.from(claimable)).toHaveLength(1);
	});

	// ── 2c. #4022: no runner named, LEGACY-ONLY fleet ───────────────────────────────────────
	//
	// The failing input from #4022, and the one case 2b's fixture cannot express: a Teams
	// member whose runners are ALL pre-#3874, so every one carries `org_id = user_id`. A
	// TEAM_ORG stamp is unclaimable by every runner they have — QUEUED forever, no error.
	// Because the fleet is the subject, this case needs its own caller with its own fleet;
	// the shared USER's fleet deliberately contains both vintages.
	it("DESTROY_RUNNER with no assigned runner takes the PERSONAL org when the whole fleet is pre-#3874", async () => {
		const legacyUser = randomUUID();
		const legacyUserOrg = randomUUID();
		const [row] = await getServiceDb()
			.insert(runners)
			.values({
				user_id: legacyUser,
				name: `it-4022-${randomUUID().slice(0, 12)}`,
				operator: "self",
				provisioning: "deployed",
				token_hash: `hash-4022-${legacyUser}`,
				status: "OFFLINE",
			})
			.returning({ id: runners.id, org_id: runners.org_id });
		// The fixture's own premise: the trigger stamped the personal org, as it did for every
		// runner the CLI deployed before #3874.
		expect(row.org_id).toBe(legacyUser);

		// The SECOND premise, and the one that is not local to this test. `claim_next_job` Phase
		// B's managed arm ignores org entirely, so a managed runner would claim the team-org stamp
		// and the resolver would correctly leave it alone — this case would then assert the wrong
		// arm and pass. Stated as an assertion rather than an assumption, because a leaked managed
		// row from another integration file is invisible from here.
		const managedPool = await getServiceDb()
			.select({ id: runners.id })
			.from(runners)
			.where(eq(runners.operator, "managed"))
			.limit(1);
		expect(managedPool).toHaveLength(0);

		vi.mocked(verifyCliToken).mockResolvedValue({
			payload: { sub: legacyUser },
			error: null,
		} as never);
		vi.mocked(getActiveScope).mockResolvedValue({
			userId: legacyUser,
			orgId: legacyUserOrg,
		} as never);

		const jobId = await createdJobId(await destroyRunnerJob(null));

		// Stated three ways, as case 1 is: the claim, the wrong answer named explicitly (the
		// value this route stamped before #4022), and the predicate Postgres evaluates.
		expect(await jobOrg(jobId)).toBe(legacyUser);
		expect(await jobOrg(jobId)).not.toBe(legacyUserOrg);

		const claimable = await getServiceDb().execute(sql`
			select j.id from jobs j
			  join runners r on r.org_id = j.org_id
			 where j.id = ${jobId}::uuid
			   and j.status = 'QUEUED'
			   and j.assigned_runner_id is null
			   and r.id = ${row.id}::uuid
			   and r.operator = 'self'
		`);
		expect(Array.from(claimable)).toHaveLength(1);

		await getServiceDb().delete(jobs).where(eq(jobs.user_id, legacyUser));
		await getServiceDb().delete(runners).where(eq(runners.user_id, legacyUser));
	});

	// ── 3. DEPLOY_RUNNER on THIS fleet stamps the pair identically ──────────────────────────
	//
	// The heading used to read "by construction", and #4022 narrowed that. The two stamps are no
	// longer written from one value: the runners row takes the actor's org because that is the
	// forward-correct tenancy for a runner being created, while the job takes the org of the fleet
	// that must CLAIM it — and on the unassigned path those are resolved separately. They agree
	// here because this fixture's fleet contains `modernRunner`, a self runner already in
	// TEAM_ORG, which is the ordinary case. On a legacy-only fleet with no managed pool they would
	// legitimately diverge, and that is sound: `claim_next_job` compares the job against the org
	// of the runner that claims it, and the row this request creates cannot claim its own deploy
	// job — it does not exist yet. So this assertion keeps its value and loses its universality.
	it("DEPLOY_RUNNER stamps the runners row and the jobs row with the SAME org", async () => {
		const res = await deployRunnerPost(
			new Request("https://console.local/api/cli/runners/deploy", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					name: `it-3874-deployed-${randomUUID().slice(0, 8)}`,
					cloud_identity_id: identityId,
					region: "us-east-1",
				}),
			}),
		);
		expect(res.status).toBe(201);

		// Read both rows back from the database rather than from the response: the response
		// carries neither org, and the whole defect was about what the row ended up holding.
		const [job] = await getServiceDb()
			.select({ id: jobs.id, org_id: jobs.org_id, snapshot: jobs.config_snapshot })
			.from(jobs)
			.where(and(eq(jobs.user_id, USER), eq(jobs.job_type, "DEPLOY_RUNNER")))
			.orderBy(desc(jobs.created_at))
			.limit(1);
		// The new runner's id is only in the snapshot (the response returns it, but reading it
		// from the row is what proves the two rows the ROUTE wrote refer to each other).
		const newRunnerId = z.uuid().parse(job.snapshot.runner_id);

		const [runnerRow] = await getServiceDb()
			.select({ org_id: runners.org_id })
			.from(runners)
			.where(eq(runners.id, newRunnerId))
			.limit(1);

		expect(runnerRow.org_id).toBe(TEAM_ORG);
		expect(job.org_id).toBe(TEAM_ORG);
		// The pair, stated as a pair: they match because this caller's fleet can claim their
		// active org, not because both fell through the same trigger branch in the same wrong
		// direction — and not, since #4022, because one value was written to both.
		expect(job.org_id).toBe(runnerRow.org_id);
		// Neither is the personal org the trigger would have chosen.
		expect(job.org_id).not.toBe(USER);
		expect(runnerRow.org_id).not.toBe(USER);
	});
});
