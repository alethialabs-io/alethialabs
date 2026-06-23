// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
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
	DB_ENGINES,
	DEFAULT_CACHE_NODE,
	DEFAULT_INSTANCE_TYPE,
	DEFAULT_K8S_VERSION,
	type CloudProviderSlug,
} from "@/lib/cloud-providers";
import type { NodeKind } from "./types";

/** Where a node's config lands in SpecFormData. */
export type SchemaKey =
	| "spec"
	| "network"
	| "cluster"
	| "dns"
	| "repositories"
	| "databases"
	| "caches"
	| "queues"
	| "topics"
	| "nosql_tables"
	| "secrets";

export interface NodeKindDef {
	kind: NodeKind;
	schemaKey: SchemaKey;
	cardinality: "singleton" | "array";
	/** CORE must colocate on the project identity; PERIPHERY may diverge. */
	classification: "core" | "periphery" | "root";
	/** False for resources with no cloud account (repositories = git). */
	cloudScoped: boolean;
	eyebrow: string;
	label: string;
	icon: LucideIcon;
	/** Default config for a freshly-added node, given the effective provider. */
	defaultData: (provider: CloudProviderSlug) => Record<string, unknown>;
}

/**
 * Single source of truth for node kinds. The palette, command palette, React Flow
 * nodeTypes, and the graph⇄form mappers all derive from this table.
 */
export const NODE_REGISTRY: Record<NodeKind, NodeKindDef> = {
	project: {
		kind: "project",
		schemaKey: "spec",
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
			zone_id: "",
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
			const engine = DB_ENGINES[provider][0];
			const capacity = DB_CAPACITY[provider];
			return {
				name: "primary",
				engine: engine.value,
				engine_version: engine.defaultVersion,
				min_capacity: capacity.defaultMin,
				max_capacity: capacity.defaultMax,
				port: 5432,
				iam_auth: false,
			};
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

/** Singleton kinds may exist at most once on the canvas. */
export const SINGLETON_KINDS: NodeKind[] = [
	"project",
	"network",
	"cluster",
	"dns",
	"repositories",
];
