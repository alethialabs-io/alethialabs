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
//   · the liveness probe (`environment_probes`, PROBE_CLUSTER) — scheduled for every environment
//     believed to hold a cluster, at a backed-off cadence when it is not ACTIVE
//     (lib/probes/dispatch.ts); its failure can POSITIVELY say the cluster is gone (`detail.gone`);
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
	/** The probe POSITIVELY showed the cluster is gone (`environment_probes.detail.gone`). */
	gone?: boolean;
}

/**
 * What may be said about a control plane.
 *
 *  · `missing` — a reading taken AFTER the last successful deploy shows the cluster gone: a drift
 *    scan reporting it (or the resource group holding it) deleted, or a probe whose failure was a
 *    cloud "not found" (`source` says which; `deleted` lists a scan's addresses).
 *  · `unreachable` — a liveness probe taken after the last successful deploy could not reach it.
 *  · `reported` — nothing contradicts the recorded status; `observedAt` is the newest reading that
 *    backs it (the deploy, or a probe that reached it) and `fresh` says whether that reading is
 *    recent enough to repeat as current (see {@link freshnessWindowMs}).
 */
export type ControlPlaneObservation =
	| { kind: "missing"; source: "drift" | "probe"; observedAt: string; deleted: string[] }
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
	const deleted =
		input.drift && scannedAt !== null && sinceDeploy(scannedAt, deployedAt)
			? deletedControlPlaneResources(input.drift.details)
			: [];

	const probedAt = ms(input.probe?.probedAt);
	const probeCounts = input.probe !== null && probedAt !== null && sinceDeploy(probedAt, deployedAt);

	// The NEWEST decisive reading wins: a scan that found the cluster deleted, unless a probe since
	// then reached it (it exists again, or the scan's deletion was wrong); a probe that found it gone.
	if (deleted.length > 0 && input.drift && scannedAt !== null) {
		const probeAfter = probeCounts && probedAt !== null && probedAt > scannedAt && input.probe?.reachable === true;
		if (!probeAfter) return { kind: "missing", source: "drift", observedAt: input.drift.scannedAt, deleted };
	}
	if (input.probe && probeCounts && !input.probe.reachable) {
		if (input.probe.gone) {
			return { kind: "missing", source: "probe", observedAt: input.probe.probedAt, deleted: [] };
		}
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
	"No kubeconfig is offered: Alethia's latest check found this cluster deleted outside Alethia. Redeploy the environment to recreate it, or tear it down.";

/**
 * The observation as the CLI receives it (`GET /api/cli/clusters/:id`, `alethia cluster get`): flat,
 * so the terminal can print it without re-deriving anything. `state` is the word both surfaces show.
 */
export interface ObservationWire {
	state: "missing" | "unreachable" | "unverified" | "observed" | "never_observed";
	observed_at: string | null;
	source: "drift" | "probe" | "deploy" | null;
	/** One line of what was seen: the deleted addresses, or the probe's message. */
	detail: string | null;
}

/** Flattens an observation for the CLI wire. */
export function observationWire(o: ControlPlaneObservation): ObservationWire {
	switch (o.kind) {
		case "missing":
			return {
				state: "missing",
				observed_at: o.observedAt,
				source: o.source,
				detail: o.deleted.length > 0 ? `deleted: ${o.deleted.join(", ")}` : "the cloud reports the cluster not found",
			};
		case "unreachable":
			return { state: "unreachable", observed_at: o.observedAt, source: "probe", detail: o.message };
		case "reported":
			if (o.observedAt === null) return { state: "never_observed", observed_at: null, source: null, detail: null };
			return { state: o.fresh ? "observed" : "unverified", observed_at: o.observedAt, source: o.source, detail: null };
	}
}
