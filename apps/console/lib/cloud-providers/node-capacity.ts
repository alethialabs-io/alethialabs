// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { ClusterProviderConfig } from "@/types/jsonb.types";
import type { CloudProviderSlug } from "./generated/catalog";

/**
 * A cluster's node capacity type (`project_cluster.capacity_type`) on each cloud (#5266, #5315).
 *
 * "Run my nodes on Spot" is one field everywhere, and each cloud's provider in `packages/core/cloud`
 * maps it onto its template's own knob:
 *
 *   aws      `eks_ng_capacity_type` — the managed node group itself
 *   gcp      `gke_spot` — the node pool (not on Autopilot, which has no node pool)
 *   azure    `aks_spot_enabled` — a SEPARATE Spot worker pool; AKS refuses a Spot system pool
 *   alibaba  `ack_node_capacity_type` — the worker pool's `spot_strategy`
 *   hetzner  nothing: Hetzner Cloud sells no interruptible servers, and ValidateConfig refuses spot
 *
 * This module is the console's half of that table: which clouds offer the choice and what Spot means
 * on each, so the inspector and the cross-cloud conversion read one answer.
 */

/** What the user reads under the Spot option on each cloud that offers it. */
export const SPOT_NOTE: Readonly<Partial<Record<CloudProviderSlug, string>>> = {
	aws: "Cheaper, but AWS can reclaim a node with two minutes' notice.",
	gcp: "Cheaper, but Google Cloud can reclaim a node with 30 seconds' notice.",
	azure:
		"Adds a separate Spot worker pool that scales from zero. AKS cannot run its system pool on Spot, so that pool stays on-demand. Azure can evict a Spot node with 30 seconds' notice, and only pods that tolerate the Spot taint run there.",
	alibaba: "Cheaper, but Alibaba Cloud can reclaim a node with five minutes' notice.",
};

/** True when the cloud maps `capacity_type = spot` onto a template knob. */
export function supportsSpot(provider: CloudProviderSlug): boolean {
	return SPOT_NOTE[provider] !== undefined;
}

/**
 * The capacity type a cluster's config actually deploys with, for display.
 *
 * The column wins when set. While it is unset, a Spot knob set by hand through `provider_config`
 * before the field owned it still applies — the Go providers carry it verbatim so a running Spot pool
 * is not replaced — so it is reported here too, rather than showing "On-demand" over Spot nodes. AWS
 * has no such key: migration 0156 moved every hand-set `eks_ng_capacity_type` onto the column.
 */
export function effectiveCapacityType(cluster: {
	capacity_type?: "on_demand" | "spot" | null;
	provider_config?: ClusterProviderConfig | null;
}): "on_demand" | "spot" {
	if (cluster.capacity_type) return cluster.capacity_type;
	const pc = cluster.provider_config ?? {};
	const legacySpot =
		pc.gke_spot === true ||
		pc.gke_preemptible === true ||
		pc.aks_spot_enabled === true ||
		// provider_config is unvalidated JSONB, so the type is checked before it is read as a string.
		(typeof pc.ack_node_capacity_type === "string" && pc.ack_node_capacity_type.startsWith("Spot"));
	return legacySpot ? "spot" : "on_demand";
}
