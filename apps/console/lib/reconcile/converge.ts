// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Env-status convergence backstop (B2a reconciler). The env-status CAS (lib/db/env-status.ts) is the
// primary guard against last-writer-wins clobber, but a *dropped-but-legal* update — the transition
// table being momentarily too narrow, or a status callback lost to a crash/partition after its job
// went terminal — can leave a job SUCCESS/FAILED while its env is stuck in an in-flight status
// (QUEUED / PROVISIONING / DESTROYING). The CAS logs + alerts that drift but does not self-heal; this
// reconciler does: on a schedule it converges each stuck env to the outcome its latest LIFECYCLE job
// already reached — but ONLY when it's unambiguous, and ALWAYS through the same CAS so it can never
// clobber a live env.
//
// Safety (why this can't fight an in-flight job):
//   • It only looks at envs currently in a STALE IN-FLIGHT status (QUEUED/PROVISIONING/DESTROYING).
//     Settled states (DRAFT/ACTIVE/FAILED/DESTROYED) are never touched.
//   • A candidate's latest lifecycle job (DEPLOY/DESTROY/PLAN — the only job types that own env
//     status) must be TERMINAL, AND there must be NO non-terminal lifecycle job for the env. So there
//     is provably no apply/plan/destroy in flight to race.
//   • The move goes through `transitionEnv` (the CAS), whose per-context from-set is the final gate:
//     if the env moved between our SELECT and the UPDATE, the CAS rejects and we no-op. We pass
//     `silent` so an expected rejection doesn't emit a status-conflict alert (this reconciler probes
//     many envs speculatively).
//
// What the rule above could not see (#6736). It settles an env only BEHIND a terminal job, so an env
// whose newest lifecycle job never reaches a terminal state stays in flight for ever — and one did,
// for four months, on production. Two shapes of that, both handled below before the candidates are
// read, and both bounded by UNCLAIMED_JOB_TTL_HOURS:
//   • An UNCLAIMED job. recover_stale_jobs (programmables.sql) sweeps CLAIMED/PROCESSING jobs only;
//     a QUEUED job no runner ever claims — or one it requeued after its runner died, which leaves the
//     env PROVISIONING — waits for ever, and the NOT EXISTS below keeps its env out of convergence.
//     Past the TTL such a job is CANCELLED with a reason, exactly as a user cancel writes it
//     (lib/jobs/cancel.ts: CANCELLED + completed_at + error_message), and the ordinary convergence
//     then settles its env once the job is CONVERGE_MIN_AGE_MINUTES terminal: a DEPLOY or DESTROY to
//     FAILED, a PLAN to DRAFT. Only a job whose env is itself stuck in flight is touched — a QUEUED
//     job behind a settled env is someone's pending work, not a stuck lifecycle.
//   • An env in flight with NO lifecycle job at all (the LATERAL below then yields no row). Past the
//     TTL it is settled FAILED through the same CAS, with no job to name.

import { sql } from "drizzle-orm";
import type { Db } from "@/lib/db";
import {
	type EnvTransitionContext,
	transitionEnv,
} from "@/lib/db/env-status";
import type {
	ProjectStatus,
	ProvisionJobStatus,
	ProvisionJobType,
} from "@/lib/db/schema/enums";
import { emitAlertEventSafe } from "@/lib/alerts/emit";
import { log } from "@/lib/observability/log";

const clog = log.child({ component: "reconcile", reconciler: "env-convergence" });

/**
 * Minimum age (minutes) of a terminal lifecycle job before its env is eligible for convergence. This
 * is what makes convergence a true BACKSTOP rather than a racer of the live path: in the normal flow
 * a job goes terminal and its status callback settles the env in the SAME sub-second window, so a
 * freshly-terminal job is NOT converged (avoiding both a spurious status-conflict alert against a
 * healthy deploy and a clobber of an env a concurrent enqueue just re-queued). Only a job that went
 * terminal this many minutes ago with its env STILL stuck in-flight is a genuinely dropped update.
 * Well beyond any callback latency; env-tunable.
 */
const CONVERGE_MIN_AGE_MINUTES = (() => {
	const raw = Number(process.env.ALETHIA_CONVERGE_MIN_AGE_MINUTES);
	return Number.isFinite(raw) && raw > 0 ? raw : 5;
})();

/**
 * Hours a lifecycle job may sit QUEUED, unclaimed, while its env is stuck in flight, before it is
 * cancelled so the env can settle. Generous on purpose: it must outlast any runner outage worth
 * waiting through, and a cancelled job is re-run with one click. Env-tunable.
 */
export const UNCLAIMED_JOB_TTL_HOURS = (() => {
	const raw = Number(process.env.ALETHIA_UNCLAIMED_JOB_TTL_HOURS);
	return Number.isFinite(raw) && raw > 0 ? raw : 24;
})();

/** The reason written on a job cancelled because no runner claimed it — the env's "why" for FAILED. */
export const UNCLAIMED_JOB_REASON = `No runner claimed this job within ${UNCLAIMED_JOB_TTL_HOURS} hours, so it was cancelled and its environment settled instead of waiting for ever. Check that a runner is online for this cloud, then run it again.`;

/** A lifecycle job cancelled because no runner claimed it in time. */
type ExpiredJob = {
	job_id: string;
	job_type: ProvisionJobType;
	environment_id: string;
	org_id: string | null;
	project_id: string | null;
};

/** An env stuck in flight with no lifecycle job at all. */
type OrphanEnv = {
	env_id: string;
	org_id: string | null;
	project_id: string | null;
	current_status: ProjectStatus;
};

/**
 * Cancels every DEPLOY/DESTROY/PLAN job that has sat QUEUED past {@link UNCLAIMED_JOB_TTL_HOURS}
 * while its env is stuck in flight. The flip is conditional on `status = 'QUEUED'` in the same
 * statement, so a runner claiming the job concurrently wins (claim_next_job locks QUEUED rows FOR
 * UPDATE SKIP LOCKED; this UPDATE then re-checks and skips the claimed row). `updated_at` is the
 * clock because a requeue (recover_stale_jobs) restamps it: the TTL runs from when the job last
 * became claimable, not from when it was first enqueued. Returns what it cancelled.
 */
export async function expireUnclaimedLifecycleJobs(db: Db): Promise<ExpiredJob[]> {
	const rows = await db.execute<ExpiredJob>(sql`
		UPDATE public.jobs j
		   SET status = 'CANCELLED',
		       completed_at = now(),
		       updated_at = now(),
		       error_message = ${UNCLAIMED_JOB_REASON}
		  FROM public.project_environments e
		 WHERE e.id = j.environment_id
		   AND e.status IN ('QUEUED', 'PROVISIONING', 'DESTROYING')
		   AND j.status = 'QUEUED'
		   AND j.job_type IN ('DEPLOY', 'DESTROY', 'PLAN')
		   AND j.updated_at < now() - make_interval(hours => ${UNCLAIMED_JOB_TTL_HOURS})
		RETURNING j.id AS job_id, j.job_type, j.environment_id, j.org_id, j.project_id
	`);
	const expired = [...rows];
	for (const j of expired) {
		clog.warn("cancelled an unclaimed lifecycle job so its env can settle", {
			job_id: j.job_id,
			env_id: j.environment_id,
			job_type: j.job_type,
		});
		if (j.org_id) {
			emitAlertEventSafe(j.org_id, "system.job.cancelled", {
				title: `Job cancelled: ${j.job_type}`,
				summary: UNCLAIMED_JOB_REASON,
				severity: "warning",
				job_id: j.job_id,
				job_type: j.job_type,
				project_id: j.project_id ?? undefined,
			});
		}
	}
	return expired;
}

/** The CAS context that settles an orphaned in-flight env: a teardown fails as a teardown. */
export function orphanContextFor(status: ProjectStatus): EnvTransitionContext | null {
	switch (status) {
		case "QUEUED":
		case "PROVISIONING":
			return "deployFailed";
		case "DESTROYING":
			return "destroyFailed";
		default:
			return null;
	}
}

/** Envs stuck in flight past the TTL with no DEPLOY/DESTROY/PLAN job at all. */
async function findOrphans(db: Db): Promise<OrphanEnv[]> {
	const rows = await db.execute<OrphanEnv>(sql`
		SELECT e.id AS env_id, e.org_id AS org_id, e.project_id AS project_id, e.status AS current_status
		  FROM public.project_environments e
		 WHERE e.status IN ('QUEUED', 'PROVISIONING', 'DESTROYING')
		   AND e.updated_at < now() - make_interval(hours => ${UNCLAIMED_JOB_TTL_HOURS})
		   AND NOT EXISTS (
		     SELECT 1 FROM public.jobs j
		      WHERE j.environment_id = e.id
		        AND j.job_type IN ('DEPLOY', 'DESTROY', 'PLAN')
		   )
	`);
	return [...rows];
}

/** A stuck env + the terminal lifecycle job the reconciler should converge it toward. */
type ConvergeCandidate = {
	env_id: string;
	org_id: string | null;
	project_id: string | null;
	current_status: ProjectStatus;
	job_id: string;
	job_type: ProvisionJobType;
	job_status: ProvisionJobStatus;
};

/**
 * Map a terminal lifecycle (job_type × job_status) onto the env-status CAS context that settles its
 * env. SUCCESS routes to the job's success terminal. For DEPLOY/DESTROY a FAILED *or* CANCELLED job
 * settles the env to FAILED (a cancelled apply/teardown may leave partially-applied infra — FAILED is
 * the honest "needs attention" resting state). A PLAN is READ-ONLY, so a cancelled plan touched
 * nothing: it settles back to DRAFT (its success target), not FAILED — only a genuinely FAILED plan
 * marks the env FAILED. The CAS from-set still guards every move. Non-lifecycle job types never reach
 * here (the candidate query only selects DEPLOY/DESTROY/PLAN).
 */
function convergenceContextFor(
	jobType: ProvisionJobType,
	jobStatus: ProvisionJobStatus,
): EnvTransitionContext | null {
	const success = jobStatus === "SUCCESS";
	switch (jobType) {
		case "DEPLOY":
			return success ? "deploySuccess" : "deployFailed";
		case "DESTROY":
			return success ? "destroySuccess" : "destroyFailed";
		case "PLAN":
			// A read-only plan changes no infra — SUCCESS and a benign CANCELLED both rest at DRAFT;
			// only a real FAILED plan settles FAILED.
			return jobStatus === "FAILED" ? "planFailed" : "planSuccess";
		default:
			return null;
	}
}

/**
 * Find every env stuck in an in-flight status whose latest lifecycle job is terminal and which has no
 * lifecycle job still in flight. Pure read — the caller decides (via the CAS) whether to move each.
 */
async function findCandidates(db: Db): Promise<ConvergeCandidate[]> {
	// Drive from the (few) envs currently STUCK in an in-flight status, then LATERAL top-1 their newest
	// lifecycle job — far cheaper than a global window over every job. A candidate qualifies only when
	// that latest lifecycle job is terminal AND the env has no in-flight lifecycle job at all, so there
	// is provably nothing running to race.
	const rows = await db.execute<ConvergeCandidate>(sql`
		SELECT e.id            AS env_id,
		       e.org_id         AS org_id,
		       e.project_id     AS project_id,
		       e.status         AS current_status,
		       l.id             AS job_id,
		       l.job_type       AS job_type,
		       l.status         AS job_status
		FROM public.project_environments e
		CROSS JOIN LATERAL (
		    SELECT j.id, j.job_type, j.status, j.completed_at, j.updated_at
		    FROM public.jobs j
		    WHERE j.environment_id = e.id
		      AND j.job_type IN ('DEPLOY', 'DESTROY', 'PLAN')
		    ORDER BY j.created_at DESC, j.id DESC
		    LIMIT 1
		) l
		WHERE e.status IN ('QUEUED', 'PROVISIONING', 'DESTROYING')
		  AND l.status IN ('SUCCESS', 'FAILED', 'CANCELLED')
		  -- Staleness gate: only a job that went terminal well outside the live-callback window,
		  -- with its env STILL stuck, is a genuinely dropped update. Skips the sub-second race
		  -- against the normal deploy callback and against a concurrent re-enqueue.
		  -- A terminal job written without completed_at (no writer in this repo does, but the column is
		  -- nullable) falls back to when its row last changed, rather than holding its env for ever.
		  AND coalesce(l.completed_at, l.updated_at) < now() - make_interval(mins => ${CONVERGE_MIN_AGE_MINUTES})
		  AND NOT EXISTS (
		    SELECT 1 FROM public.jobs j2
		    WHERE j2.environment_id = e.id
		      AND j2.job_type IN ('DEPLOY', 'DESTROY', 'PLAN')
		      AND j2.status IN ('QUEUED', 'CLAIMED', 'PROCESSING')
		  )
	`);
	return [...rows];
}

/**
 * Converge stuck env statuses to their latest terminal lifecycle job. Service-role (global loop, no
 * session). Best-effort per row: one env's CAS failing never blocks the rest. Returns how many envs
 * were actually moved (a moved count > 0 means a CAS drop was silently repaired — worth noticing).
 */
export async function convergeEnvStatuses(
	db: Db,
): Promise<{ converged: number; candidates: number; expired: number; orphans: number }> {
	// First, unstick what no terminal job will ever settle (#6736). A job cancelled here is
	// converged on a later pass, once it is CONVERGE_MIN_AGE_MINUTES terminal.
	const expired = await expireUnclaimedLifecycleJobs(db);
	let orphans = 0;
	for (const o of await findOrphans(db)) {
		const context = orphanContextFor(o.current_status);
		if (!context) continue;
		try {
			const moved = await transitionEnv(db, o.env_id, context, null, {
				orgId: o.org_id,
				projectId: o.project_id,
				silent: true,
			});
			if (moved) {
				orphans += 1;
				clog.warn("settled an in-flight env with no lifecycle job", {
					env_id: o.env_id,
					from_status: o.current_status,
					context,
				});
			}
		} catch (err) {
			clog.error("orphan env CAS failed", { err, env_id: o.env_id });
		}
	}

	const candidates = await findCandidates(db);
	let converged = 0;
	for (const c of candidates) {
		const context = convergenceContextFor(c.job_type, c.job_status);
		if (!context) continue;
		try {
			// silent: an expected rejection (env moved under us) must not alert-storm; the CAS from-set
			// is the guard, so a rejection just means "already settled / not eligible" → skip.
			const moved = await transitionEnv(db, c.env_id, context, c.job_id, {
				orgId: c.org_id,
				projectId: c.project_id,
				silent: true,
			});
			if (moved) {
				converged += 1;
				clog.info("converged stale env-status to terminal job", {
					env_id: c.env_id,
					project_id: c.project_id ?? undefined,
					org_id: c.org_id ?? undefined,
					job_id: c.job_id,
					from_status: c.current_status,
					context,
					job_type: c.job_type,
					job_status: c.job_status,
				});
			}
		} catch (err) {
			clog.error("env convergence CAS failed", { err, env_id: c.env_id });
		}
	}
	return { converged, candidates: candidates.length, expired: expired.length, orphans };
}
