// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// One cluster list entry for the clusters component tests, with every field the table and the
// drawer read. A test overrides what it is about.

import type { ControlPlaneObservation } from "@/lib/clusters/observed-state";
import type { ClusterListItem } from "@/lib/rpc/procedures/clusters";

export const PROJECT = "11111111-1111-4111-8111-111111111111";
export const ENV = "22222222-2222-4222-8222-222222222222";
export const SCANNED = "2026-11-09T00:00:00.000Z";

export const MISSING: ControlPlaneObservation = {
	kind: "missing",
	source: "drift",
	observedAt: SCANNED,
	deleted: ["aws_eks_cluster.main"],
};
export const REPORTED: ControlPlaneObservation = { kind: "reported", observedAt: SCANNED, source: "probe", fresh: true };
export const UNREACHABLE: ControlPlaneObservation = {
	kind: "unreachable",
	observedAt: SCANNED,
	message: "dial tcp 10.0.0.1:443: i/o timeout",
};

/** What a test may override: top-level fields, and fields of the nested cluster. */
export type ClusterOverrides = Partial<Omit<ClusterListItem, "project_cluster">> & {
	project_cluster?: Partial<ClusterListItem["project_cluster"]>;
};

/** A healthy AWS cluster of project "shop", environment "production", unless overridden. */
export function clusterItem(over: ClusterOverrides = {}): ClusterListItem {
	const { project_cluster, ...rest } = over;
	return {
		id: PROJECT,
		project_name: "shop",
		project_slug: "shop",
		region: "eu-central-1",
		environment_id: ENV,
		environment_stage: "production",
		status: "ACTIVE",
		status_since: "2026-11-01T00:00:00.000Z",
		cloud_identities: { provider: "aws" },
		project_databases: [],
		project_caches: [],
		project_dns: null,
		apps_destination_repo: null,
		can_download_kubeconfig: false,
		kubeconfig_download_note: null,
		classification: [],
		last_job_id: null,
		...rest,
		project_cluster: {
			id: "cluster-1",
			created_at: "2026-11-01T00:00:00.000Z",
			cluster_name: "shop-prod",
			cluster_endpoint: null,
			cluster_arn: null,
			cluster_version: null,
			k8s_version: null,
			argocd_url: null,
			status: "ACTIVE",
			observation: REPORTED,
			kubeconfig: { command: null, alternative: null, note: null },
			...project_cluster,
		},
	};
}
