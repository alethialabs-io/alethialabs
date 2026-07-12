// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Integration (real Postgres) for the B2c reconcile/convergence layer. Mocked unit tests hide real
// SQL bugs (the CAS array-cast bug is the canonical example), so the load-bearing behaviours are
// proven here against an actual DB:
//   • transactional heal — a job-insert failure rolls back the env-status CAS (all-or-nothing).
//   • env-status convergence — settles a stuck in-flight env to its latest TERMINAL lifecycle job,
//     and NEVER converges while a lifecycle job is still in flight.
//   • ephemeral reaper — enqueues DESTROY for an expired ephemeral env, and re-running is a no-op.
//   • retention GC — gc_job_logs / gc_fleet_actions delete in bounded batches (never the whole table).

import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import { maybeAutoHeal } from "@/app/server/actions/reconcile";
import { getServiceDb } from "@/lib/db";
import { setEnvStatus } from "@/lib/db/env-status";
import {
	fleetActions,
	jobLogs,
	jobs,
	projectEnvironments,
	projects,
} from "@/lib/db/schema";
import type { ProjectStatus } from "@/lib/db/schema/enums";
import { convergeEnvStatuses } from "@/lib/reconcile/converge";
import { reapExpiredEphemeralEnvs } from "@/lib/reconcile/reap";
import { describeIfDb } from "./db";

const USER = randomUUID();
const db = getServiceDb();

/** Insert an env in a known state and return its id. */
async function seedEnv(
	projectId: string,
	name: string,
	status: ProjectStatus,
	opts: {
		lifecycle?: "persistent" | "ephemeral";
		expiresAt?: Date | null;
		autoHeal?: boolean;
		stage?: "development" | "staging" | "production";
	} = {},
): Promise<string> {
	const [e] = await db
		.insert(projectEnvironments)
		.values({
			project_id: projectId,
			user_id: USER,
			name,
			status,
			stage: opts.stage ?? "development",
			lifecycle: opts.lifecycle ?? "persistent",
			expires_at: opts.expiresAt ?? null,
			auto_heal: opts.autoHeal ?? false,
		})
		.returning({ id: projectEnvironments.id });
	return e.id;
}

/**
 * Insert a job for an env with an explicit type/status/timestamp (to control "latest"). Terminal jobs
 * get a `completed_at` (defaults to `createdAt`) — convergence's staleness gate keys off it, so a test
 * that wants an env converged must give it a completed_at older than the min-age window (the t0-based
 * timestamps are 11 days in the past, so that holds by default); pass `completedAt: new Date()` to
 * simulate a FRESH terminal job that convergence must NOT touch.
 */
async function seedJob(
	projectId: string,
	envId: string,
	jobType: "DEPLOY" | "DESTROY" | "PLAN" | "DETECT_DRIFT",
	status: "QUEUED" | "PROCESSING" | "SUCCESS" | "FAILED" | "CANCELLED",
	createdAt: Date,
	completedAt?: Date,
): Promise<string> {
	const terminal = status === "SUCCESS" || status === "FAILED" || status === "CANCELLED";
	const [j] = await db
		.insert(jobs)
		.values({
			user_id: USER,
			project_id: projectId,
			environment_id: envId,
			job_type: jobType,
			status,
			config_snapshot: { seed: true },
			created_at: createdAt,
			completed_at: terminal ? (completedAt ?? createdAt) : null,
		})
		.returning({ id: jobs.id });
	return j.id;
}

async function statusOf(envId: string): Promise<ProjectStatus> {
	const [row] = await db
		.select({ status: projectEnvironments.status })
		.from(projectEnvironments)
		.where(eq(projectEnvironments.id, envId));
	return row.status;
}

async function jobCount(envId: string, jobType: string): Promise<number> {
	const rows = await db
		.select({ id: jobs.id })
		.from(jobs)
		.where(
			and(eq(jobs.environment_id, envId), sql`${jobs.job_type}::text = ${jobType}`),
		);
	return rows.length;
}

describeIfDb("B2c reconcile — real Postgres", () => {
	let projectId: string;
	const t0 = new Date("2026-07-01T00:00:00Z");
	const min = (n: number) => new Date(t0.getTime() + n * 60_000);

	beforeAll(async () => {
		const [p] = await db
			.insert(projects)
			.values({
				user_id: USER,
				project_name: "b2c-reconcile",
				region: "us-east-1",
				iac_version: "1.9.5",
			})
			.returning({ id: projects.id });
		projectId = p.id;
	});

	afterAll(async () => {
		// Cascade: deleting the project drops its envs + jobs (+ job_logs via cascade). fleet_actions
		// are global — cleaned in their own test.
		await db.delete(jobs).where(eq(jobs.user_id, USER));
		await db.delete(projectEnvironments).where(eq(projectEnvironments.project_id, projectId));
		await db.delete(projects).where(eq(projects.id, projectId));
	});

	it("transactional heal: a job-insert failure rolls back the env-status CAS", async () => {
		const envId = await seedEnv(projectId, "heal-rollback", "ACTIVE");
		// Reproduce maybeAutoHeal's transaction shape, but force the job insert to fail. environment_id
		// references project_environments(id); a non-existent id violates that FK at insert time. The
		// CAS (ACTIVE→QUEUED) runs FIRST inside the tx; the insert then throws.
		await expect(
			db.transaction(async (tx) => {
				const moved = await setEnvStatus(tx, envId, ["ACTIVE"], "QUEUED", null);
				expect(moved).toBe(true); // CAS succeeded *within* the tx
				await tx.insert(jobs).values({
					user_id: USER,
					project_id: projectId,
					environment_id: randomUUID(), // no such env → FK violation → rollback
					job_type: "DEPLOY",
					status: "QUEUED",
					config_snapshot: {},
				});
			}),
		).rejects.toThrow();
		// All-or-nothing: the failed insert rolled the CAS back — the env is still ACTIVE, not QUEUED.
		expect(await statusOf(envId)).toBe("ACTIVE");
	});

	it("transactional heal: maybeAutoHeal commits the CAS + DEPLOY job together", async () => {
		const envId = await seedEnv(projectId, "heal-commit", "ACTIVE", { autoHeal: true });
		await seedJob(projectId, envId, "DEPLOY", "SUCCESS", min(1)); // last-deployed design to re-apply
		await maybeAutoHeal(projectId, envId);
		expect(await statusOf(envId)).toBe("QUEUED"); // CAS committed
		expect(await jobCount(envId, "DEPLOY")).toBe(2); // original SUCCESS + the new heal DEPLOY
	});

	it("convergence: settles a stuck in-flight env to its latest TERMINAL lifecycle job", async () => {
		const provDeploySuccess = await seedEnv(projectId, "conv-prov-ok", "PROVISIONING");
		await seedJob(projectId, provDeploySuccess, "DEPLOY", "SUCCESS", min(2));

		const queuedDestroySuccess = await seedEnv(projectId, "conv-destroy-ok", "QUEUED");
		await seedJob(projectId, queuedDestroySuccess, "DESTROY", "SUCCESS", min(2));

		// Latest LIFECYCLE job is the DEPLOY SUCCESS; a newer DETECT_DRIFT must NOT confuse it.
		const provWithDrift = await seedEnv(projectId, "conv-prov-drift", "PROVISIONING");
		await seedJob(projectId, provWithDrift, "DEPLOY", "SUCCESS", min(2));
		await seedJob(projectId, provWithDrift, "DETECT_DRIFT", "SUCCESS", min(5));

		await convergeEnvStatuses(db);

		expect(await statusOf(provDeploySuccess)).toBe("ACTIVE");
		expect(await statusOf(queuedDestroySuccess)).toBe("DESTROYED");
		expect(await statusOf(provWithDrift)).toBe("ACTIVE");
	});

	it("convergence: NEVER converges while a lifecycle job is still in flight, or a settled env", async () => {
		const provInFlight = await seedEnv(projectId, "conv-inflight", "PROVISIONING");
		await seedJob(projectId, provInFlight, "DEPLOY", "PROCESSING", min(2)); // still running

		const settledActive = await seedEnv(projectId, "conv-settled", "ACTIVE");
		await seedJob(projectId, settledActive, "DEPLOY", "SUCCESS", min(2));

		await convergeEnvStatuses(db);

		expect(await statusOf(provInFlight)).toBe("PROVISIONING"); // untouched — apply in flight
		expect(await statusOf(settledActive)).toBe("ACTIVE"); // untouched — not an in-flight state
	});

	it("convergence: staleness gate — a FRESH terminal job is NOT converged (never races the live path)", async () => {
		// Env stuck PROVISIONING with a DEPLOY that JUST went terminal (completed_at = now). This is the
		// sub-second window in which the real status callback settles the env — convergence must stay out
		// of it, else it races finalizeDeployment (spurious status-conflict alert) or a concurrent
		// re-enqueue. Only a job terminal for >min-age with the env still stuck is a dropped update.
		const freshTerminal = await seedEnv(projectId, "conv-fresh", "PROVISIONING");
		await seedJob(projectId, freshTerminal, "DEPLOY", "SUCCESS", min(2), new Date());

		await convergeEnvStatuses(db);

		expect(await statusOf(freshTerminal)).toBe("PROVISIONING"); // untouched — too fresh to be a drop
	});

	it("convergence: a cancelled read-only PLAN settles to DRAFT, not FAILED", async () => {
		// A PLAN changes no infra, so a cancelled plan that stranded the env at QUEUED must converge back
		// to DRAFT (its success target) — NOT be flagged FAILED (which would trigger spurious remediation).
		const planCancelled = await seedEnv(projectId, "conv-plan-cancel", "QUEUED");
		await seedJob(projectId, planCancelled, "PLAN", "CANCELLED", min(2));

		await convergeEnvStatuses(db);

		expect(await statusOf(planCancelled)).toBe("DRAFT"); // read-only plan → DRAFT, not FAILED
	});

	it("ephemeral reaper: enqueues DESTROY for an expired env, and re-running is a no-op", async () => {
		const envId = await seedEnv(projectId, "reap-me", "ACTIVE", {
			lifecycle: "ephemeral",
			expiresAt: min(-10), // already expired
		});
		await seedJob(projectId, envId, "DEPLOY", "SUCCESS", min(1)); // live infra to tear down

		const first = await reapExpiredEphemeralEnvs(db);
		expect(first.reaped).toBe(1);
		expect(await statusOf(envId)).toBe("QUEUED");
		expect(await jobCount(envId, "DESTROY")).toBe(1);

		// Idempotent: env is now QUEUED (out of the reapable set) → a second pass enqueues nothing more.
		const second = await reapExpiredEphemeralEnvs(db);
		expect(second.reaped).toBe(0);
		expect(await jobCount(envId, "DESTROY")).toBe(1);
	});

	it("ephemeral reaper: skips an expired env that was never deployed (no infra)", async () => {
		const envId = await seedEnv(projectId, "reap-nodeploy", "FAILED", {
			lifecycle: "ephemeral",
			expiresAt: min(-10),
		});
		const res = await reapExpiredEphemeralEnvs(db);
		// This env has no SUCCESS DEPLOY → not reaped (nothing in the cloud to destroy).
		expect(await statusOf(envId)).toBe("FAILED");
		expect(res.reaped).toBe(0);
	});

	it("retention GC: gc_job_logs deletes in bounded batches", async () => {
		const envId = await seedEnv(projectId, "gc-logs", "ACTIVE");
		const jobId = await seedJob(projectId, envId, "DEPLOY", "SUCCESS", min(1));
		// 5 old log rows.
		for (let i = 0; i < 5; i++) {
			await db.insert(jobLogs).values({
				job_id: jobId,
				log_chunk: `line ${i}`,
				created_at: min(-1000),
			});
		}
		// p_age=0 makes all 5 eligible; p_limit=2 bounds each pass.
		const pass1 = await db.execute<{ deleted: number }>(
			sql`select public.gc_job_logs(make_interval(secs => 0), 2) as deleted`,
		);
		expect(Number(pass1[0].deleted)).toBe(2);
		const pass2 = await db.execute<{ deleted: number }>(
			sql`select public.gc_job_logs(make_interval(secs => 0), 2) as deleted`,
		);
		expect(Number(pass2[0].deleted)).toBe(2);
		const pass3 = await db.execute<{ deleted: number }>(
			sql`select public.gc_job_logs(make_interval(secs => 0), 2) as deleted`,
		);
		expect(Number(pass3[0].deleted)).toBe(1); // drained
		const remaining = await db
			.select({ id: jobLogs.id })
			.from(jobLogs)
			.where(eq(jobLogs.job_id, jobId));
		expect(remaining.length).toBe(0);
	});

	it("retention GC: gc_fleet_actions deletes in bounded batches", async () => {
		const marker = randomUUID();
		for (let i = 0; i < 3; i++) {
			await db.insert(fleetActions).values({
				provider: "aws",
				action: "create",
				reason: marker, // unique tag so we only count our rows
				created_at: min(-1000),
			});
		}
		const del1 = await db.execute<{ deleted: number }>(
			sql`select public.gc_fleet_actions(make_interval(secs => 0), 2) as deleted`,
		);
		expect(Number(del1[0].deleted)).toBe(2);
		const del2 = await db.execute<{ deleted: number }>(
			sql`select public.gc_fleet_actions(make_interval(secs => 0), 2) as deleted`,
		);
		expect(Number(del2[0].deleted)).toBe(1);
		const left = await db
			.select({ id: fleetActions.id })
			.from(fleetActions)
			.where(eq(fleetActions.reason, marker));
		expect(left.length).toBe(0);
	});
});
