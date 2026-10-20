// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Integration: runner-lifecycle jobs hand the runner token off at claim, and job snapshots carry no
// secrets — against real Postgres, the real claim_next_job and the real runner authentication.
//
//   1. ENQUEUE STORES NO TOKEN. A DEPLOY_RUNNER queued through POST /api/cli/runners/deploy writes a
//      snapshot without `runner_token`, and the new runner row cannot authenticate before the claim.
//   2. THE CLAIM HANDS IT OFF. The executing runner's claim answers a snapshot carrying the token; the
//      target row's `token_hash` is its hash, so the deployed container authenticates with it — and
//      the stored snapshot still does not carry it.
//   2b. THE ISSUE IS GUARDED. A target that is another org's runner, a managed runner, a registered
//      (not console-deployed) runner, or the job creator's runner in a DIFFERENT org that is not the
//      pre-#3874 personal-org shape is refused: the job fails, and the target's hash is untouched.
//      The personal-org shape itself is admitted.
//   3. EVERY READ PATH REDACTS. A row that does carry secret keys (written by an earlier build) is
//      returned without them by getJob, getJobs, getJobsPage, GET /api/cli/jobs/:id and GET /api/jobs.
//   4. THE SCRUB. The statement programmables.sql runs on every migrate, taken from the file itself,
//      removes the key from settled rows (clearing their signature), leaves in-flight rows as
//      enqueued, and is idempotent.
//
// The CLI and console guards are stubbed (they are the authz suites' subject); the quota and the
// runner credentials are real.

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { describeIfDb } from "./db";

vi.mock("@/lib/cli/auth", () => ({ verifyCliToken: vi.fn() }));
vi.mock("@/lib/auth/scope", () => ({ getActiveScope: vi.fn() }));
vi.mock("@/lib/authz/guard", async (importOriginal) => ({
	// Real: the runner-deploy route asks it which identity arm the credential gets.
	userIdIsTheCaller: (await importOriginal<typeof import("@/lib/authz/guard")>())
		.userIdIsTheCaller,
	authorize: vi.fn(),
	authorizeCli: vi.fn(),
	ensureCliOrgAccess: vi.fn(),
}));
vi.mock("@/app/server/actions/projects", () => ({
	planProject: vi.fn(),
	provisionProject: vi.fn(),
	destroyProject: vi.fn(),
}));
vi.mock("@/lib/scaler", () => ({ notifyScaler: vi.fn() }));

import { POST as claimPost } from "@/app/api/jobs/claim/route";
import { GET as cliJobGet } from "@/app/api/cli/jobs/[id]/route";
import { POST as deployRunnerPost } from "@/app/api/cli/runners/deploy/route";
import { GET as jobsListGet } from "@/app/api/jobs/route";
import { getJob, getJobs, getJobsPage } from "@/app/server/actions/jobs";
import { getActiveScope } from "@/lib/auth/scope";
import { authorize, authorizeCli, ensureCliOrgAccess } from "@/lib/authz/guard";
import { verifyCliToken } from "@/lib/cli/auth";
import { getServiceDb } from "@/lib/db";
import { cloudIdentities, jobs, runners } from "@/lib/db/schema";
import { hashRunnerToken, verifyRunnerToken } from "@/lib/runners/auth";

const USER = randomUUID();
const ORG = randomUUID();
/** Another tenant: neither the job's org nor anyone's personal org. */
const ORG_B = randomUUID();
const OTHER_USER = randomUUID();
const EXECUTOR_TOKEN = `it-handoff-exec-${randomUUID()}`;
/** A value unlikely to occur by accident: a surviving occurrence is a missed key. */
const SENTINEL = `SENTINEL-${randomUUID()}`;

let identityId = "";
let executorId = "";
let legacyJobId = "";
/** Runner rows this file created without USER as owner, for cleanup. */
const extraRunnerIds: string[] = [];

const deployedSchema = z.object({
	runner: z.object({ id: z.uuid() }),
	job: z.object({ id: z.uuid() }),
});
const claimSchema = z.object({
	job: z.object({ id: z.uuid(), config_snapshot: z.record(z.string(), z.unknown()) }),
});

/** Reads one job's stored snapshot and signature. */
async function storedJob(id: string) {
	const [row] = await getServiceDb()
		.select({ config_snapshot: jobs.config_snapshot, sig: jobs.config_snapshot_sig })
		.from(jobs)
		.where(eq(jobs.id, id))
		.limit(1);
	return row;
}

/** Reads one runner's stored token hash. */
async function storedHash(id: string): Promise<string> {
	const [row] = await getServiceDb()
		.select({ token_hash: runners.token_hash })
		.from(runners)
		.where(eq(runners.id, id))
		.limit(1);
	return row.token_hash;
}

/** True when `token` authenticates as runner `id` through the console's real check. */
async function authenticates(id: string, token: string): Promise<boolean> {
	const res = await verifyRunnerToken(
		new Request("https://console.local/x", {
			headers: { "X-Runner-ID": id, "X-Runner-Token": token },
		}),
	);
	return res.error === null;
}

/** Queues a DEPLOY_RUNNER through the CLI route, assigned to the executor. */
async function deploy(): Promise<{ runnerId: string; jobId: string; text: string }> {
	const res = await deployRunnerPost(
		new Request("https://console.local/api/cli/runners/deploy", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				name: `it-handoff-${randomUUID().slice(0, 12)}`,
				cloud_identity_id: identityId,
				region: "us-east-1",
				assigned_runner_id: executorId,
			}),
		}),
	);
	const text = await res.text();
	expect(res.status).toBe(201);
	const body = deployedSchema.parse(JSON.parse(text));
	return { runnerId: body.runner.id, jobId: body.job.id, text };
}

describeIfDb("runner-lifecycle token handoff + job snapshot redaction", () => {
	beforeAll(async () => {
		const db = getServiceDb();
		const [identity] = await db
			.insert(cloudIdentities)
			.values({
				user_id: USER,
				org_id: ORG,
				provider: "aws",
				name: `it-handoff-identity-${ORG.slice(0, 8)}`,
			})
			.returning({ id: cloudIdentities.id });
		identityId = identity.id;

		const [executor] = await db
			.insert(runners)
			.values({
				user_id: USER,
				org_id: ORG,
				name: `it-handoff-exec-${ORG.slice(0, 8)}`,
				operator: "self",
				provisioning: "registered",
				token_hash: hashRunnerToken(EXECUTOR_TOKEN),
				status: "ONLINE",
			})
			.returning({ id: runners.id });
		executorId = executor.id;

		// A settled lifecycle row whose snapshot carries secret keys, as an earlier build wrote.
		const [legacy] = await db
			.insert(jobs)
			.values({
				user_id: USER,
				org_id: ORG,
				job_type: "DEPLOY_RUNNER",
				status: "SUCCESS",
				config_snapshot: {
					runner_id: randomUUID(),
					runner_name: "legacy",
					runner_token: SENTINEL,
					nested: { password: SENTINEL },
				},
			})
			.returning({ id: jobs.id });
		legacyJobId = legacy.id;
	});

	afterAll(async () => {
		const db = getServiceDb();
		await db.delete(jobs).where(eq(jobs.user_id, USER));
		await db.delete(runners).where(eq(runners.user_id, USER));
		if (extraRunnerIds.length > 0) await db.delete(runners).where(inArray(runners.id, extraRunnerIds));
		await db.delete(cloudIdentities).where(eq(cloudIdentities.id, identityId));
	});

	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(verifyCliToken).mockResolvedValue({ payload: { sub: USER }, error: null } as never);
		vi.mocked(getActiveScope).mockResolvedValue({ userId: USER, orgId: ORG } as never);
		vi.mocked(ensureCliOrgAccess).mockResolvedValue(null);
		vi.mocked(authorize).mockResolvedValue({ userId: USER, orgId: ORG } as never);
		vi.mocked(authorizeCli).mockResolvedValue({
			actor: { userId: USER, orgId: ORG },
			credential: "session",
			orgScope: [ORG, USER],
		} as never);
	});

	// ── 1 + 2. Enqueue stores nothing; the claim hands the token off ───────────────────────────
	it("queues a DEPLOY_RUNNER with no token, then the claim hands the target its working token", async () => {
		const { runnerId, jobId, text } = await deploy();

		const enqueued = await storedJob(jobId);
		expect(enqueued.config_snapshot).not.toHaveProperty("runner_token");
		expect(enqueued.config_snapshot).toMatchObject({ runner_id: runnerId, region: "us-east-1" });
		expect(text).not.toMatch(/[0-9a-f]{64}/);
		const unheldHash = await storedHash(runnerId);

		const res = await claimPost(
			new Request("https://console.local/api/jobs/claim", {
				method: "POST",
				headers: { "X-Runner-ID": executorId, "X-Runner-Token": EXECUTOR_TOKEN },
			}),
		);
		expect(res.status).toBe(200);
		const claimed = claimSchema.parse(await res.json()).job;
		expect(claimed.id).toBe(jobId);
		const token = z.string().regex(/^[0-9a-f]{64}$/).parse(claimed.config_snapshot.runner_token);

		// The target row now holds this token's hash, so the container it deploys authenticates.
		expect(await storedHash(runnerId)).toBe(hashRunnerToken(token));
		expect(await storedHash(runnerId)).not.toBe(unheldHash);
		expect(await authenticates(runnerId, token)).toBe(true);

		// And the stored row still carries no token, after the claim as before it.
		const after = await storedJob(jobId);
		expect(after.config_snapshot).not.toHaveProperty("runner_token");
		expect(JSON.stringify(after.config_snapshot)).not.toContain(token);
	});

	// ── 2b. The issue is guarded ──────────────────────────────────────────────────────────────
	/** Seeds a target runner row; `orgId` omitted lets the trigger stamp `org_id = user_id`. */
	async function seedTarget(values: {
		userId: string | null;
		orgId?: string;
		operator: "self" | "managed";
		provisioning: "deployed" | "registered" | null;
	}): Promise<{ id: string; org_id: string | null; token_hash: string }> {
		const [row] = await getServiceDb()
			.insert(runners)
			.values({
				user_id: values.userId,
				...(values.orgId ? { org_id: values.orgId } : {}),
				name: `it-handoff-target-${randomUUID().slice(0, 12)}`,
				operator: values.operator,
				provisioning: values.provisioning,
				token_hash: hashRunnerToken(`unheld-${randomUUID()}`),
				status: "OFFLINE",
			})
			.returning({ id: runners.id, org_id: runners.org_id, token_hash: runners.token_hash });
		if (values.userId !== USER) extraRunnerIds.push(row.id);
		return row;
	}

	/** Queues a DEPLOY_RUNNER for `targetId` in ORG, assigned to the executor, and claims it. */
	async function claimFor(targetId: string) {
		const [job] = await getServiceDb()
			.insert(jobs)
			.values({
				user_id: USER,
				org_id: ORG,
				job_type: "DEPLOY_RUNNER",
				status: "QUEUED",
				assigned_runner_id: executorId,
				config_snapshot: { runner_id: targetId, runner_name: "t", region: "us-east-1" },
			})
			.returning({ id: jobs.id });
		const res = await claimPost(
			new Request("https://console.local/api/jobs/claim", {
				method: "POST",
				headers: { "X-Runner-ID": executorId, "X-Runner-Token": EXECUTOR_TOKEN },
			}),
		);
		const [after] = await getServiceDb()
			.select({ status: jobs.status, error: jobs.error_message })
			.from(jobs)
			.where(eq(jobs.id, job.id))
			.limit(1);
		return { status: res.status, text: await res.text(), job: after };
	}

	it.each([
		[
			"another org's runner",
			{ userId: OTHER_USER, orgId: ORG_B, operator: "self", provisioning: "deployed" },
		],
		["a managed runner", { userId: null, operator: "managed", provisioning: null }],
		[
			"a registered (not console-deployed) runner of the job's org",
			{ userId: USER, orgId: ORG, operator: "self", provisioning: "registered" },
		],
		[
			"the creator's runner in a different org that is not their personal org",
			{ userId: USER, orgId: ORG_B, operator: "self", provisioning: "deployed" },
		],
	] as const)("refuses to issue a token for %s", async (_label, values) => {
		const target = await seedTarget(values);
		const { status, text, job } = await claimFor(target.id);

		expect(status).toBe(409);
		expect(text).not.toMatch(/[0-9a-f]{64}/);
		expect(job.status).toBe("FAILED");
		expect(job.error).toMatch(/Runner token handoff refused/);
		expect(await storedHash(target.id)).toBe(target.token_hash);
	});

	it("issues a token for the creator's pre-#3874 personal-org runner", async () => {
		const target = await seedTarget({ userId: USER, operator: "self", provisioning: "deployed" });
		// The fixture's premise: the trigger stamped the personal-org shape.
		expect(target.org_id).toBe(USER);

		const { status, text } = await claimFor(target.id);
		expect(status).toBe(200);
		const token = z
			.string()
			.regex(/^[0-9a-f]{64}$/)
			.parse(claimSchema.parse(JSON.parse(text)).job.config_snapshot.runner_token);
		expect(await storedHash(target.id)).toBe(hashRunnerToken(token));
	});

	// ── 3. Every read path redacts ──────────────────────────────────────────────────────────────
	it("getJob returns the row without its secret keys", async () => {
		const job = await getJob(legacyJobId);
		expect(job?.config_snapshot).toMatchObject({ runner_name: "legacy", nested: {} });
		expect(JSON.stringify(job)).not.toContain(SENTINEL);
	});

	it("getJobs returns every row without secret keys", async () => {
		const all = await getJobs();
		expect(all.map((j) => j.id)).toContain(legacyJobId);
		expect(JSON.stringify(all)).not.toContain(SENTINEL);
	});

	it("getJobsPage returns every row without secret keys", async () => {
		const page = await getJobsPage({});
		expect(page.rows.map((j) => j.id)).toContain(legacyJobId);
		expect(JSON.stringify(page)).not.toContain(SENTINEL);
	});

	it("GET /api/cli/jobs/:id returns the row without its secret keys", async () => {
		const res = await cliJobGet(new Request(`https://console.local/api/cli/jobs/${legacyJobId}`), {
			params: Promise.resolve({ id: legacyJobId }),
		});
		expect(res.status).toBe(200);
		const text = await res.text();
		expect(text).toContain("legacy");
		expect(text).not.toContain(SENTINEL);
	});

	it("GET /api/jobs lists every row without secret keys", async () => {
		const res = await jobsListGet(new Request("https://console.local/api/jobs?limit=100"));
		expect(res.status).toBe(200);
		const text = await res.text();
		expect(text).toContain(legacyJobId);
		expect(text).not.toContain(SENTINEL);
	});

	// ── 4. The scrub ───────────────────────────────────────────────────────────────────────────
	it("the migrate-time scrub clears settled rows, spares in-flight ones, and is idempotent", async () => {
		const file = readFileSync(
			fileURLToPath(new URL("../../lib/db/programmables.sql", import.meta.url)),
			"utf8",
		);
		const head = "UPDATE public.jobs\n   SET config_snapshot = config_snapshot - 'runner_token',";
		const start = file.indexOf(head);
		expect(start).toBeGreaterThan(-1);
		const scrub = file.slice(start, file.indexOf(";", start) + 1);

		const db = getServiceDb();
		const seeded = await db
			.insert(jobs)
			.values([
				{
					user_id: USER,
					org_id: ORG,
					job_type: "UPDATE_RUNNER",
					status: "FAILED",
					config_snapshot: { runner_id: randomUUID(), runner_token: SENTINEL, region: "r" },
					config_snapshot_sig: "sig-settled",
				},
				{
					user_id: USER,
					org_id: ORG,
					job_type: "DEPLOY_RUNNER",
					status: "QUEUED",
					config_snapshot: { runner_id: randomUUID(), runner_token: SENTINEL },
					config_snapshot_sig: "sig-in-flight",
				},
				{
					user_id: USER,
					org_id: ORG,
					job_type: "DESTROY_RUNNER",
					status: "SUCCESS",
					config_snapshot: { runner_id: randomUUID() },
					config_snapshot_sig: "sig-untouched",
				},
				{
					// Outside the runner-lifecycle types the statement is narrowed to.
					user_id: USER,
					org_id: ORG,
					job_type: "PLAN",
					status: "SUCCESS",
					config_snapshot: { runner_token: "not-a-lifecycle-row" },
					config_snapshot_sig: "sig-other-type",
				},
			])
			.returning({ id: jobs.id });
		const [settled, inFlight, clean, otherType] = seeded.map((r) => r.id);

		await db.execute(sql.raw(scrub));

		const s = await storedJob(settled);
		expect(s.config_snapshot).not.toHaveProperty("runner_token");
		expect(s.config_snapshot).toMatchObject({ region: "r" });
		expect(s.sig).toBeNull();
		const q = await storedJob(inFlight);
		expect(q.config_snapshot.runner_token).toBe(SENTINEL);
		expect(q.sig).toBe("sig-in-flight");
		const c = await storedJob(clean);
		expect(c.sig).toBe("sig-untouched");
		const o = await storedJob(otherType);
		expect(o.sig).toBe("sig-other-type");

		// Idempotent: a second run over this user's rows changes nothing.
		const before = await db
			.select({ id: jobs.id, snap: jobs.config_snapshot, sig: jobs.config_snapshot_sig })
			.from(jobs)
			.where(inArray(jobs.id, [settled, inFlight, clean]));
		await db.execute(sql.raw(scrub));
		const again = await db
			.select({ id: jobs.id, snap: jobs.config_snapshot, sig: jobs.config_snapshot_sig })
			.from(jobs)
			.where(inArray(jobs.id, [settled, inFlight, clean]));
		expect(again).toEqual(expect.arrayContaining(before));
		expect(again).toHaveLength(before.length);
	});
});
