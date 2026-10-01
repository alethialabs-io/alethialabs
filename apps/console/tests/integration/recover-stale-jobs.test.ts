// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Integration: recover_stale_jobs() against real Postgres (the CANCEL/CAS work proved mocked
// tests hide real driver/SQL bugs). Exercises the poison-job cap + the progress-stall path that
// the pure-SQL rewrite added:
//   (A) dead-runner liveness → requeue + attempts++ (the original behaviour, now counted);
//   (B) stalled-but-alive (heartbeating runner, progress_at stale) → requeue + attempts++;
//   (cap) at attempts >= max_attempts → fail TERMINAL (FAILED + error_message), RETURN the row;
//   a healthy in-flight job (fresh progress, live runner) is left untouched;
//   and end-to-end: recoverStaleJobs() drives a capped DEPLOY's env → FAILED through the CAS,
//   so a terminal poison job never leaves its environment stuck.
// Seeds via getServiceDb() (bypasses RLS) with unique ids; asserts only on seeded ids so
// concurrent rows can't perturb it; cleans jobs after each case.

import { randomUUID } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { getServiceDb } from "@/lib/db";
import { recoverStaleJobs } from "@/lib/jobs/recovery";
import {
	jobs,
	projectEnvironments,
	projects,
	runners,
} from "@/lib/db/schema";
import type { ProjectStatus } from "@/lib/db/schema/enums";
import type { ExecutionMetadata } from "@/types/jsonb.types";
import { JOB_NOT_OWNED_SQLSTATE, pgErrorCode } from "@/lib/db/pg-error";
import { defaultIfFirst, describeIfDb } from "./db";

const USER = randomUUID();
const ORG = randomUUID();

describeIfDb("recover_stale_jobs — poison cap + progress stall", () => {
	let deadRunner: string; // heartbeat 10 min ago (dead)
	let liveRunner: string; // heartbeat now (alive)
	let projectId: string;
	let seededJobs: string[] = [];

	/** Insert a runner with an explicit last_heartbeat and return its id. */
	async function seedRunner(name: string, heartbeatAgoMin: number): Promise<string> {
		const [row] = await getServiceDb()
			.insert(runners)
			.values({
				name,
				operator: "managed",
				token_hash: `hash-${name}-${randomUUID()}`,
				status: "ONLINE",
			})
			.returning({ id: runners.id });
		await getServiceDb().execute(
			sql`update public.runners set last_heartbeat = now() - make_interval(mins => ${heartbeatAgoMin}) where id = ${row.id}::uuid`,
		);
		return row.id;
	}

	/** Seed a job with fully-controlled staleness inputs. Returns its id (tracked for cleanup). */
	async function seedJob(opts: {
		runnerId: string | null;
		status: "CLAIMED" | "PROCESSING";
		claimedAgoMin: number;
		progressAgoMin: number | null;
		attempts: number;
		maxAttempts?: number;
		jobType?: "DEPLOY" | "PLAN" | "DESTROY" | "DEPLOY_RUNNER";
		environmentId?: string | null;
		executionMetadata?: ExecutionMetadata;
	}): Promise<string> {
		const id = randomUUID();
		await getServiceDb()
			.insert(jobs)
			.values({
				id,
				user_id: USER,
				org_id: ORG,
				project_id: projectId,
				environment_id: opts.environmentId ?? null,
				job_type: opts.jobType ?? "DEPLOY",
				status: opts.status,
				runner_id: opts.runnerId,
				attempts: opts.attempts,
				max_attempts: opts.maxAttempts ?? 5,
				execution_metadata: opts.executionMetadata ?? null,
			});
		// Set the time-relative fields with SQL now() arithmetic (can't via drizzle values()).
		await getServiceDb().execute(sql`
			update public.jobs
			set claimed_at = now() - make_interval(mins => ${opts.claimedAgoMin}),
			    progress_at = ${
					opts.progressAgoMin === null
						? sql`NULL`
						: sql`now() - make_interval(mins => ${opts.progressAgoMin})`
				}
			where id = ${id}::uuid
		`);
		seededJobs.push(id);
		return id;
	}

	async function jobRow(id: string) {
		const [row] = await getServiceDb()
			.select({
				status: jobs.status,
				attempts: jobs.attempts,
				runner_id: jobs.runner_id,
				error_message: jobs.error_message,
				completed_at: jobs.completed_at,
				execution_metadata: jobs.execution_metadata,
			})
			.from(jobs)
			.where(eq(jobs.id, id));
		return row;
	}

	beforeAll(async () => {
		const db = getServiceDb();
		const [p] = await db
			.insert(projects)
			.values({
				user_id: USER,
				project_name: "recover-test",
				region: "us-east-1",
				iac_version: "1.9.5",
			})
			.returning({ id: projects.id });
		projectId = p.id;
		deadRunner = await seedRunner("recover-dead", 10);
		liveRunner = await seedRunner("recover-live", 0);
	});

	afterEach(async () => {
		if (seededJobs.length) {
			await getServiceDb().delete(jobs).where(inArray(jobs.id, seededJobs));
			seededJobs = [];
		}
	});

	afterAll(async () => {
		const db = getServiceDb();
		await db.delete(projectEnvironments).where(eq(projectEnvironments.project_id, projectId));
		await db.delete(projects).where(eq(projects.id, projectId));
		await db.delete(runners).where(inArray(runners.id, [deadRunner, liveRunner]));
	});

	it("(A) requeues a dead-runner job and increments attempts", async () => {
		const j = await seedJob({
			runnerId: deadRunner,
			status: "PROCESSING",
			claimedAgoMin: 20, // > 15-min liveness window
			progressAgoMin: 1, // fresh progress → NOT the (B) path
			attempts: 0,
		});
		await getServiceDb().execute(sql`select recover_stale_jobs()`);
		const row = await jobRow(j);
		expect(row.status).toBe("QUEUED");
		expect(row.attempts).toBe(1);
		expect(row.runner_id).toBeNull(); // claim cleared on requeue
	});

	it("(B) requeues a STALLED-but-alive job (live runner, stale progress) — the liveness check would miss it", async () => {
		const j = await seedJob({
			runnerId: liveRunner, // heartbeating → dead-runner path (A) can't fire
			status: "PROCESSING",
			claimedAgoMin: 2, // < 15 min → (A) definitely off
			progressAgoMin: 40, // > 30-min stall threshold → (B) fires
			attempts: 1,
		});
		await getServiceDb().execute(sql`select recover_stale_jobs()`);
		const row = await jobRow(j);
		expect(row.status).toBe("QUEUED");
		expect(row.attempts).toBe(2);
	});

	it("does NOT touch a healthy in-flight job (live runner, fresh progress)", async () => {
		const j = await seedJob({
			runnerId: liveRunner,
			status: "PROCESSING",
			claimedAgoMin: 2,
			progressAgoMin: 1, // making progress
			attempts: 0,
		});
		await getServiceDb().execute(sql`select recover_stale_jobs()`);
		const row = await jobRow(j);
		expect(row.status).toBe("PROCESSING"); // untouched
		expect(row.attempts).toBe(0);
	});

	it("(cap) fails a job TERMINAL at max_attempts and returns it for env reconciliation", async () => {
		const [e] = await getServiceDb()
			.insert(projectEnvironments)
			.values({
				project_id: projectId,
				user_id: USER,
				name: "prod-cap",
				status: "PROVISIONING",
				is_default: defaultIfFirst(projectId),
			})
			.returning({ id: projectEnvironments.id });
		const envId = e.id;
		const j = await seedJob({
			runnerId: deadRunner,
			status: "PROCESSING",
			claimedAgoMin: 20,
			progressAgoMin: 1,
			attempts: 4, // +1 → 5 == max_attempts → terminal
			maxAttempts: 5,
			jobType: "DEPLOY",
			environmentId: envId,
		});
		const returned = await getServiceDb().execute<{
			job_id: string;
			job_type: string;
			environment_id: string | null;
		}>(sql`select * from recover_stale_jobs()`);
		// The function returns the terminally-failed job (so the TS loop can transition its env).
		const mine = returned.find((r) => r.job_id === j);
		expect(mine).toBeDefined();
		expect(mine?.job_type).toBe("DEPLOY");
		expect(mine?.environment_id).toBe(envId);

		const row = await jobRow(j);
		expect(row.status).toBe("FAILED"); // terminal, NOT requeued
		expect(row.attempts).toBe(5);
		expect(row.error_message).toMatch(/max attempts/i);
		expect(row.completed_at).not.toBeNull();

		await getServiceDb().delete(projectEnvironments).where(eq(projectEnvironments.id, envId));
	});

	it("(cap end-to-end) recoverStaleJobs() drives the capped DEPLOY's env to FAILED via the CAS (no stuck env)", async () => {
		const [e] = await getServiceDb()
			.insert(projectEnvironments)
			.values({
				project_id: projectId,
				user_id: USER,
				name: "prod-e2e",
				status: "PROVISIONING",
				is_default: defaultIfFirst(projectId),
			})
			.returning({ id: projectEnvironments.id });
		const envId = e.id;
		await seedJob({
			runnerId: deadRunner,
			status: "PROCESSING",
			claimedAgoMin: 20,
			progressAgoMin: 1,
			attempts: 4,
			maxAttempts: 5,
			jobType: "DEPLOY",
			environmentId: envId,
		});
		await recoverStaleJobs(getServiceDb());
		const [env] = await getServiceDb()
			.select({ status: projectEnvironments.status })
			.from(projectEnvironments)
			.where(eq(projectEnvironments.id, envId));
		expect(env.status as ProjectStatus).toBe("FAILED"); // env reconciled, not left PROVISIONING

		await getServiceDb().delete(projectEnvironments).where(eq(projectEnvironments.id, envId));
	});
	// #5162 — the requeue-mid-apply shape. A heartbeat gap requeued a DEPLOY whose apply was running;
	// the runner's receipt post was then refused as "not owned" and the job was applied a second time.

	/** The token hash a seeded runner authenticates update_job_status with. */
	async function tokenHashOf(runnerId: string): Promise<string> {
		const [r] = await getServiceDb()
			.select({ token_hash: runners.token_hash })
			.from(runners)
			.where(eq(runners.id, runnerId));
		return r.token_hash;
	}

	it("(apply) never requeues a DEPLOY whose apply started — fails it for reconciliation, keeping the runner", async () => {
		const j = await seedJob({
			runnerId: deadRunner,
			status: "PROCESSING",
			claimedAgoMin: 20, // (A) fires: the heartbeat lapsed
			progressAgoMin: 1,
			attempts: 0, // far below the cap — the OLD code requeued this
			jobType: "DEPLOY",
			executionMetadata: { apply_started_at: "2026-09-30T00:00:00Z" },
		});
		const returned = await getServiceDb().execute<{ job_id: string; reason: string }>(
			sql`select * from recover_stale_jobs()`,
		);
		expect(returned.find((r) => r.job_id === j)?.reason).toBe("apply_started");

		const row = await jobRow(j);
		expect(row.status).toBe("FAILED"); // NOT QUEUED — a requeue would apply a second time
		expect(row.runner_id).toBe(deadRunner); // kept, so the owner's late report still lands
		expect(row.completed_at).not.toBeNull();
		expect(row.error_message).toMatch(/NOT retried/);
		expect(row.execution_metadata?.orphan_risk).toBe(true);
		expect(row.execution_metadata?.recovery_refused_requeue_at).toBeTruthy();
		expect(row.execution_metadata?.apply_started_at).toBe("2026-09-30T00:00:00Z");
	});

	it("(apply) the stalled-but-alive path refuses the requeue too", async () => {
		const j = await seedJob({
			runnerId: liveRunner,
			status: "PROCESSING",
			claimedAgoMin: 2,
			progressAgoMin: 40, // (B) fires
			attempts: 0,
			executionMetadata: { apply_started_at: "2026-09-30T00:00:00Z" },
		});
		await getServiceDb().execute(sql`select recover_stale_jobs()`);
		const row = await jobRow(j);
		expect(row.status).toBe("FAILED");
		expect(row.runner_id).toBe(liveRunner);
	});

	it("(apply) a runner that was still applying lands its receipt after the refusal, and nobody else can", async () => {
		const j = await seedJob({
			runnerId: deadRunner,
			status: "PROCESSING",
			claimedAgoMin: 20,
			progressAgoMin: 1,
			attempts: 0,
			executionMetadata: { apply_started_at: "2026-09-30T00:00:00Z" },
		});
		await getServiceDb().execute(sql`select recover_stale_jobs()`);

		// The owning runner's post-apply report: accepted (not raised), merged as a late report.
		const receipt = JSON.stringify({ verify_receipt: { plan_sha256: "abc" } });
		const [res] = await getServiceDb().execute<{ applied: boolean }>(
			sql`select update_job_status(${deadRunner}::uuid, ${await tokenHashOf(deadRunner)}, ${j}::uuid, 'SUCCESS', NULL, ${receipt}::jsonb) as applied`,
		);
		expect(res.applied).toBe(false); // the DB status (FAILED) stays authoritative
		const row = await jobRow(j);
		expect(row.status).toBe("FAILED");
		expect(row.execution_metadata?.verify_receipt).toEqual({ plan_sha256: "abc" });

		// Any OTHER runner is refused with the distinct SQLSTATE the status route maps to 409.
		const refused = await getServiceDb()
			.execute(
				sql`select update_job_status(${liveRunner}::uuid, ${await tokenHashOf(liveRunner)}, ${j}::uuid, 'SUCCESS', NULL, NULL)`,
			)
			.then(
				() => undefined,
				(err: unknown) => err,
			);
		expect(pgErrorCode(refused)).toBe(JOB_NOT_OWNED_SQLSTATE);
	});

	it("(apply) still requeues a DEPLOY that never reached apply", async () => {
		const j = await seedJob({
			runnerId: deadRunner,
			status: "PROCESSING",
			claimedAgoMin: 20,
			progressAgoMin: 1,
			attempts: 0,
			executionMetadata: { cluster_name: "pre-apply" },
		});
		await getServiceDb().execute(sql`select recover_stale_jobs()`);
		const row = await jobRow(j);
		expect(row.status).toBe("QUEUED");
		expect(row.runner_id).toBeNull();
	});
});
