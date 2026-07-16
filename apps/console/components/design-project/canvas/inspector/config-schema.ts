// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Data-driven configuration schema for the node inspector. Each node kind declares its Settings as
// collapsible SECTIONS of typed FIELDS, plus a one-line `summary` for the sheet header. The generic
// renderer (`config-fields.tsx`) turns this into UI, so a new resource kind needs only a schema
// entry here (+ its registry row) — no new inspector components. Dynamic, provider-specific option
// lists / bounds are expressed as functions of the field context.

import {
	CACHE_NODE_TYPES,
	DB_CAPACITY,
	getProvider,
	INSTANCE_TYPES,
	K8S_VERSIONS,
	NOSQL,
	type CloudProviderSlug,
} from "@/lib/cloud-providers";
import { variantOptionsFor } from "../graph/node-registry";
import type { NodeConfigMap, NodeKind } from "../graph/types";

/**
 * The field engine is generic over the node kind's config type `C`. Each per-kind
 * schema entry (CONFIG_SCHEMA below) is typed to its `NodeConfigMap` fragment, so the
 * `summary`/`get`/`set`/`visibleWhen` closures read fully-typed config — no casts. The
 * generic renderer (config-fields.tsx) and the inspector consume the widened default
 * (`Record<string, unknown>`) via `getKindConfig`, since the node kind is only known at
 * runtime there — that single erasure is the boundary inherent to a key-driven engine.
 */
type AnyConfig = Record<string, unknown>;

/** Context handed to every resolvable field attribute. */
export interface FieldCtx<C = AnyConfig> {
	provider: CloudProviderSlug | null;
	config: C;
}

/** A value that's either static or derived from the field context (provider/config). */
export type Resolvable<T, C = AnyConfig> = T | ((ctx: FieldCtx<C>) => T);

export interface FieldOption {
	value: string;
	label: string;
	description?: string;
}

export type FieldType =
	| "text"
	| "number"
	| "select"
	| "radio-card"
	| "switch"
	| "region"
	| "repository"
	// A `string[]` column — CIDR allow-lists, CORS origins, cluster admins, global replicas.
	| "list"
	// A typed row editor over a JSONB array of objects. First use: `topic.subscriptions`, a column
	// that has existed since the baseline migration with no way at all to edit it in the product.
	| "subresource";

/** A row editor over a JSONB array of objects. */
export interface SubresourceSpec {
	/** The fields shown for each row. Rows are plain records — the engine's erasure seam. */
	fields: FieldDef<Record<string, unknown>>[];
	/** A fresh row. */
	create: () => Record<string, unknown>;
	/** The row's heading. */
	title: (item: Record<string, unknown>, index: number) => string;
	/** Singular noun, for "Add a subscription". */
	singular: string;
}

export interface FieldDef<C = AnyConfig> {
	key: string;
	type: FieldType;
	label: string;
	description?: string;
	/** Monospace text input (names, CIDR, ids). */
	mono?: boolean;
	placeholder?: Resolvable<string, C>;
	unit?: Resolvable<string, C>;
	options?: Resolvable<FieldOption[], C>;
	min?: Resolvable<number, C>;
	max?: Resolvable<number, C>;
	step?: Resolvable<number, C>;
	/** Parse numeric input as float (default: int unless a fractional step is set). */
	float?: boolean;
	/** Number field backed by a NULLABLE column: clearing the input patches `null`
	 * ("use the default") instead of 0 — required for `min(1)`-bounded optional sizing
	 * fields, where 0 would block the save with no way back to the default. */
	optional?: boolean;
	/** Field needs an effective cloud provider; renders a notice when none is set. */
	requiresProvider?: boolean;
	/** Span the full section width (radio-card/region/repository/switch already do). */
	full?: boolean;
	/** Hide the field unless the predicate holds (e.g. only when a toggle is on, or only
	 * for a given provider via the context). One-arg closures keep working unchanged. */
	visibleWhen?: (config: C, ctx: FieldCtx<C>) => boolean;
	/** Normalize raw text input (e.g. lowercasing a name). */
	transform?: (raw: string) => string;
	/** Nested read escape hatch (e.g. `instance_types[0]`). */
	get?: (config: C) => unknown;
	/** Nested write escape hatch — returns the patch to merge into config. */
	set?: (value: unknown, config: C) => Partial<C>;
	/** `list` only: the shape of one row. */
	item?: { placeholder?: string; mono?: boolean };
	/** `subresource` only: the row editor's definition. */
	sub?: SubresourceSpec;
}

/**
 * A section's tier. Every column the database can store is definable, but TIERED, so the
 * cloud-indifferent design story survives contact with the long tail of per-cloud knobs:
 *
 *   essentials — the portable fields. What you'd set on any cloud.
 *   sizing     — capacity and scale.
 *   security   — access, encryption, admins.
 *   advanced   — PROVIDER-SPECIFIC knobs. Collapsed, and badged with the cloud it belongs to, so
 *                it's obvious you're leaving portable ground.
 */
export type SectionTier = "essentials" | "sizing" | "security" | "advanced";

export interface SectionDef<C = AnyConfig> {
	id: string;
	title: string;
	defaultOpen?: boolean;
	fields: FieldDef<C>[];
	/** Defaults to `essentials`. `advanced` collapses by default and shows a provider badge. */
	tier?: SectionTier;
	/** Only render for these clouds. A section for knobs that simply don't exist elsewhere. */
	providerScope?: CloudProviderSlug[];
}

export interface KindConfig<C = AnyConfig> {
	sections: SectionDef<C>[];
	/** One-line live summary for the sheet header (e.g. "PostgreSQL · 0.5–4 ACU"). */
	summary: (config: C, provider: CloudProviderSlug | null) => string;
}

/** Per-kind schema map: each entry typed to its NodeConfigMap fragment. */
type ConfigSchemaMap = { [K in NodeKind]?: KindConfig<NodeConfigMap[K]> };

// ── shared field helpers ────────────────────────────────────────────────────

/** A lowercase, monospace resource-name field. Generic so it slots into any kind's
 * typed field list (the config type is inferred from the surrounding schema entry). */
const nameField = <C = AnyConfig>(
	transform?: (v: string) => string,
): FieldDef<C> => ({
	key: "name",
	type: "text",
	label: "Name",
	mono: true,
	transform: transform ?? ((v) => v.toLowerCase()),
});

const CAPACITY_MODE_DESC: Record<string, string> = {
	on_demand: "Pay per request; scales automatically to traffic.",
	provisioned: "Fixed throughput; cheaper at steady, predictable load.",
};

/** Human label for the current DB engine family. */
function engineLabel(config: {
	engine_family?: string | null;
	engine?: string | null;
}): string {
	const fam =
		config.engine_family ??
		(typeof config.engine === "string" && config.engine.includes("mysql")
			? "mysql"
			: "postgres");
	return fam === "mysql" ? "MySQL" : "PostgreSQL";
}

// ── per-kind config ─────────────────────────────────────────────────────────

export const CONFIG_SCHEMA: ConfigSchemaMap = {
	project: {
		sections: [
			{
				id: "general",
				title: "General",
				defaultOpen: true,
				fields: [
					{
						key: "project_name",
						type: "text",
						label: "Project name",
						placeholder: "My Project",
					},
					{
						key: "environment_stage",
						type: "radio-card",
						label: "Environment",
						options: [
							{
								value: "development",
								label: "Development",
								description: "Ephemeral, low-cost defaults.",
							},
							{
								value: "staging",
								label: "Staging",
								description: "A pre-production mirror.",
							},
							{
								value: "production",
								label: "Production",
								description: "Live traffic; durable sizing.",
							},
						],
					},
				],
			},
			{
				id: "placement",
				title: "Placement",
				defaultOpen: true,
				fields: [
					{
						key: "region",
						type: "region",
						label: "Region",
						requiresProvider: true,
					},
				],
			},
		],
		summary: (c) => c.project_name || "Project",
	},

	// A first-class application workload (W1). Unlike the infra kinds it is cloud-indifferent — it
	// runs on the cluster, not a cloud account — so no field here is provider-gated. The `source`
	// discriminated union drives the repo-vs-image split: the Build section is repo-only and simply
	// renders nothing when the source is a prebuilt image (a section whose every field is hidden is
	// dropped). Backing-infra Bindings (W3) land in a follow-up — the flat row editor can't yet edit
	// their nested `inject[]`.
	service: {
		sections: [
			{
				id: "identity",
				title: "Identity",
				defaultOpen: true,
				fields: [
					nameField(),
					{
						key: "type",
						type: "radio-card",
						label: "Type",
						options: [
							{
								value: "deployment",
								label: "Deployment",
								description: "Long-running, load-balanced.",
							},
							{ value: "job", label: "Job", description: "Runs once to completion." },
							{ value: "cronjob", label: "CronJob", description: "Runs on a schedule." },
							{
								value: "statefulset",
								label: "StatefulSet",
								description: "Stable identity and storage.",
							},
						],
					},
				],
			},
			{
				id: "source",
				title: "Source",
				defaultOpen: true,
				fields: [
					{
						key: "source_kind",
						type: "radio-card",
						label: "Source",
						get: (c) => c.source.kind,
						// Switching branch resets to that branch's shape — the union carries only the
						// active branch's fields, so there is nothing of the other branch to preserve.
						set: (v) =>
							v === "image"
								? { source: { kind: "image", image: "" } }
								: { source: { kind: "repo", repo_url: "", path: "" } },
						options: [
							{
								value: "repo",
								label: "Repository",
								description: "Build from a Git repo. Keyless build & push.",
							},
							{
								value: "image",
								label: "Prebuilt image",
								description: "Deploy an existing image as-is.",
							},
						],
					},
					{
						key: "repo_url",
						type: "text",
						label: "Repository URL",
						mono: true,
						full: true,
						placeholder: "https://github.com/org/repo",
						visibleWhen: (c) => c.source.kind === "repo",
						get: (c) => (c.source.kind === "repo" ? c.source.repo_url : ""),
						set: (v, c) => ({
							source: {
								kind: "repo",
								repo_url: String(v),
								path: c.source.kind === "repo" ? c.source.path : "",
							},
						}),
					},
					{
						key: "source_path",
						type: "text",
						label: "Path",
						mono: true,
						placeholder: ".",
						description: "Subdirectory to build from.",
						visibleWhen: (c) => c.source.kind === "repo",
						get: (c) => (c.source.kind === "repo" ? c.source.path : ""),
						set: (v, c) => ({
							source: {
								kind: "repo",
								repo_url: c.source.kind === "repo" ? c.source.repo_url : "",
								path: String(v),
							},
						}),
					},
					{
						key: "image",
						type: "text",
						label: "Image",
						mono: true,
						full: true,
						placeholder: "ghcr.io/org/api:1.4.0",
						description: "A pushed image reference to deploy as-is.",
						visibleWhen: (c) => c.source.kind === "image",
						get: (c) => (c.source.kind === "image" ? c.source.image : ""),
						set: (v) => ({ source: { kind: "image", image: String(v) } }),
					},
				],
			},
			{
				id: "build",
				title: "Build",
				// Every field is repo-only, so the whole section drops away for a prebuilt image.
				fields: [
					{
						key: "build_dockerfile",
						type: "text",
						label: "Dockerfile",
						mono: true,
						placeholder: "Dockerfile",
						visibleWhen: (c) => c.source.kind === "repo",
						get: (c) => c.build?.dockerfile ?? "",
						set: (v, c) => ({
							build: { dockerfile: String(v) || undefined, context: c.build?.context },
						}),
					},
					{
						key: "build_context",
						type: "text",
						label: "Context",
						mono: true,
						placeholder: ".",
						visibleWhen: (c) => c.source.kind === "repo",
						get: (c) => c.build?.context ?? "",
						set: (v, c) => ({
							build: { dockerfile: c.build?.dockerfile, context: String(v) || undefined },
						}),
					},
				],
			},
			{
				id: "networking",
				title: "Networking",
				defaultOpen: true,
				fields: [
					{
						key: "ports",
						type: "subresource",
						label: "Ports",
						description: "Container ports this workload exposes.",
						sub: {
							singular: "port",
							create: () => ({ container_port: null, protocol: "TCP", name: "" }),
							title: (item) =>
								typeof item.name === "string" && item.name
									? item.name
									: item.container_port != null
										? String(item.container_port)
										: "",
							fields: [
								{
									key: "container_port",
									type: "number",
									label: "Container port",
									min: 1,
									max: 65535,
								},
								{
									key: "protocol",
									type: "select",
									label: "Protocol",
									options: [
										{ value: "TCP", label: "TCP" },
										{ value: "UDP", label: "UDP" },
									],
								},
								{
									key: "name",
									type: "text",
									label: "Name",
									mono: true,
									placeholder: "optional",
									full: true,
								},
							],
						},
					},
				],
			},
			{
				id: "environment",
				title: "Environment",
				defaultOpen: true,
				fields: [
					{
						key: "env",
						type: "subresource",
						label: "Variables",
						description: "Plain environment variables. Vault-backed secrets come in a later release.",
						sub: {
							singular: "variable",
							create: () => ({ name: "", value: "" }),
							title: (item) =>
								typeof item.name === "string" && item.name ? item.name : "",
							fields: [
								{ key: "name", type: "text", label: "Name", mono: true, full: true },
								{ key: "value", type: "text", label: "Value", full: true },
							],
						},
					},
				],
			},
			{
				id: "runtime",
				title: "Runtime",
				defaultOpen: true,
				fields: [
					{ key: "replicas", type: "number", label: "Replicas", min: 1, max: 5, full: true },
					{
						key: "requests_cpu",
						type: "text",
						label: "CPU request",
						mono: true,
						placeholder: "100m",
						get: (c) => c.resources?.requests?.cpu ?? "",
						set: (v, c) => ({
							resources: {
								requests: {
									cpu: String(v),
									memory: c.resources?.requests?.memory ?? "",
								},
								limits: c.resources?.limits ?? { cpu: "", memory: "" },
							},
						}),
					},
					{
						key: "requests_memory",
						type: "text",
						label: "Memory request",
						mono: true,
						placeholder: "128Mi",
						get: (c) => c.resources?.requests?.memory ?? "",
						set: (v, c) => ({
							resources: {
								requests: {
									cpu: c.resources?.requests?.cpu ?? "",
									memory: String(v),
								},
								limits: c.resources?.limits ?? { cpu: "", memory: "" },
							},
						}),
					},
					{
						key: "limits_cpu",
						type: "text",
						label: "CPU limit",
						mono: true,
						placeholder: "500m",
						get: (c) => c.resources?.limits?.cpu ?? "",
						set: (v, c) => ({
							resources: {
								requests: c.resources?.requests ?? { cpu: "", memory: "" },
								limits: {
									cpu: String(v),
									memory: c.resources?.limits?.memory ?? "",
								},
							},
						}),
					},
					{
						key: "limits_memory",
						type: "text",
						label: "Memory limit",
						mono: true,
						placeholder: "512Mi",
						get: (c) => c.resources?.limits?.memory ?? "",
						set: (v, c) => ({
							resources: {
								requests: c.resources?.requests ?? { cpu: "", memory: "" },
								limits: {
									cpu: c.resources?.limits?.cpu ?? "",
									memory: String(v),
								},
							},
						}),
					},
				],
			},
			{
				id: "health",
				title: "Health",
				fields: [
					{
						key: "probe_enabled",
						type: "switch",
						label: "Health check",
						description: "Gate rollout on a readiness probe.",
						get: (c) => c.probe != null,
						set: (v, c) => ({
							probe: v ? (c.probe ?? { type: "http", port: 8080 }) : null,
						}),
					},
					{
						key: "probe_type",
						type: "radio-card",
						label: "Probe type",
						visibleWhen: (c) => c.probe != null,
						get: (c) => c.probe?.type ?? "http",
						set: (v, c) => ({
							probe: {
								type: v as "http" | "tcp",
								path: c.probe?.path,
								port: c.probe?.port ?? 8080,
							},
						}),
						options: [
							{ value: "http", label: "HTTP", description: "Check an HTTP endpoint." },
							{ value: "tcp", label: "TCP", description: "Open a TCP connection." },
						],
					},
					{
						key: "probe_path",
						type: "text",
						label: "Path",
						mono: true,
						full: true,
						placeholder: "/healthz",
						visibleWhen: (c) => c.probe?.type === "http",
						get: (c) => c.probe?.path ?? "",
						set: (v, c) => ({
							probe: {
								type: c.probe?.type ?? "http",
								path: String(v),
								port: c.probe?.port ?? 8080,
							},
						}),
					},
					{
						key: "probe_port",
						type: "number",
						label: "Port",
						min: 1,
						max: 65535,
						placeholder: "8080",
						visibleWhen: (c) => c.probe != null,
						get: (c) => c.probe?.port ?? null,
						set: (v, c) => ({
							probe: {
								type: c.probe?.type ?? "http",
								path: c.probe?.path,
								port: v == null ? 8080 : Number(v),
							},
						}),
					},
				],
			},
		],
		summary: (c) => {
			const src = c.source.kind === "image" ? c.source.image : c.source.repo_url;
			const base = src ? src.replace(/\.git$/, "").split("/").filter(Boolean).pop() : "";
			return `${c.type} · ${c.replicas} replica${c.replicas === 1 ? "" : "s"}${
				base ? ` · ${base}` : ""
			}`;
		},
	},

	network: {
		sections: [
			{
				id: "provisioning",
				title: "Provisioning",
				defaultOpen: true,
				fields: [
					{
						key: "provision_network",
						type: "switch",
						label: "Provision a new network",
						description: "Create a fresh VPC/VNet, or attach to an existing one.",
					},
					{
						key: "cidr_block",
						type: "text",
						label: "CIDR block",
						mono: true,
						placeholder: "10.0.0.0/16",
						visibleWhen: (c) => c.provision_network !== false,
					},
					{
						key: "network_id",
						type: "text",
						label: "Existing network ID",
						mono: true,
						placeholder: "vpc-…",
						visibleWhen: (c) => c.provision_network === false,
					},
					{
						key: "single_nat_gateway",
						type: "switch",
						label: "Single NAT gateway",
						description: "One shared NAT (cheaper) vs one per availability zone.",
						visibleWhen: (c) => c.provision_network !== false,
					},
					{
						key: "allowed_cidr_blocks",
						type: "list",
						label: "Allowed CIDR blocks",
						description: "Extra networks permitted to reach resources in this VPC.",
						item: { mono: true, placeholder: "10.1.0.0/16" },
					},
				],
			},
		],
		summary: (c) =>
			c.provision_network === false
				? c.network_id || "existing network"
				: c.cidr_block || "new network",
	},

	cluster: {
		sections: [
			{
				id: "general",
				title: "General",
				defaultOpen: true,
				fields: [
					{
						key: "cluster_version",
						type: "select",
						label: "Kubernetes version",
						requiresProvider: true,
						options: ({ provider }) =>
							provider
								? K8S_VERSIONS[provider].map((v) => ({ value: v, label: v }))
								: [],
					},
					{
						key: "instance_types",
						type: "select",
						label: "Instance type",
						requiresProvider: true,
						get: (c) => c.instance_types?.[0] ?? "",
						set: (v) => ({ instance_types: [String(v)] }),
						options: ({ provider }) =>
							provider
								? INSTANCE_TYPES[provider].map((it) => ({
										value: it.value,
										label: `${it.label} · ${it.vcpu} vCPU / ${it.memoryGb} GB`,
									}))
								: [],
					},
				],
			},
			{
				id: "sizing",
				title: "Node sizing",
				tier: "sizing",
				defaultOpen: true,
				fields: [
					// The cloud-INDIFFERENT way to size: the Go resolver maps a capability to the nearest
					// per-cloud instance type at provision time. The panel has never exposed it, so the
					// only way to size a cluster was to pick a concrete SKU and lose portability.
					{
						key: "node_size_vcpu",
						type: "number",
						label: "vCPU per node",
						min: 1,
						max: 96,
						optional: true,
						placeholder: "2",
						description: "Portable sizing — mapped to the nearest instance type on any cloud.",
						get: (c) => c.node_size?.vcpu ?? null,
						set: (v, c) => ({
							node_size:
								v == null
									? undefined
									: { vcpu: Number(v), memory_gb: c.node_size?.memory_gb ?? 8 },
						}),
					},
					{
						key: "node_size_memory",
						type: "number",
						label: "Memory per node",
						unit: "GB",
						min: 1,
						max: 768,
						optional: true,
						placeholder: "8",
						get: (c) => c.node_size?.memory_gb ?? null,
						set: (v, c) => ({
							node_size:
								v == null
									? undefined
									: { vcpu: c.node_size?.vcpu ?? 2, memory_gb: Number(v) },
						}),
					},
					{ key: "node_min_size", type: "number", label: "Min nodes", min: 1, max: 100 },
					{
						key: "node_desired_size",
						type: "number",
						label: "Desired nodes",
						min: 1,
						max: 100,
					},
					{ key: "node_max_size", type: "number", label: "Max nodes", min: 1, max: 100 },
					{
						key: "node_disk_size_gb",
						type: "number",
						label: "Node disk",
						unit: "GB",
						min: 20,
						max: 2000,
						optional: true,
						placeholder: "per-cloud default",
						description: "Worker root volume. Empty uses the cloud's default (EKS 50 · GKE 50 · AKS 100).",
					},
				],
			},
			{
				id: "security",
				title: "Security",
				tier: "security",
				fields: [
					{
						key: "cluster_admins",
						type: "list",
						label: "Cluster admins",
						description:
							"Principals granted cluster-admin RBAC at create time — the mechanism the runner uses to authorize itself against the cluster it just built.",
						item: { mono: true, placeholder: "arn:aws:iam::…:role/platform-oncall" },
						// The column is `ClusterAdmin[]` ({ username, groups }). The list edits the
						// usernames; the group binding stays cluster-admin, which is the only thing this
						// mechanism grants. Existing groups on a row are preserved on edit.
						get: (c) => (c.cluster_admins ?? []).map((a) => a.username),
						set: (v, c) => {
							const existing = c.cluster_admins ?? [];
							return {
								cluster_admins: (v as string[]).map((username) => ({
									username,
									groups:
										existing.find((a) => a.username === username)?.groups ?? [
											"system:masters",
										],
								})),
							};
						},
					},
				],
			},
		],
		summary: (c) =>
			`k8s ${c.cluster_version ?? "—"} · ${c.node_min_size ?? 1}–${
				c.node_max_size ?? 1
			} nodes`,
	},

	database: {
		sections: [
			{
				id: "general",
				title: "General",
				defaultOpen: true,
				fields: [
					nameField(),
					{
						key: "engine_family",
						type: "radio-card",
						label: "Engine",
						// Provider-filtered via the registry's shared variant gate (Hetzner runs
						// databases in-cluster via CloudNativePG → postgres only).
						options: ({ provider }) => variantOptionsFor("database", provider),
					},
					{
						key: "port",
						type: "number",
						label: "Port",
						min: 1,
						max: 65535,
					},
				],
			},
			{
				id: "capacity",
				title: "Capacity",
				defaultOpen: true,
				fields: [
					{
						key: "min_capacity",
						type: "number",
						label: "Min capacity",
						float: true,
						requiresProvider: true,
						// Serverless capacity units (ACU/vCPU) are meaningless for the in-cluster
						// CloudNativePG path — Hetzner sizes via the In-cluster sizing section.
						visibleWhen: (_c, { provider }) => provider !== "hetzner",
						unit: ({ provider }) => (provider ? DB_CAPACITY[provider].unit : ""),
						min: ({ provider }) => (provider ? DB_CAPACITY[provider].min : 0),
						max: ({ provider }) => (provider ? DB_CAPACITY[provider].max : 0),
						step: ({ provider }) => (provider ? DB_CAPACITY[provider].step : 1),
					},
					{
						key: "max_capacity",
						type: "number",
						label: "Max capacity",
						float: true,
						requiresProvider: true,
						visibleWhen: (_c, { provider }) => provider !== "hetzner",
						unit: ({ provider }) => (provider ? DB_CAPACITY[provider].unit : ""),
						min: ({ provider }) => (provider ? DB_CAPACITY[provider].min : 0),
						max: ({ provider }) => (provider ? DB_CAPACITY[provider].max : 0),
						step: ({ provider }) => (provider ? DB_CAPACITY[provider].step : 1),
					},
				],
			},
			{
				id: "in-cluster-sizing",
				title: "In-cluster sizing",
				defaultOpen: true,
				fields: [
					{
						key: "storage_gb",
						type: "number",
						label: "Storage",
						unit: "GiB",
						min: 1,
						max: 1024,
						optional: true,
						placeholder: "10",
						description: "Persistent volume per Postgres instance (CloudNativePG).",
						visibleWhen: (_c, { provider }) => provider === "hetzner",
					},
					{
						key: "replicas",
						type: "number",
						label: "Instances",
						min: 1,
						max: 5,
						optional: true,
						placeholder: "1",
						description: "Postgres instances in the cluster (1 primary + replicas).",
						visibleWhen: (_c, { provider }) => provider === "hetzner",
					},
				],
			},
			{
				id: "security",
				title: "Security",
				tier: "security",
				fields: [
					{
						key: "iam_auth",
						type: "switch",
						label: "IAM authentication",
						description: "Authenticate with short-lived cloud IAM tokens instead of a password.",
					},
					{
						key: "backup_retention_days",
						type: "number",
						label: "Backup retention",
						unit: "days",
						min: 0,
						max: 35,
						optional: true,
						placeholder: "7",
						description:
							"0 disables automated backups. Point-in-time restore covers this window.",
					},
				],
			},
			{
				id: "db-advanced",
				title: "Advanced",
				tier: "advanced",
				fields: [
					{
						key: "engine_version",
						type: "text",
						label: "Engine version",
						mono: true,
						placeholder: "cloud default",
						description: "Pin an exact engine version. Empty tracks the template's default.",
					},
					{
						key: "instance_class",
						type: "text",
						label: "Instance class",
						mono: true,
						placeholder: "resolver default",
						description:
							"A concrete provider SKU (db.r6g.large · db-custom-2-7680 · GP_Gen5_2). Overrides the portable capacity above — and gives up portability.",
						// Serverless capacity is the portable path; this is the escape hatch. Meaningless
						// for the in-cluster CloudNativePG path.
						visibleWhen: (_c, { provider }) => provider !== "hetzner",
					},
				],
			},
		],
		summary: (c, provider) =>
			provider === "hetzner"
				? `${engineLabel(c)} · ${c.storage_gb ?? 10} GiB × ${c.replicas ?? 1}`
				: `${engineLabel(c)} · ${c.min_capacity ?? "?"}–${
						c.max_capacity ?? "?"
					}`,
	},

	cache: {
		sections: [
			{
				id: "general",
				title: "General",
				defaultOpen: true,
				fields: [
					nameField(),
					{
						key: "engine",
						type: "radio-card",
						label: "Engine",
						// Provider-filtered via the registry's shared variant gate (Hetzner's
						// in-cluster cache chart is Valkey — offering Redis would deploy Valkey).
						options: ({ provider }) => variantOptionsFor("cache", provider),
					},
					{
						key: "node_type",
						type: "select",
						label: "Node type",
						requiresProvider: true,
						// No managed cache SKUs on Hetzner — the in-cluster Valkey chart sizes
						// via storage_gb below.
						visibleWhen: (_c, { provider }) => provider !== "hetzner",
						options: ({ provider }) =>
							provider
								? CACHE_NODE_TYPES[provider].map((n) => ({
										value: n.value,
										label: `${n.label} · ${n.memoryGb} GB (${n.cost})`,
									}))
								: [],
					},
				],
			},
			{
				id: "sizing",
				title: "Sizing",
				defaultOpen: true,
				fields: [
						// The cloud-INDIFFERENT size. The Go resolver maps it to the nearest cache SKU on any
					// cloud; `node_type` is the concrete override that gives up portability.
					{
						key: "memory_gb",
						type: "number",
						label: "Memory",
						unit: "GB",
						min: 0.5,
						max: 512,
						float: true,
						optional: true,
						placeholder: "resolver default",
						description: "Portable sizing — mapped to the nearest cache tier on any cloud.",
						visibleWhen: (_c, { provider }) => provider !== "hetzner",
					},
				{ key: "num_cache_nodes", type: "number", label: "Nodes", min: 1, max: 6 },
					{
						key: "storage_gb",
						type: "number",
						label: "Storage",
						unit: "GiB",
						min: 1,
						max: 512,
						optional: true,
						placeholder: ({ config }) => String(config.memory_gb ?? 8),
						description: "Persistent volume per Valkey node; defaults to the memory size.",
						visibleWhen: (_c, { provider }) => provider === "hetzner",
					},
					{
						key: "multi_az",
						type: "switch",
						label: "Multi-AZ",
						description: "Replicate across availability zones for failover.",
						visibleWhen: (_c, { provider }) => provider !== "hetzner",
					},
				],
			},
			{
				id: "cache-network",
				title: "Network",
				tier: "security",
				fields: [
					{
						key: "allowed_cidr_blocks",
						type: "list",
						label: "Allowed CIDR blocks",
						description: "Extra networks permitted to reach the cache. The cluster always can.",
						item: { mono: true, placeholder: "10.1.0.0/16" },
					},
				],
			},
			{
				id: "cache-advanced",
				title: "Advanced",
				tier: "advanced",
				fields: [
					{
						key: "engine_version",
						type: "text",
						label: "Engine version",
						mono: true,
						placeholder: "cloud default",
						description: "Pin an exact engine version. Empty tracks the template's default.",
					},
				],
			},
		],
		summary: (c, provider) =>
			provider === "hetzner"
				? // The in-cluster chart is always Valkey, whatever engine the config carries.
					`Valkey · ${c.storage_gb ?? c.memory_gb ?? 8} GiB × ${c.num_cache_nodes ?? 1}`
				: `${c.engine === "valkey" ? "Valkey" : "Redis"} · ${
						c.node_type ?? "—"
					}`,
	},

	queue: {
		sections: [
			{
				id: "general",
				title: "General",
				defaultOpen: true,
				fields: [
					nameField(),
					{
						key: "visibility_timeout",
						type: "number",
						label: "Visibility timeout (s)",
						min: 0,
						max: 43200,
						// SQS-ism — the in-cluster RabbitMQ path has no visibility timeout.
						visibleWhen: (_c, { provider }) => provider !== "hetzner",
					},
					{
						key: "ordered",
						type: "switch",
						label: "Ordered (FIFO) delivery",
						description: "Guarantee message order at the cost of throughput.",
						visibleWhen: (_c, { provider }) => provider !== "hetzner",
					},
					{
						key: "message_retention",
						type: "number",
						label: "Message retention",
						unit: "days",
						min: 1,
						max: 14,
						optional: true,
						placeholder: "4",
						description: "How long an unconsumed message is kept before it's dropped.",
						visibleWhen: (_c, { provider }) => provider !== "hetzner",
						// Stored in SECONDS (SQS's unit); the field speaks days.
						get: (c) =>
							c.message_retention != null
								? Math.round(c.message_retention / 86400)
								: null,
						set: (v) => ({
							message_retention: v == null ? null : Number(v) * 86400,
						}),
					},
					{
						key: "storage_gb",
						type: "number",
						label: "Storage",
						unit: "GiB",
						min: 1,
						max: 256,
						optional: true,
						placeholder: "8",
						description: "Persistent volume for the RabbitMQ node.",
						visibleWhen: (_c, { provider }) => provider === "hetzner",
					},
				],
			},
		],
		summary: (c, provider) =>
			provider === "hetzner"
				? `RabbitMQ · ${c.storage_gb ?? 8} GiB`
				: `${c.ordered ? "FIFO" : "Standard"} · ${c.visibility_timeout ?? 30}s`,
	},

	topic: {
		sections: [
			{
				id: "general",
				title: "General",
				tier: "essentials",
				defaultOpen: true,
				fields: [nameField()],
			},
			{
				id: "subscriptions",
				title: "Subscriptions",
				tier: "essentials",
				defaultOpen: true,
				fields: [
					{
						key: "subscriptions",
						type: "subresource",
						label: "Subscriptions",
						description:
							"Who receives messages published to this topic. Without one, a topic delivers nowhere.",
						sub: {
							singular: "subscription",
							create: () => ({ protocol: "https", endpoint: "" }),
							title: (item) =>
								typeof item.endpoint === "string" && item.endpoint
									? item.endpoint
									: "",
							fields: [
								{
									key: "protocol",
									type: "select",
									label: "Protocol",
									options: [
										{ value: "https", label: "HTTPS" },
										{ value: "sqs", label: "Queue" },
										{ value: "email", label: "Email" },
										{ value: "lambda", label: "Function" },
									],
								},
								{
									key: "endpoint",
									type: "text",
									label: "Endpoint",
									mono: true,
									placeholder: "https://example.com/events",
									full: true,
								},
							],
						},
					},
				],
			},
		],
		summary: (c) => {
			const subs = c.subscriptions?.length ?? 0;
			return subs === 0
				? c.name || "topic"
				: `${subs} subscription${subs > 1 ? "s" : ""}`;
		},
	},

	nosql: {
		sections: [
			{
				id: "schema",
				title: "Schema",
				defaultOpen: true,
				fields: [
					nameField(),
					{
						key: "partition_key",
						type: "text",
						label: "Partition key",
						mono: true,
						placeholder: "id",
					},
					{
						key: "partition_key_type",
						type: "select",
						label: "Key type",
						options: ({ provider }) =>
							(provider ? NOSQL[provider].keyTypes : [{ value: "S", label: "String" }]).map(
								(k) => ({ value: k.value, label: k.label }),
							),
					},
					{
						key: "sort_key",
						type: "text",
						label: "Sort key",
						mono: true,
						placeholder: "optional",
						description: "A range key. Together with the partition key it forms a composite key.",
						// Not every cloud's table model has a range key.
						visibleWhen: (_c, { provider }) =>
							!provider || NOSQL[provider].supportsRangeKey !== false,
					},
					{
						key: "sort_key_type",
						type: "select",
						label: "Sort key type",
						options: ({ provider }) =>
							(provider ? NOSQL[provider].keyTypes : [{ value: "S", label: "String" }]).map(
								(k) => ({ value: k.value, label: k.label }),
							),
						visibleWhen: (c, { provider }) =>
							!!c.sort_key &&
							(!provider || NOSQL[provider].supportsRangeKey !== false),
					},
				],
			},
			{
				id: "capacity",
				title: "Capacity",
				defaultOpen: true,
				fields: [
					{
						key: "capacity_mode",
						type: "radio-card",
						label: "Capacity mode",
						options: ({ provider }) =>
							(provider
								? NOSQL[provider].billingModes
								: [{ value: "on_demand", label: "On-demand" }]
							).map((m) => ({
								value: m.value,
								label: m.label,
								description: CAPACITY_MODE_DESC[m.value],
							})),
					},
					{
						key: "point_in_time_recovery",
						type: "switch",
						label: "Point-in-time recovery",
						description: "Continuous backups for restore to any second in the retention window.",
					},
				],
			},
			{
				id: "nosql-replication",
				title: "Replication",
				tier: "advanced",
				fields: [
					{
						key: "global_replicas",
						type: "list",
						label: "Global replica regions",
						description:
							"Replicate the table to these regions. Only on clouds whose table service supports global tables.",
						item: { mono: true, placeholder: "us-east-1" },
					},
				],
			},
		],
		summary: (c) =>
			`${c.partition_key || "id"} · ${
				c.capacity_mode === "provisioned" ? "Provisioned" : "On-demand"
			}`,
	},

	secret: {
		sections: [
			{
				id: "general",
				title: "General",
				defaultOpen: true,
				fields: [
					nameField((v) => v.toLowerCase().replace(/[^a-z0-9-]/g, "")),
					{
						key: "generate",
						type: "switch",
						label: "Auto-generate value",
						description: "Generate a random secret, or manage the value yourself later.",
					},
					{
						key: "length",
						type: "number",
						label: "Length",
						min: 8,
						max: 128,
						visibleWhen: (c) => c.generate !== false,
					},
					{
						key: "special_chars",
						type: "switch",
						label: "Include special characters",
						visibleWhen: (c) => c.generate !== false,
					},
				],
			},
		],
		summary: (c) =>
			c.generate === false ? "manual value" : `generated · ${c.length ?? 32} chars`,
	},

	bucket: {
		sections: [
			{
				id: "general",
				title: "General",
				defaultOpen: true,
				fields: [
					// S3-safe: lowercase letters / digits / hyphens only (validated 3–63 on save).
					nameField((v) => v.toLowerCase().replace(/[^a-z0-9-]/g, "")),
					{
						key: "versioning",
						type: "switch",
						label: "Versioning",
						description: "Keep every version of an object; restore or roll back at any time.",
					},
					{
						key: "encryption_enabled",
						type: "switch",
						label: "Encryption at rest",
						description: "Server-side encryption with the cloud's managed keys.",
						// Hetzner Object Storage encrypts at rest automatically — there is no
						// per-bucket toggle in the minio provider, so hide it (always-on).
						visibleWhen: (_c, { provider }) => provider !== "hetzner",
					},
				],
			},
			{
				id: "access",
				title: "Access",
				defaultOpen: true,
				fields: [
					{
						key: "public_access",
						type: "switch",
						label: "Public access",
						description: "Allow unauthenticated reads (static assets). Off keeps the bucket private.",
					},
					{
						key: "cors_origins",
						type: "text",
						label: "CORS origins",
						mono: true,
						placeholder: "https://app.example.com, https://example.com",
						description: "Comma-separated origins allowed to read from the browser.",
						// The aminueza/minio provider does not apply CORS to Hetzner's S3 backend
						// (s3_compat_mode skips it), so hide the field rather than imply it works.
						visibleWhen: (_c, { provider }) => provider !== "hetzner",
						get: (c) => (c.cors_origins ?? []).join(", "),
						set: (v) => ({
							cors_origins: String(v)
								.split(",")
								.map((s) => s.trim())
								.filter(Boolean),
						}),
					},
				],
			},
		],
		summary: (c) =>
			[
				c.versioning ? "versioned" : null,
				c.encryption_enabled !== false ? "encrypted" : null,
				c.public_access ? "public" : "private",
			]
				.filter(Boolean)
				.join(" · "),
	},

	registry: {
		sections: [
			{
				id: "general",
				title: "General",
				defaultOpen: true,
				fields: [
					nameField((v) => v.toLowerCase().replace(/[^a-z0-9-]/g, "")),
					{
						key: "immutable_tags",
						type: "switch",
						label: "Immutable tags",
						description: "Prevent pushed image tags from being overwritten.",
						get: (c) => c.provider_config?.immutable_tags ?? false,
						set: (v, c) => ({
							provider_config: { ...c.provider_config, immutable_tags: Boolean(v) },
						}),
					},
					{
						key: "vulnerability_scanning",
						type: "switch",
						label: "Vulnerability scanning",
						description: "Scan pushed images for known CVEs.",
						get: (c) => c.provider_config?.vulnerability_scanning ?? false,
						set: (v, c) => ({
							provider_config: {
								...c.provider_config,
								vulnerability_scanning: Boolean(v),
							},
						}),
					},
				],
			},
		],
		// The provider's registry service name (ECR / Artifact Registry / ACR / …).
		summary: (c, provider) =>
			provider ? getProvider(provider).registryService : c.name || "registry",
	},

	dns: {
		sections: [
			{
				id: "general",
				title: "General",
				defaultOpen: true,
				fields: [
					{ key: "enabled", type: "switch", label: "Enabled" },
					{
						key: "domain_name",
						type: "text",
						label: "Domain name",
						mono: true,
						placeholder: "example.com",
					},
					{
						key: "managed_certificate",
						type: "switch",
						label: "Managed TLS certificate",
					},
					{ key: "waf_enabled", type: "switch", label: "Web application firewall (WAF)" },
					{
						key: "zone_id",
						type: "text",
						label: "Existing zone ID",
						mono: true,
						placeholder: "create a new zone",
						description:
							"Attach to a hosted zone you already own instead of creating one (Z0123… · projects/…/managedZones/… ).",
					},
				],
			},
		],
		summary: (c) =>
			c.domain_name || (c.enabled === false ? "disabled" : "enabled"),
	},

	repositories: {
		sections: [
			{
				id: "general",
				title: "GitOps",
				defaultOpen: true,
				fields: [
					{
						key: "apps_destination_repo",
						type: "repository",
						label: "ArgoCD apps repository",
						description: "The Git repo ArgoCD syncs application manifests from.",
					},
				],
			},
		],
		summary: (c) => c.apps_destination_repo || "no repository",
	},
};

/**
 * Look up a kind's config schema, widened to the generic renderer's
 * `Record<string, unknown>` seam. The inspector + config-fields hold a node whose kind
 * is only known at runtime, so they can't narrow to a specific `NodeConfigMap` fragment;
 * this single, documented widening is the erasure boundary of the key-driven engine.
 */
export function getKindConfig(kind: NodeKind): KindConfig | undefined {
	return CONFIG_SCHEMA[kind] as KindConfig | undefined;
}
