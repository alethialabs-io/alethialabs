// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// WHAT THE CONSOLE HAS ACTUALLY OBSERVED OF A CLUSTER'S CONTROL PLANE (#6736).
//
// `project_cluster.status` is written by exactly one thing: a successful DEPLOY's writeback
// (lib/jobs/finalize-deployment.ts sets it ACTIVE; a successful DESTROY sets it DESTROYED). Nothing
// refreshes it afterwards. So "ACTIVE" on that column means "the last deploy that succeeded said so",
// at `project_environments.last_deployed_at` — not "it is running now". Two later signals can say
// more, and neither ever wrote back into that column:
//
//   · the liveness probe (`environment_probes`, PROBE_CLUSTER) — scheduled ONLY for ACTIVE
//     environments (lib/probes/dispatch.ts), so an environment stuck in flight is never probed;
//   · the drift scan (`environment_drift`, DETECT_DRIFT) — scheduled for every environment with a
//     successful deploy (lib/drift/dispatch.ts), whatever its status.
//
// This module decides, from those three readings, what a surface may honestly claim. It is pure (no
// I/O, no clock of its own) so the cluster card, the environment card and the list read agree, and
// so the rule is unit-tested rather than inferred from a screenshot.

import type { DriftDetail } from "@/types/jsonb.types";
import { PROBE_CADENCE_MS, tierForStage } from "@/lib/probes/schedule";

/**
 * Resource types whose DELETION means the cluster's control plane is gone: the managed cluster
 * resource itself on each cloud whose template provisions one, and the Azure resource group, which
 * holds the AKS cluster and everything beside it — deleting the group deletes them.
 *
 * Deliberately exact types, not prefixes: `azurerm_kubernetes_cluster_node_pool` or
 * `aws_eks_addon` going missing is drift, not a missing control plane. Not covered: Hetzner, whose
 * control plane is a set of `hcloud_server`s with no single resource that names it — a deleted
 * server there stays an ordinary drift finding, which the environment's "Drifted" badge still shows.
 */
export const CONTROL_PLANE_RESOURCE_TYPES: ReadonlySet<string> = new Set([
	"aws_eks_cluster",
	"google_container_cluster",
	"azurerm_kubernetes_cluster",
	"alicloud_cs_managed_kubernetes",
	"azurerm_resource_group",
]);

/** The addresses of the drifted resources whose deletion takes the control plane with it. */
export function deletedControlPlaneResources(details: readonly DriftDetail[] | null | undefined): string[] {
	return (details ?? [])
		.filter((d) => d.kind === "deleted" && CONTROL_PLANE_RESOURCE_TYPES.has(d.type))
		.map((d) => d.address);
}

/** The latest drift scan of an environment, as far as this rule needs it. */
export interface DriftEvidence {
	scannedAt: string;
	details: readonly DriftDetail[];
}

/** The latest liveness probe of an environment. */
export interface ProbeEvidence {
	reachable: boolean;
	probedAt: string;
	message: string | null;
}

/**
 * What may be said about a control plane.
 *
 *  · `missing` — a drift scan taken AFTER the last successful deploy reports the cluster (or the
 *    resource group holding it) deleted.
 *  · `unreachable` — a liveness probe taken after the last successful deploy could not reach it.
 *  · `reported` — nothing contradicts the recorded status; `observedAt` is the newest reading that
 *    backs it (the deploy, or a probe that reached it) and `fresh` says whether that reading is
 *    recent enough to repeat as current (see {@link freshnessWindowMs}).
 */
export type ControlPlaneObservation =
	| { kind: "missing"; observedAt: string; deleted: string[] }
	| { kind: "unreachable"; observedAt: string; message: string | null }
	| { kind: "reported"; observedAt: string | null; source: "deploy" | "probe"; fresh: boolean };

/**
 * How long a reading may be repeated as current: two probe intervals for the environment's tier
 * (lib/probes/schedule.ts PROBE_CADENCE_MS — 20m prod, 2h staging, 12h dev). Within that window a
 * live environment's prober has had a full interval to contradict the reading and has not; past it,
 * nothing has looked, and the card says when it last did instead of saying "healthy".
 */
export function freshnessWindowMs(stage: string | null | undefined): number {
	return 2 * PROBE_CADENCE_MS[tierForStage(stage)];
}

/** Milliseconds since the epoch of an ISO stamp, or null for an absent/unparseable one. */
function ms(at: string | null | undefined): number | null {
	if (!at) return null;
	const t = Date.parse(at);
	return Number.isNaN(t) ? null : t;
}

/** Whether a reading at `at` is not older than the last successful deploy (null deploy = any reading). */
function sinceDeploy(at: number, deployedAt: number | null): boolean {
	return deployedAt === null || at >= deployedAt;
}

/**
 * Derives what may be said about a control plane from its last successful deploy, its latest drift
 * scan and its latest probe, as of `now`. A reading older than the last deploy is ignored: the
 * deploy replaced whatever it saw (a redeploy recreates a deleted cluster).
 */
export function observeControlPlane(input: {
	lastDeployedAt: string | null;
	stage: string | null;
	drift: DriftEvidence | null;
	probe: ProbeEvidence | null;
	now: Date;
}): ControlPlaneObservation {
	const deployedAt = ms(input.lastDeployedAt);

	const scannedAt = ms(input.drift?.scannedAt);
	if (input.drift && scannedAt !== null && sinceDeploy(scannedAt, deployedAt)) {
		const deleted = deletedControlPlaneResources(input.drift.details);
		if (deleted.length > 0) return { kind: "missing", observedAt: input.drift.scannedAt, deleted };
	}

	const probedAt = ms(input.probe?.probedAt);
	const probeCounts = input.probe !== null && probedAt !== null && sinceDeploy(probedAt, deployedAt);
	if (input.probe && probeCounts && !input.probe.reachable) {
		return { kind: "unreachable", observedAt: input.probe.probedAt, message: input.probe.message };
	}

	const source = input.probe && probeCounts ? "probe" : "deploy";
	const observedAt = source === "probe" && input.probe ? input.probe.probedAt : input.lastDeployedAt;
	const at = ms(observedAt);
	const fresh = at !== null && input.now.getTime() - at <= freshnessWindowMs(input.stage);
	return { kind: "reported", observedAt, source, fresh };
}

/**
 * The sentence shown in place of a kubeconfig command for a cluster whose control plane a drift
 * scan reports deleted — the command would point at a cluster (or resource group) that is gone.
 */
export const KUBECONFIG_MISSING_CLUSTER_NOTE =
	"No kubeconfig is offered: the latest drift scan reports this cluster deleted outside Alethia. Redeploy the environment to recreate it, or tear it down.";
