"use server";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Live cluster-alive signal (BYOC B2) — the "is it still up?" half of day-2, alongside drift
// ("has it diverged?"). A PROBE_CLUSTER job dials the env's cluster API server and the runner
// posts a ProbeResult on execution_metadata.probe_result; the job-status route ingests it here.
// Unlike environment_drift (one upserted latest-posture row per env), environment_probes is an
// APPEND-ONLY history — every probe is a new row so a true→false liveness transition and its
// timing are durably recorded. recordProbeResult persists the row and reports whether this
// result was a true→false transition (the ingest route emits the outage alert on that). Service
// role only (getServiceDb, RLS-bypassing) — mirrors recordDriftPosture.

import { and, desc, eq } from "drizzle-orm";
import { getServiceDb } from "@/lib/db";
import { environmentProbes, projects } from "@/lib/db/schema";
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
 * for getEnvReconcileStates.probe. `environment_probes` is an RLS-less project-child table, so
 * the org boundary is enforced HERE by joining to the parent project and filtering on org
 * (mirrors getLatestDriftPosture / evidence). Returns the most recent probe per env; envs never
 * probed are simply absent from the map.
 */
export async function getLatestProbesByEnv(
	projectId: string,
	orgId: string,
): Promise<Map<string, ProbeState>> {
	const db = getServiceDb();
	// Newest-first across the project; the first row seen per env is its latest (the
	// idx_environment_probes_env_time index serves this order).
	const rows = await db
		.select({
			environment_id: environmentProbes.environment_id,
			reachable: environmentProbes.reachable,
			message: environmentProbes.message,
			probed_at: environmentProbes.probed_at,
		})
		.from(environmentProbes)
		.innerJoin(projects, eq(environmentProbes.project_id, projects.id))
		.where(
			and(
				eq(environmentProbes.project_id, projectId),
				eq(projects.org_id, orgId),
			),
		)
		.orderBy(desc(environmentProbes.probed_at));

	const latest = new Map<string, ProbeState>();
	for (const r of rows) {
		if (latest.has(r.environment_id)) continue; // newest-first ⇒ first seen is latest
		latest.set(r.environment_id, {
			reachable: r.reachable,
			message: r.message,
			probedAt: r.probed_at.toISOString(),
		});
	}
	return latest;
}
