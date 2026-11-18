// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// No "use client" and no server imports: the card (client), its skeleton and the clusters routes'
// `loading.tsx` (server) all read this module, so a card and its placeholder are drawn from one
// answer to "which blocks does this cluster's card have".

import { statusTier } from "@repo/ui/status-badge";
import type { ClusterListItem } from "@/lib/rpc/procedures/clusters";

/** The card's outer frame — `ClusterCard` and its placeholder both take it. */
export const CLUSTER_CARD_FRAME = "flex flex-col gap-3.5 rounded-lg border bg-surface p-[18px] shadow-sm";

/** One component row's box (control plane, a database, a cache, DNS) — the card's and the placeholder's. */
export const CLUSTER_COMPONENT_ROW = "flex items-center gap-2.5 py-2 first:pt-0 last:pb-0";

/** A titled block under the component rows (cluster access, ArgoCD). */
export const CLUSTER_CARD_BLOCK = "flex flex-col gap-1.5 border-t pt-3";

/** The "last observed" lines under the component rows (#6736). */
export const CLUSTER_OBSERVED_BLOCK = "flex flex-col gap-0.5";

/** The grid the cards sit in — the grid's render and the skeleton's. */
export const CLUSTERS_GRID = "grid grid-cols-1 gap-4 lg:grid-cols-2";

/**
 * Which blocks one cluster's card draws, and how many rows each has — the card's own conditions,
 * restated over the same fields. The skeleton draws a placeholder from it; the unit tests render
 * `ClusterCard` over the same rows and count its blocks against it, so a condition changed in one
 * place and not the other fails there rather than as a layout shift.
 */
export interface ClusterCardShape {
	/** The PROJECT's id — the project route keeps only its own project's cards. */
	projectId: string;
	/** Component rows: the control plane, each database, each cache, and the DNS row when there is one. */
	components: number;
	/** The cluster-access block, or null when the cluster has no endpoint yet. */
	access: {
		/** Code rows with a copy button: the endpoint, the kubeconfig command, the cloud-CLI alternative. */
		codeRows: number;
		/** One-line captions: "Or, with access to the cloud account:", the no-command note, the download note. */
		captions: number;
		/** Whether the read-only kubeconfig download button renders. */
		download: boolean;
	} | null;
	/** Lines of the "last observed" block: one for the control plane's observation, and one more
	 *  saying since when a run has been in flight (#6736). */
	observed: number;
	/** Whether the ArgoCD block renders. */
	argocd: boolean;
	/** Whether the DNS row renders (it is counted in `components`). */
	dns: boolean;
	/** Whether the missing-cluster actions render (redeploy, tear down, mark as destroyed — #6736). */
	resolve: boolean;
}

/** The missing-cluster actions block's box — the card's and the placeholder's. */
export const CLUSTER_RESOLVE_BLOCK = "flex flex-col border-t pt-3";

/** Whether the card says since when the environment's run has been in flight. */
export function runInFlight(envStatus: string): boolean {
	return statusTier(envStatus) === "pending";
}

/**
 * Whether the card offers the missing-cluster actions: the control plane is observed missing, its
 * environment is known, and no run is in flight on it — a run in flight will write its own outcome,
 * and the mark would be refused while it runs.
 */
export function offersMissingActions(data: ClusterListItem): boolean {
	return (
		data.project_cluster.observation.kind === "missing" && data.environment_id !== null && !runInFlight(data.status)
	);
}

/** The blocks `ClusterCard` draws for one cluster (see `ClusterCardShape`). */
export function clusterCardShape(data: ClusterListItem): ClusterCardShape {
	const cluster = data.project_cluster;
	const dns = Boolean(data.project_dns?.domain_name);
	const command = Boolean(cluster.kubeconfig.command);
	const alternative = command && Boolean(cluster.kubeconfig.alternative);
	const note = !command && Boolean(cluster.kubeconfig.note);
	return {
		projectId: data.id,
		components: 1 + data.project_databases.length + data.project_caches.length + (dns ? 1 : 0),
		access: cluster.cluster_endpoint
			? {
					codeRows: 1 + (command ? 1 : 0) + (alternative ? 1 : 0),
					captions: (alternative ? 1 : 0) + (note ? 1 : 0) + (data.kubeconfig_download_note ? 1 : 0),
					download: data.can_download_kubeconfig,
				}
			: null,
		observed: 1 + (runInFlight(data.status) ? 1 : 0),
		argocd: Boolean(cluster.argocd_url),
		dns,
		resolve: offersMissingActions(data),
	};
}
