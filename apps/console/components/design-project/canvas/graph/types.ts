// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { Edge, Node } from "@xyflow/react";
import type { ChartWorkloadKind } from "@/lib/db/schema";
import type { IacMember } from "@/lib/canvas/iac-inventory";
import type { CloudProviderSlug } from "@/lib/cloud-providers";
import type { ProjectFormData } from "@/lib/validations/project-form.schema";
import type {
	ChartValuePathMap,
	ChartWorkloadConfig,
	ChartWorkloadRendered,
	ServiceBinding,
	VerifyReport,
} from "@/types/jsonb.types";

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
	| "bucket"
	| "registry"
	| "service"
	| "repositories"
	| "chart"
	| "chart_workload"
	| "addon"
	| "external";

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
 * A DESCRIBED chart workload (W5 Path A — Option B): one node per workload the owning BYO chart
 * renders (`getProjectChartWorkloads` → `project_chart_workloads`). Out-of-band like `chart`, and
 * DELIBERATELY NOT a `ProjectFormData["services"]` fragment — a described workload is read-mostly and
 * can never enter the deploy path (the chart addon stays the single deploy unit). Two models, kept
 * apart: this is the reason chart-workload nodes are visually and behaviorally distinct from the
 * first-class `service` node.
 *
 * `rendered` is the immutable description (`helm template` output — env is KEY NAMES only, never a
 * value), overwritten wholesale on every re-scan. `bindings`/`config`/`value_paths` are the user
 * overlay, preserved across re-scans: bindings speak the W3 `ServiceBinding` vocabulary; config is the
 * v1 editable `replicas`/`env`; value_paths maps a logical knob → the chart-values dot-path it writes
 * to. The overlay reaches the running chart on Lane 2 (#664) at `resolveByoChartInstall`; this node
 * only reads + stages it.
 */
export type ChartWorkloadNodeConfig = {
	/** The `project_chart_workloads` row id. */
	id: string;
	/** The owning chart node's slug (`project_addons.addon_id`) — the parent `chart-${chartId}` node. */
	chartId: string;
	/** The rendered workload's metadata.name (unique within its chart). */
	name: string;
	/** Which workload kind the chart renders (deployment|statefulset|daemonset|cronjob|job). */
	kind: ChartWorkloadKind;
	/** Read-only description from the render — overwritten each scan. */
	rendered: ChartWorkloadRendered;
	/** W3 bindings to backing resources (user overlay, preserved across re-scans). */
	bindings: ServiceBinding[];
	/** Editable overlay: replicas + env (user overlay, preserved across re-scans). */
	config: ChartWorkloadConfig;
	/** Logical knob → chart-values dot-path (auto-inferred + user-overridable; preserved). */
	valuePaths: ChartValuePathMap;
};

/**
 * One card of a bring-your-own IaC module: every resource of one kind, in one Terraform
 * module. Out-of-band like `chart`/`addon` — derived server-side from the module's IAC_SCAN
 * inventory (or, once planned, its plan's `resource_changes`), never written by `graphToForm`
 * and never in the Deploy diff. Read-only: Alethia plans, prices, drifts and audits these,
 * but does not own their definition, which is exactly what the dashed EXTERNAL rule says.
 *
 * The shape mirrors `IacGroup` (lib/canvas/iac-inventory.ts) — that module is the source of
 * truth for how resources become groups.
 */
export type ExternalNodeConfig = {
	/** `${kind ?? "other"}|${module}` — stable across refetches. */
	key: string;
	/** The canvas kind this group reads as; null → the honest `Other` bucket. */
	mappedKind: NodeKind | null;
	/** Module path prefix — "" for the root module, else "module.vpc". */
	module: string;
	/** Whether the addresses are a plan's (exact) or the static scan's (declared). */
	source: "plan" | "scan";
	/** The group's resources, sorted by address. */
	members: IacMember[];
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
	bucket: ProjectFormData["storage_buckets"][number];
	registry: ProjectFormData["container_registries"][number];
	// W1 — a first-class application workload (the customer's own code), form-fragment like the
	// infra kinds so it round-trips the form graph. Infra-binding edges are W3.
	service: ProjectFormData["services"][number];
	// Out-of-band (not a ProjectFormData fragment) — see ByoChartNodeConfig.
	chart: ByoChartNodeConfig;
	// Out-of-band (project_chart_workloads) — a workload DESCRIBED from a BYO chart; read-mostly,
	// deliberately distinct from `service`. See ChartWorkloadNodeConfig.
	chart_workload: ChartWorkloadNodeConfig;
	// Out-of-band (project_addons) — a marketplace add-on the cluster comes up with.
	addon: AddonNodeConfig;
	// Out-of-band (project_iac_sources + the last plan) — see ExternalNodeConfig.
	external: ExternalNodeConfig;
};

/**
 * An installed marketplace add-on (Grafana, Loki, Vault, …). Like chart nodes, these are persisted
 * out-of-band in `project_addons` and never round-trip through the form graph — `graphToForm` reads
 * only the kinds it knows, and the staged-change diff skips them.
 *
 * They were previously configured in a sheet and explicitly NOT graph nodes, so an installed Grafana
 * was invisible on the architecture — even though it is an ArgoCD Application with health and sync
 * already in the database.
 */
export type AddonNodeConfig = {
	/** The catalog id (`kube-prometheus-stack`) — also its name on the card. */
	id: string;
	name: string;
	/** Pinned chart version. */
	version: string;
	namespace: string;
	status?: string;
	/** ArgoCD health: Healthy | Progressing | Degraded | Missing | Unknown. */
	health?: string | null;
	/** ArgoCD sync state: Synced | OutOfSync | Unknown. */
	sync?: string | null;
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
		/**
		 * VIEW-ONLY: set on the RENDER node (never the store node) when the card is drawn inside a
		 * container region, so it renders the dense treatment. Never persisted, never set by the store,
		 * and ignored by `diffNodes` (config + cloud_identity_id) and `graphToForm` (config only).
		 */
		insideContainer?: boolean;
	};
}[K];

export type CanvasNode<K extends NodeKind = NodeKind> = Node<CanvasNodeData<K>>;
export type CanvasEdge = Edge;

/**
 * The node with the given `id`/lookup narrowed to `kind`, or undefined when it is absent or of
 * another kind. The one sanctioned seam for going from `CanvasNode | undefined` (what
 * `store.nodes.find` yields) to `CanvasNode<K>`: `CanvasNodeData<K>` is a distributed mapped type,
 * so TS can't prove a generic `data.kind === kind` compare narrows the `Node<…>` wrapper (nor that
 * `CanvasNode<K>` is assignable back to `CanvasNode`, TS2677) — the same discriminated-union limit
 * `buildNodeData` documents. Asserted once here so every caller stays cast-free.
 */
export function nodeOfKind<K extends NodeKind>(
	node: CanvasNode | undefined,
	kind: K,
): CanvasNode<K> | undefined {
	return node && node.data.kind === kind
		? (node as CanvasNode<K>)
		: undefined;
}
