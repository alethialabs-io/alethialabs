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
	INSTANCE_TYPES,
	K8S_VERSIONS,
	NOSQL,
	type CloudProviderSlug,
} from "@/lib/cloud-providers";
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
	| "repository";

export interface FieldDef<C = AnyConfig> {
	key: string;
	type: FieldType;
	label: string;
	description?: string;
	/** Monospace text input (names, CIDR, ids). */
	mono?: boolean;
	placeholder?: string;
	unit?: Resolvable<string, C>;
	options?: Resolvable<FieldOption[], C>;
	min?: Resolvable<number, C>;
	max?: Resolvable<number, C>;
	step?: Resolvable<number, C>;
	/** Parse numeric input as float (default: int unless a fractional step is set). */
	float?: boolean;
	/** Field needs an effective cloud provider; renders a notice when none is set. */
	requiresProvider?: boolean;
	/** Span the full section width (radio-card/region/repository/switch already do). */
	full?: boolean;
	/** Hide the field unless the predicate holds (e.g. only when a toggle is on). */
	visibleWhen?: (config: C) => boolean;
	/** Normalize raw text input (e.g. lowercasing a name). */
	transform?: (raw: string) => string;
	/** Nested read escape hatch (e.g. `instance_types[0]`). */
	get?: (config: C) => unknown;
	/** Nested write escape hatch — returns the patch to merge into config. */
	set?: (value: unknown, config: C) => Partial<C>;
}

export interface SectionDef<C = AnyConfig> {
	id: string;
	title: string;
	defaultOpen?: boolean;
	fields: FieldDef<C>[];
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

const ENGINE_FAMILY: FieldOption[] = [
	{
		value: "postgres",
		label: "PostgreSQL",
		description: "Broad extension support — the default relational choice.",
	},
	{
		value: "mysql",
		label: "MySQL",
		description: "Familiar, with wide tooling and driver compatibility.",
	},
];

const CACHE_ENGINE: FieldOption[] = [
	{
		value: "redis",
		label: "Redis",
		description: "In-memory data store for caching, sessions, and queues.",
	},
	{
		value: "valkey",
		label: "Valkey",
		description: "Open-source Redis fork, drop-in compatible.",
	},
];

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
				defaultOpen: true,
				fields: [
					{ key: "node_min_size", type: "number", label: "Min nodes", min: 1, max: 100 },
					{
						key: "node_desired_size",
						type: "number",
						label: "Desired nodes",
						min: 1,
						max: 100,
					},
					{ key: "node_max_size", type: "number", label: "Max nodes", min: 1, max: 100 },
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
						options: ENGINE_FAMILY,
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
						unit: ({ provider }) => (provider ? DB_CAPACITY[provider].unit : ""),
						min: ({ provider }) => (provider ? DB_CAPACITY[provider].min : 0),
						max: ({ provider }) => (provider ? DB_CAPACITY[provider].max : 0),
						step: ({ provider }) => (provider ? DB_CAPACITY[provider].step : 1),
					},
				],
			},
			{
				id: "security",
				title: "Security",
				fields: [
					{
						key: "iam_auth",
						type: "switch",
						label: "IAM authentication",
						description: "Authenticate with short-lived cloud IAM tokens instead of a password.",
					},
				],
			},
		],
		summary: (c) =>
			`${engineLabel(c)} · ${c.min_capacity ?? "?"}–${
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
					{ key: "engine", type: "radio-card", label: "Engine", options: CACHE_ENGINE },
					{
						key: "node_type",
						type: "select",
						label: "Node type",
						requiresProvider: true,
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
					{ key: "num_cache_nodes", type: "number", label: "Nodes", min: 1, max: 6 },
					{
						key: "multi_az",
						type: "switch",
						label: "Multi-AZ",
						description: "Replicate across availability zones for failover.",
					},
				],
			},
		],
		summary: (c) =>
			`${c.engine === "valkey" ? "Valkey" : "Redis"} · ${
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
					},
					{
						key: "ordered",
						type: "switch",
						label: "Ordered (FIFO) delivery",
						description: "Guarantee message order at the cost of throughput.",
					},
				],
			},
		],
		summary: (c) =>
			`${c.ordered ? "FIFO" : "Standard"} · ${c.visibility_timeout ?? 30}s`,
	},

	topic: {
		sections: [
			{
				id: "general",
				title: "General",
				defaultOpen: true,
				fields: [nameField()],
			},
		],
		summary: (c) => c.name || "topic",
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
