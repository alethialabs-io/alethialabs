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
import { log } from "@/lib/observability/log";

const clog = log.child({ component: "reconcile", reconciler: "env-convergence" });

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
 * env. SUCCESS routes to the job's success terminal; FAILED/CANCELLED both settle the env to FAILED
 * (a cancelled provisioning job leaves no live infra — FAILED is the honest resting state, and the
 * CAS still guards the from-set). Non-lifecycle job types never reach here (the candidate query only
 * selects DEPLOY/DESTROY/PLAN).
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
			return success ? "planSuccess" : "planFailed";
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
		    SELECT j.id, j.job_type, j.status
		    FROM public.jobs j
		    WHERE j.environment_id = e.id
		      AND j.job_type IN ('DEPLOY', 'DESTROY', 'PLAN')
		    ORDER BY j.created_at DESC, j.id DESC
		    LIMIT 1
		) l
		WHERE e.status IN ('QUEUED', 'PROVISIONING', 'DESTROYING')
		  AND l.status IN ('SUCCESS', 'FAILED', 'CANCELLED')
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
export async function convergeEnvStatuses(db: Db): Promise<{ converged: number; candidates: number }> {
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
	return { converged, candidates: candidates.length };
}
