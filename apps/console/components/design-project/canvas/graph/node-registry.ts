// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import {
	Box,
	Database,
	GitBranch,
	Globe,
	KeyRound,
	ListOrdered,
	Megaphone,
	Network,
	Server,
	Table2,
	Zap,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import {
	AUTOSCALER,
	DB_CAPACITY,
	DEFAULT_CACHE_NODE,
	DEFAULT_INSTANCE_TYPE,
	DEFAULT_K8S_VERSION,
	type CloudProviderSlug,
} from "@/lib/cloud-providers";
import type { NodeConfigMap, NodeKind } from "./types";

/** Where a node's config lands in ProjectFormData. */
export type SchemaKey =
	| "project"
	| "network"
	| "cluster"
	| "dns"
	| "repositories"
	| "databases"
	| "caches"
	| "queues"
	| "topics"
	| "nosql_tables"
	| "secrets"
	// Chart nodes are out-of-band (project_addons), never written into ProjectFormData — this key
	// exists only to satisfy the exhaustive registry; the graph⇄form mappers never read it.
	| "charts";

export interface NodeKindDef<K extends NodeKind = NodeKind> {
	kind: K;
	schemaKey: SchemaKey;
	cardinality: "singleton" | "array";
	/** CORE must colocate on the project identity; PERIPHERY may diverge. */
	classification: "core" | "periphery" | "root";
	/** False for resources with no cloud account (repositories = git). */
	cloudScoped: boolean;
	eyebrow: string;
	label: string;
	icon: LucideIcon;
	/** Default config for a freshly-added node, given the effective provider. Typed to the
	 * kind's ProjectFormData fragment (the schema's optional/defaulted columns may be omitted). */
	defaultData: (provider: CloudProviderSlug) => NodeConfigMap[K];
	/** Optional pre-add step: pick a value for `key` (e.g. the DB engine) before the node is
	 * created + configured. Kinds without variants are added straight to the canvas. */
	variants?: {
		key: string;
		options: { value: string; label: string; description: string }[];
	};
}

/** Per-kind registry: each entry's `defaultData` is typed to that kind's config fragment. */
export type NodeRegistry = { [K in NodeKind]: NodeKindDef<K> };

/**
 * Single source of truth for node kinds. The palette, command palette, React Flow
 * nodeTypes, and the graph⇄form mappers all derive from this table.
 */
export const NODE_REGISTRY: NodeRegistry = {
	project: {
		kind: "project",
		schemaKey: "project",
		cardinality: "singleton",
		classification: "root",
		cloudScoped: true,
		eyebrow: "Project",
		label: "Project",
		icon: Box,
		defaultData: () => ({
			project_name: "",
			environment_stage: "development",
			region: "",
			iac_version: "1.11.4",
		}),
	},
	network: {
		kind: "network",
		schemaKey: "network",
		cardinality: "singleton",
		classification: "core",
		cloudScoped: true,
		eyebrow: "Network",
		label: "Network",
		icon: Network,
		defaultData: () => ({
			provision_network: true,
			cidr_block: "10.0.0.0/16",
			single_nat_gateway: true,
		}),
	},
	cluster: {
		kind: "cluster",
		schemaKey: "cluster",
		cardinality: "singleton",
		classification: "core",
		cloudScoped: true,
		eyebrow: "Cluster",
		label: "Cluster",
		icon: Server,
		defaultData: (provider) => ({
			cluster_version: DEFAULT_K8S_VERSION[provider],
			instance_types: [DEFAULT_INSTANCE_TYPE[provider]],
			node_min_size: 2,
			node_max_size: 5,
			node_desired_size: 2,
			provider_config: { [AUTOSCALER[provider].providerConfigKey]: true },
		}),
	},
	database: {
		kind: "database",
		schemaKey: "databases",
		cardinality: "array",
		classification: "core",
		cloudScoped: true,
		eyebrow: "Database",
		label: "Database",
		icon: Database,
		defaultData: (provider) => {
			const capacity = DB_CAPACITY[provider];
			return {
				name: "primary",
				// Cloud-indifferent: the Go resolver maps the family to the cloud's managed DB.
				engine_family: "postgres",
				min_capacity: capacity.defaultMin,
				max_capacity: capacity.defaultMax,
				port: 5432,
				iam_auth: false,
			};
		},
		variants: {
			key: "engine_family",
			options: [
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
			],
		},
	},
	cache: {
		kind: "cache",
		schemaKey: "caches",
		cardinality: "array",
		classification: "core",
		cloudScoped: true,
		eyebrow: "Cache",
		label: "Cache",
		icon: Zap,
		defaultData: (provider) => ({
			name: "primary",
			engine: "redis",
			node_type: DEFAULT_CACHE_NODE[provider],
			num_cache_nodes: 1,
			multi_az: false,
		}),
		variants: {
			key: "engine",
			options: [
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
			],
		},
	},
	queue: {
		kind: "queue",
		schemaKey: "queues",
		cardinality: "array",
		classification: "core",
		cloudScoped: true,
		eyebrow: "Queue",
		label: "Queue",
		icon: ListOrdered,
		defaultData: () => ({
			name: "queue",
			ordered: false,
			visibility_timeout: 30,
			message_retention: 345600,
		}),
	},
	topic: {
		kind: "topic",
		schemaKey: "topics",
		cardinality: "array",
		classification: "core",
		cloudScoped: true,
		eyebrow: "Topic",
		label: "Topic",
		icon: Megaphone,
		defaultData: () => ({
			name: "topic",
			subscriptions: [],
		}),
	},
	nosql: {
		kind: "nosql",
		schemaKey: "nosql_tables",
		cardinality: "array",
		classification: "core",
		cloudScoped: true,
		eyebrow: "NoSQL",
		label: "NoSQL table",
		icon: Table2,
		defaultData: () => ({
			name: "table",
			partition_key: "id",
			partition_key_type: "S",
			table_type: "standard",
			capacity_mode: "on_demand",
			point_in_time_recovery: true,
		}),
	},
	dns: {
		kind: "dns",
		schemaKey: "dns",
		cardinality: "singleton",
		classification: "periphery",
		cloudScoped: true,
		eyebrow: "DNS",
		label: "DNS",
		icon: Globe,
		defaultData: () => ({
			enabled: true,
			managed_certificate: false,
			waf_enabled: false,
			provider_config: {},
		}),
	},
	secret: {
		kind: "secret",
		schemaKey: "secrets",
		cardinality: "array",
		classification: "periphery",
		cloudScoped: true,
		eyebrow: "Secret",
		label: "Secret",
		icon: KeyRound,
		defaultData: () => ({
			name: "secret",
			generate: true,
			length: 32,
			special_chars: true,
		}),
	},
	repositories: {
		kind: "repositories",
		schemaKey: "repositories",
		cardinality: "singleton",
		classification: "periphery",
		cloudScoped: false,
		eyebrow: "GitOps",
		label: "Repository",
		icon: GitBranch,
		defaultData: () => ({
			apps_destination_repo: "",
		}),
	},
	// Bring-your-own Helm chart — added via the ⌘K "Sources" flow (not the palette), persisted
	// out-of-band in project_addons, loaded from getProjectByoCharts. defaultData is a placeholder
	// (real config always comes from the attach flow / DB).
	chart: {
		kind: "chart",
		schemaKey: "charts",
		cardinality: "array",
		classification: "periphery",
		cloudScoped: false,
		eyebrow: "Helm chart",
		label: "Helm chart",
		icon: GitBranch,
		defaultData: () => ({
			id: "chart",
			repoUrl: "",
			chartPath: "",
			ref: "HEAD",
			namespace: "default",
		}),
	},
};

/** Kinds offered in the palette (everything except the fixed project root). */
export const ADDABLE_KINDS: NodeKind[] = [
	"network",
	"cluster",
	"database",
	"cache",
	"queue",
	"topic",
	"nosql",
	"dns",
	"secret",
	"repositories",
];

/**
 * Node kinds a given cloud can't back. Compute-only Hetzner runs data services as in-cluster
 * Helm charts (Postgres→CloudNativePG, cache→Valkey, queue→RabbitMQ); topic (SNS) and nosql
 * (DynamoDB) have no clean single-chart OSS equal, so they're hidden on Hetzner for now
 * (see lib/cloud-providers/hetzner-services.ts).
 */
const UNSUPPORTED_KINDS_BY_PROVIDER: Partial<
	Record<CloudProviderSlug, readonly NodeKind[]>
> = {
	hetzner: ["topic", "nosql"],
};

/** ADDABLE_KINDS minus the kinds the effective provider can't back (null → all). */
export function addableKindsFor(provider: CloudProviderSlug | null): NodeKind[] {
	const blocked = provider ? UNSUPPORTED_KINDS_BY_PROVIDER[provider] : undefined;
	if (!blocked || blocked.length === 0) return ADDABLE_KINDS;
	return ADDABLE_KINDS.filter((k) => !blocked.includes(k));
}

/** Singleton kinds may exist at most once on the canvas. */
export const SINGLETON_KINDS: NodeKind[] = [
	"project",
	"network",
	"cluster",
	"dns",
	"repositories",
];
