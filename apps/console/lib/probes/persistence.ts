// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// PROBE_CLUSTER result persistence + the latest-probe read. NOT server actions — see the note
// in lib/jobs/finalize-deployment.ts. recordProbeResult writes through getServiceDb() on the
// runner's status callback; getLatestProbesByEnv is a plain org-scoped query whose callers
// (app/server/actions/reconcile.ts, app/api/cli/projects/[id]/probes/route.ts) authorize
// first and pass the org id in.

// Live cluster-alive signal (BYOC B2) — the "is it still up?" half of day-2, alongside drift
// ("has it diverged?"). A PROBE_CLUSTER job dials the env's cluster API server and the runner
// posts a ProbeResult on execution_metadata.probe_result; the job-status route ingests it here.
// Unlike environment_drift (one upserted latest-posture row per env), environment_probes is an
// APPEND-ONLY history — every probe is a new row so a true→false liveness transition and its
// timing are durably recorded. recordProbeResult persists the row and reports whether this
// result was a true→false transition (the ingest route emits the outage alert on that). Service
// role only (getServiceDb, RLS-bypassing) — mirrors recordDriftPosture.

import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { getServiceDb } from "@/lib/db";
import {
	environmentProbes,
	projectEnvironments,
	projects,
} from "@/lib/db/schema";
import { shouldAlertUnreachable } from "@/lib/probes/schedule";
import type { ProbeDetail } from "@/types/jsonb.types";

/** The latest cluster-alive state of an environment (the read shape for badges/reconcile). */
export interface ProbeState {
	/** True = API server answered, false = unreachable, null = never probed. */
	reachable: boolean | null;
	/** Short human-readable summary (esp. WHY unreachable). */
	message: string | null;
	/** When the probe ran (RFC3339), null when never probed. */
	probedAt: string | null;
}

/**
 * Persist a PROBE_CLUSTER result as a new environment_probes history row and report whether it
 * was a true→false liveness transition (cluster WAS reachable on its previous probe, now isn't).
 * The previous reachability is read BEFORE the insert so the comparison is against prior history,
 * not the row we're about to write. Latest-wins is inherent (append-only + probed_at ordering).
 * Returns `becameUnreachable` so the caller (job-status route, which holds org_id) can emit the
 * outage alert exactly once, on the transition.
 */
export async function recordProbeResult(input: {
	projectId: string;
	environmentId: string;
	reachable: boolean;
	message?: string | null;
	detail?: ProbeDetail;
	probedAt: string;
}): Promise<{ becameUnreachable: boolean }> {
	const db = getServiceDb();

	// Prior reachability for this env (the transition baseline) — read before inserting.
	const [prev] = await db
		.select({ reachable: environmentProbes.reachable })
		.from(environmentProbes)
		.where(eq(environmentProbes.environment_id, input.environmentId))
		.orderBy(desc(environmentProbes.probed_at))
		.limit(1);
	const prevReachable: boolean | null = prev ? prev.reachable : null;

	await db.insert(environmentProbes).values({
		project_id: input.projectId,
		environment_id: input.environmentId,
		reachable: input.reachable,
		message: input.message ?? null,
		detail: input.detail ?? {},
		probed_at: new Date(input.probedAt),
	});

	return {
		becameUnreachable: shouldAlertUnreachable(prevReachable, input.reachable),
	};
}

/**
 * Latest cluster-alive state for a project's environments, keyed by environment_id — the read
 * for getEnvReconcileStates.probe and for GET /api/cli/projects/:id/probes. `environment_probes`
 * is an RLS-less project-child table, so the org boundary is enforced HERE by joining to the
 * parent project and filtering on org (mirrors getLatestDriftPosture / evidence). Returns the
 * most recent probe per env; envs never probed are simply absent from the map.
 *
 * BOUNDED BY ENVIRONMENTS, NOT BY HISTORY. `environment_probes` is APPEND-ONLY — one row per
 * probe per env, forever, on a 10-minute production cadence — so the previous shape (read every
 * row for the project newest-first, keep the first one seen per env) transferred and discarded
 * the whole history on every reconcile render and every CLI call. A year of one production env
 * is ~52k rows to answer a question with one row in it, and it grows without limit while the
 * answer's size never changes.
 *
 * The bounded shape is a LATERAL: drive from `project_environments` and take `LIMIT 1` of that
 * env's probes. At most one probe row is read per environment, so the work is the size of the
 * ANSWER. The join is the reason it is per-environment and not a project-wide `DISTINCT ON`:
 * the only index on this table is `idx_environment_probes_env_time` on
 * `(environment_id, probed_at DESC)`, which a correlated `WHERE environment_id = … ORDER BY
 * probed_at DESC LIMIT 1` uses directly. A project-wide `DISTINCT ON (environment_id)` would
 * need a `(project_id, environment_id, probed_at DESC)` index — a migration — to avoid scanning
 * the project's whole history again, which is the cost being removed.
 *
 * INNER, so an env with no probe row contributes nothing and stays absent from the map — the
 * same contract the dedupe loop had, and the reason the caller's `probesByEnv.get(id)` miss
 * still means "never probed".
 *
 * `environmentIds` narrows the read to one page of environments; omit it for the whole project.
 * An EMPTY array means "no environments asked for" and returns an empty map without a query —
 * not "all of them", which is the mistake an `inArray(col, [])` would quietly make expensive.
 */
export async function getLatestProbesByEnv(
	projectId: string,
	orgId: string,
	environmentIds?: readonly string[],
): Promise<Map<string, ProbeState>> {
	if (environmentIds !== undefined && environmentIds.length === 0) {
		return new Map();
	}
	const rows = await latestProbesQuery(projectId, orgId, environmentIds);

	const latest = new Map<string, ProbeState>();
	for (const r of rows) {
		latest.set(r.environment_id, {
			reachable: r.reachable,
			message: r.message,
			probedAt: r.probed_at.toISOString(),
		});
	}
	return latest;
}

/**
 * The bounded latest-state SELECT behind {@link getLatestProbesByEnv}, unexecuted.
 *
 * Exported so the integration suite can `EXPLAIN` the statement this module actually issues
 * rather than a hand-typed copy of it — the whole claim of this shape is a PLAN (one index
 * lookup per environment, no sort of the history), and a plan assertion written against a copy
 * stops describing the code the first time the two drift.
 */
export function latestProbesQuery(
	projectId: string,
	orgId: string,
	environmentIds?: readonly string[],
) {
	const db = getServiceDb();
	// Correlated on project_environments.id — legal only inside a LATERAL join, which is why
	// this subquery is not usable as a plain sub-select.
	const latestProbe = db
		.select({
			reachable: environmentProbes.reachable,
			message: environmentProbes.message,
			probed_at: environmentProbes.probed_at,
		})
		.from(environmentProbes)
		.where(eq(environmentProbes.environment_id, projectEnvironments.id))
		// `desc nulls last`, NOT drizzle's `desc()`. Postgres defaults a DESC sort to NULLS FIRST
		// while `CREATE INDEX … DESC` — the form drizzle emitted for idx_environment_probes_env_time
		// — is DESC NULLS LAST, and the two are not interchangeable to the planner even though
		// probed_at is NOT NULL. Mismatched, this reads the env's whole history and sorts it, which
		// is the cost the LATERAL exists to remove. See pageOrder() in lib/cli/paging.ts for the
		// measurement that established this.
		.orderBy(sql`${environmentProbes.probed_at} desc nulls last`)
		.limit(1)
		.as("latest_probe");

	return db
		.select({
			environment_id: projectEnvironments.id,
			reachable: latestProbe.reachable,
			message: latestProbe.message,
			probed_at: latestProbe.probed_at,
		})
		.from(projectEnvironments)
		.innerJoin(projects, eq(projectEnvironments.project_id, projects.id))
		.innerJoinLateral(latestProbe, sql`true`)
		.where(
			and(
				eq(projectEnvironments.project_id, projectId),
				eq(projects.org_id, orgId),
				environmentIds === undefined
					? undefined
					: inArray(projectEnvironments.id, [...environmentIds]),
			),
		);
}
