// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { Edge, Node } from "@xyflow/react";
import type { CloudProviderSlug } from "@/lib/cloud-providers";
import type { ProjectFormData } from "@/lib/validations/project-form.schema";
import type { VerifyReport } from "@/types/jsonb.types";

/**
 * Node kinds in the Milestone-2a canvas slice. "project" is the fixed root that
 * carries the project basics (name/region/environment) and the CORE cloud
 * identity every other node inherits from.
 */
export type NodeKind =
	| "project"
	| "cluster"
	| "network"
	| "database"
	| "dns"
	| "cache"
	| "queue"
	| "topic"
	| "nosql"
	| "secret"
	| "repositories"
	| "chart";

/**
 * A bring-your-own Helm chart node's config. Unlike every other kind, this is NOT a
 * `ProjectFormData` fragment — chart nodes are persisted out-of-band in `project_addons`
 * (via `attachByoChart`) and loaded from `getProjectByoCharts`, so they never round-trip
 * through the form graph (`graphToForm` ignores them; the Pending Changes diff skips them).
 */
export type ByoChartNodeConfig = {
	/** The chart id / slug (also the `addon_id`); its display name on the node. */
	id: string;
	repoUrl: string;
	chartPath: string;
	ref: string;
	namespace: string;
	/** Persisted component status (PENDING/CREATING/ACTIVE/FAILED). */
	status?: string;
	/** ArgoCD health read back after deploy (Healthy/Progressing/Degraded/Missing/Unknown). */
	health?: string | null;
	/** ArgoCD sync state (Synced/OutOfSync/Unknown). */
	sync?: string | null;
	/** Chart-safety scan lifecycle (unscanned/scanning/done/failed). */
	scanStatus?: string;
	/** The elench verify.Report over the chart's rendered manifests (null until scanned). */
	scanReport?: VerifyReport | null;
};

/**
 * The typed `config` shape carried by each node kind — every one is exactly its
 * matching ProjectFormData fragment (derived, so it can never drift from the zod
 * schema). The `project` root diverges: it carries the scanned `source_repos`
 * (a top-level form field, not part of the project sub-schema) and drops
 * `cloud_identity_id` (which lives on the node's own `data.cloud_identity_id`).
 */
export type NodeConfigMap = {
	project: Pick<
		ProjectFormData["project"],
		"project_name" | "environment_stage" | "region" | "iac_version"
	> & { source_repos?: ProjectFormData["source_repos"] };
	network: ProjectFormData["network"];
	cluster: ProjectFormData["cluster"];
	dns: ProjectFormData["dns"];
	repositories: ProjectFormData["repositories"];
	database: ProjectFormData["databases"][number];
	cache: ProjectFormData["caches"][number];
	queue: ProjectFormData["queues"][number];
	topic: ProjectFormData["topics"][number];
	nosql: ProjectFormData["nosql_tables"][number];
	secret: ProjectFormData["secrets"][number];
	// Out-of-band (not a ProjectFormData fragment) — see ByoChartNodeConfig.
	chart: ByoChartNodeConfig;
};

/** The config type for a single node kind (or the union across all kinds). */
export type NodeConfig<K extends NodeKind = NodeKind> = NodeConfigMap[K];

/**
 * Data carried on every React Flow node, as a discriminated union keyed by `kind`:
 * `config` is the resource configuration typed to its ProjectFormData fragment;
 * `cloud_identity_id` is the node's own placement (null = inherit the project root's
 * CORE identity); `provider` is derived from the effective identity and used only
 * for UI/option-table lookups. Parameterise (`CanvasNodeData<"cache">`) to narrow to
 * a single kind — the default is the full union.
 */
export type CanvasNodeData<K extends NodeKind = NodeKind> = {
	[P in K]: {
		kind: P;
		config: NodeConfigMap[P];
		cloud_identity_id: string | null;
		provider: CloudProviderSlug | null;
	};
}[K];

export type CanvasNode<K extends NodeKind = NodeKind> = Node<CanvasNodeData<K>>;
export type CanvasEdge = Edge;
