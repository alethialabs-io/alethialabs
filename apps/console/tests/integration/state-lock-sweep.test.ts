// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Integration: the reconcile sweep that releases a cancelled job's state lock when its runner never
// reports terminal (#7387), against real Postgres.
//
// #7290 lets a cancelled apply keep its lock while its tofu saves state and unlocks; the lock then
// ends with the runner's terminal report. A runner that dies after the cancel never sends one, and
// before this sweep the lock held the next job on that state object — the cleanup DESTROY included —
// QUEUED behind `state_object_busy` for the lock's full 3h TTL.
//
// What is proved here is the SQL: which jobs the sweep picks (CANCELLED, past the drain window,
// holding a live lock) and which it leaves alone, that the DESTROY becomes claimable, and that the
// job carries the line the operator reads.

import { createHash, randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { getServiceDb } from "@/lib/db";
import { jobLogs, jobs, projectEnvironments, projects, runners, tofuStateLocks } from "@/lib/db/schema";
import { LOCK_RELEASED_LOG_LINE, releaseCancelledStateLocks } from "@/lib/reconcile/state-locks";
import { CANCELLED_HOLDER_DRAIN_MS } from "@/lib/runners/state-auth";
import { acquireStateLock, jobHoldsStateLock } from "@/lib/runners/state-lock";
import { describeIfDb } from "./db";

const USER = randomUUID();
const RUNNER_TOKEN = randomUUID();
const TOKEN_HASH = createHash("sha256").update(RUNNER_TOKEN).digest("hex");

let runnerId: string;
let projectId: string;
let envId: string;
let otherEnvId: string;

const db = () => getServiceDb();

/** Inserts a job on (projectId, env) and returns its id. */
async function seedJob(
	status: "QUEUED" | "PROCESSING",
	env: string,
	type: "DEPLOY" | "DESTROY" = "DEPLOY",
): Promise<string> {
	const [row] = await db()
		.insert(jobs)
		.values({
			user_id: USER,
			org_id: USER,
			job_type: type,
			status,
			project_id: projectId,
			environment_id: env,
			config_snapshot: {},
			requires_self_runner: false,
			...(status === "PROCESSING" ? { runner_id: runnerId } : {}),
		})
		.returning({ id: jobs.id });
	return row.id;
}

/** Seeds a PROCESSING apply on `env` holding that environment's state lock. Returns ids. */
async function seedHolder(env: string): Promise<{ job: string; stateKey: string }> {
	const job = await seedJob("PROCESSING", env);
	const lockId = randomUUID();
	const stateKey = `projects/${projectId}/${env}/tofu.tfstate`;
	expect((await acquireStateLock(stateKey, lockId, job, { ID: lockId })).acquired).toBe(true);
	return { job, stateKey };
}

/** The console's cancel, stamped `agoMs` in the past on the database's clock. */
async function cancel(jobId: string, agoMs: number): Promise<void> {
	await db()
		.update(jobs)
		.set({ status: "CANCELLED", completed_at: sql`now() - make_interval(secs => ${agoMs / 1000})` })
		.where(eq(jobs.id, jobId));
}

/** Runs the real claim RPC as our seeded self runner. Returns the claimed job id, or null. */
async function claim(): Promise<string | null> {
	const rows = await db().execute<{ id: string }>(
		sql`select id from claim_next_job(${runnerId}::uuid, ${TOKEN_HASH}, NULL)`,
	);
	return rows[0]?.id ?? null;
}

/** The SYSTEM lines on a job. */
async function systemLines(jobId: string): Promise<string[]> {
	const rows = await db()
		.select({ line: jobLogs.log_chunk })
		.from(jobLogs)
		.where(and(eq(jobLogs.job_id, jobId), eq(jobLogs.stream_type, "SYSTEM")));
	return rows.map((r) => r.line);
}

/** Generous bounds: the sweep is global, and other suites may leave their own candidates. */
const BOUNDS = { pageSize: 50, maxPages: 100 };

describeIfDb("release-cancelled-state-locks sweep (#7387)", () => {
	beforeAll(async () => {
		const [r] = await db()
			.insert(runners)
			.values({
				user_id: USER,
				org_id: USER,
				name: `it-lock-sweep-${randomUUID().slice(0, 8)}`,
				operator: "self",
				provisioning: "registered",
				status: "ONLINE",
				token_hash: TOKEN_HASH,
			})
			.returning({ id: runners.id });
		runnerId = r.id;

		const [p] = await db()
			.insert(projects)
			.values({ user_id: USER, project_name: "lock-sweep-test", region: "eu-central-1", iac_version: "1.9.5" })
			.returning({ id: projects.id });
		projectId = p.id;

		const [e] = await db()
			.insert(projectEnvironments)
			.values({ project_id: projectId, user_id: USER, name: "prod", status: "DRAFT", is_default: true })
			.returning({ id: projectEnvironments.id });
		envId = e.id;
		const [e2] = await db()
			.insert(projectEnvironments)
			.values({ project_id: projectId, user_id: USER, name: "staging", status: "DRAFT", is_default: false })
			.returning({ id: projectEnvironments.id });
		otherEnvId = e2.id;
	});

	beforeEach(async () => {
		await db().delete(tofuStateLocks).where(sql`job_id in (select id from jobs where project_id = ${projectId}::uuid)`);
		await db().delete(jobs).where(eq(jobs.project_id, projectId));
	});

	afterAll(async () => {
		await db().delete(tofuStateLocks).where(sql`job_id in (select id from jobs where project_id = ${projectId}::uuid)`);
		await db().delete(jobs).where(eq(jobs.project_id, projectId));
		await db().delete(projectEnvironments).where(eq(projectEnvironments.project_id, projectId));
		await db().delete(projects).where(eq(projects.id, projectId));
		await db().delete(runners).where(eq(runners.id, runnerId));
	});

	// ── THE DEFECT ──────────────────────────────────────────────────────────────────────────────────
	it("releases a cancelled job's lock past the drain window, so the DESTROY is claimable", async () => {
		const { job, stateKey } = await seedHolder(envId);
		// Cancelled, and its runner died: no terminal report ever comes.
		await cancel(job, CANCELLED_HOLDER_DRAIN_MS + 60_000);
		const destroy = await seedJob("QUEUED", envId, "DESTROY");
		expect(await claim()).toBeNull(); // held behind the stranded lock, as before the fix

		const result = await releaseCancelledStateLocks(db(), BOUNDS);
		expect(result.jobs).toBeGreaterThanOrEqual(1);

		expect(await jobHoldsStateLock(stateKey, job)).toBe(false);
		expect(await systemLines(job)).toEqual([LOCK_RELEASED_LOG_LINE]);
		expect(await claim()).toBe(destroy);
	});

	it("is idempotent: a second run neither releases again nor logs twice", async () => {
		const { job } = await seedHolder(envId);
		await cancel(job, CANCELLED_HOLDER_DRAIN_MS + 60_000);
		await releaseCancelledStateLocks(db(), BOUNDS);
		await releaseCancelledStateLocks(db(), BOUNDS);
		expect(await systemLines(job)).toEqual([LOCK_RELEASED_LOG_LINE]);
	});

	// ── AND IT MUST NOT CUT A DRAIN SHORT ───────────────────────────────────────────────────────────
	it("leaves a cancelled job's lock alone while its tofu may still be draining", async () => {
		const { job, stateKey } = await seedHolder(envId);
		await cancel(job, 60_000);
		await releaseCancelledStateLocks(db(), BOUNDS);
		expect(await jobHoldsStateLock(stateKey, job)).toBe(true);
		expect(await systemLines(job)).toEqual([]);
	});

	it("never touches the lock of a job that is still running, however old", async () => {
		const { job, stateKey } = await seedHolder(envId);
		await db()
			.update(jobs)
			.set({ created_at: sql`now() - interval '1 hour'`, updated_at: sql`now() - interval '1 hour'` })
			.where(eq(jobs.id, job));
		await releaseCancelledStateLocks(db(), BOUNDS);
		expect(await jobHoldsStateLock(stateKey, job)).toBe(true);
	});

	it("drains more candidates than one page holds", async () => {
		const a = await seedHolder(envId);
		const b = await seedHolder(otherEnvId);
		await cancel(a.job, CANCELLED_HOLDER_DRAIN_MS + 60_000);
		await cancel(b.job, CANCELLED_HOLDER_DRAIN_MS + 60_000);
		await releaseCancelledStateLocks(db(), { pageSize: 1, maxPages: 100 });
		expect(await jobHoldsStateLock(a.stateKey, a.job)).toBe(false);
		expect(await jobHoldsStateLock(b.stateKey, b.job)).toBe(false);
	});
});
