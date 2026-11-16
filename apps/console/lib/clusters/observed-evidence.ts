// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The two later readings of a cluster the clusters list needs beside `project_cluster.status`
// (lib/clusters/observed-state.ts says why): each environment's latest drift scan and latest
// liveness probe.
//
// Service-role, like every other reader of these tables (app/server/actions/reconcile.ts,
// app/server/actions/drift.ts, lib/probes/persistence.ts): neither table carries an RLS policy for
// the app role. The scope is therefore stated here — the org's own environments, among the ids the
// caller already read through its RLS-enforced, PDP-narrowed cluster list.

import "server-only";

import { and, eq, inArray, sql } from "drizzle-orm";
import { getServiceDb } from "@/lib/db";
import { environmentDrift, environmentProbes, projectEnvironments, projects } from "@/lib/db/schema";
import type { DriftEvidence, ProbeEvidence } from "@/lib/clusters/observed-state";

/** Each environment's latest drift scan and latest probe, keyed by environment id. */
export interface ClusterEvidence {
	drift: Map<string, DriftEvidence>;
	probes: Map<string, ProbeEvidence>;
}

/** Reads the latest drift scan and probe of each of `environmentIds` in `orgId`. */
export async function readClusterEvidence(
	orgId: string,
	environmentIds: readonly string[],
): Promise<ClusterEvidence> {
	const drift = new Map<string, DriftEvidence>();
	const probes = new Map<string, ProbeEvidence>();
	if (environmentIds.length === 0) return { drift, probes };
	const db = getServiceDb();
	const ids = [...environmentIds];

	const latestProbe = db
		.select({
			reachable: environmentProbes.reachable,
			message: environmentProbes.message,
			probed_at: environmentProbes.probed_at,
			detail: environmentProbes.detail,
		})
		.from(environmentProbes)
		.where(eq(environmentProbes.environment_id, projectEnvironments.id))
		// `desc nulls last` to match idx_environment_probes_env_time (see lib/probes/persistence.ts).
		.orderBy(sql`${environmentProbes.probed_at} desc nulls last`)
		.limit(1)
		.as("latest_probe");

	const [driftRows, probeRows] = await Promise.all([
		// One row per (project, environment): the table is latest-wins (unique key).
		db
			.select({
				environment_id: environmentDrift.environment_id,
				details: environmentDrift.details,
				scanned_at: environmentDrift.scanned_at,
			})
			.from(environmentDrift)
			.innerJoin(projects, eq(environmentDrift.project_id, projects.id))
			.where(and(eq(projects.org_id, orgId), inArray(environmentDrift.environment_id, ids))),
		db
			.select({
				environment_id: projectEnvironments.id,
				reachable: latestProbe.reachable,
				message: latestProbe.message,
				probed_at: latestProbe.probed_at,
				detail: latestProbe.detail,
			})
			.from(projectEnvironments)
			.innerJoin(projects, eq(projectEnvironments.project_id, projects.id))
			.innerJoinLateral(latestProbe, sql`true`)
			.where(and(eq(projects.org_id, orgId), inArray(projectEnvironments.id, ids))),
	]);

	for (const r of driftRows) {
		if (!r.environment_id) continue;
		drift.set(r.environment_id, { scannedAt: r.scanned_at.toISOString(), details: r.details ?? [] });
	}
	for (const r of probeRows) {
		probes.set(r.environment_id, {
			reachable: r.reachable,
			probedAt: r.probed_at.toISOString(),
			message: r.message,
			gone: r.detail?.gone === true,
		});
	}
	return { drift, probes };
}
