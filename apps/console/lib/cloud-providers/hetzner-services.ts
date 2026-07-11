// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Hetzner is a compute-only cloud — it has no managed Postgres/Redis/queue services like
 * AWS/GCP/Azure. So on a Hetzner/Talos cluster, a canvas "database"/"cache"/"queue" node does
 * not map to a managed cloud resource; it becomes an **in-cluster Helm chart** deployed via
 * ArgoCD. This module is the single source of truth for WHICH chart backs each engine and how
 * a component's config maps to that chart's Helm values.
 *
 * The mapping produces `AddOnInstallSpec[]` — the exact runner-facing shape the marketplace
 * add-ons already use — which `buildConfigSnapshot` appends to the DEPLOY job's `addons`. The
 * runner renders one ArgoCD Application per spec (packages/core/argocd RenderManagedAddOns),
 * with zero Go changes: the renderer is generic over (chartRepo, chart, version, namespace,
 * values). Chart coordinates live here and are swappable without touching the pipeline.
 *
 * v1 scope: Postgres (CloudNativePG), Redis→Valkey, queue→RabbitMQ. Topic (SNS) and NoSQL
 * (DynamoDB) have no clean single-chart OSS equal and are deferred (hidden on the canvas).
 */

import type { AddOnInstallSpec } from "@/lib/addons/types";

/** The block-storage StorageClass the Hetzner/Talos template makes default (CSI driver). */
const HCLOUD_STORAGE_CLASS = "hcloud-volumes";

/** Shared namespaces per service category (auto-created by ArgoCD `CreateNamespace=true`). */
const NS = {
	postgres: "databases",
	cache: "caches",
	queue: "queues",
	operators: "cnpg-system",
} as const;

/**
 * Pinned chart coordinates per in-cluster service. Versions resolve against the live Helm
 * repos at `tofu apply` time (not exercisable under type-check); bump here as the SSOT.
 */
export const HETZNER_CHARTS = {
	/** CloudNativePG operator — installed once per cluster when ≥1 Postgres node exists. */
	cnpgOperator: {
		chartRepo: "https://cloudnative-pg.github.io/charts",
		chart: "cloudnative-pg",
		version: "0.22.1",
	},
	/** CloudNativePG `cluster` chart — one Application per database node (a Cluster CR). */
	cnpgCluster: {
		chartRepo: "https://cloudnative-pg.github.io/charts",
		chart: "cluster",
		version: "0.0.11",
	},
	/** Valkey (OSS Redis fork) — one release per cache node. */
	valkey: {
		chartRepo: "https://charts.bitnami.com/bitnami",
		chart: "valkey",
		version: "1.0.6",
	},
	/** RabbitMQ — the SQS analogue, one release per queue node. */
	rabbitmq: {
		chartRepo: "https://charts.bitnami.com/bitnami",
		chart: "rabbitmq",
		version: "14.7.0",
	},
} as const;

/** Node kinds Hetzner supports in v1 (the canvas hides the rest for Hetzner). */
export const HETZNER_SUPPORTED_DATA_KINDS = ["database", "cache", "queue"] as const;

/** Database engines available on Hetzner (Postgres only in v1 — via CloudNativePG). */
export const HETZNER_DB_ENGINES = ["postgres"] as const;

/** Minimal, forward-compatible views of the component rows the mapper needs. `storage_gb`
 *  and `replicas` are optional: they become user-tunable inspector fields in a later pass and
 *  default here until then. */
interface DatabaseInput {
	name: string;
	engine_family?: string | null;
	engine_version?: string | null;
	storage_gb?: number | null;
	replicas?: number | null;
}
interface CacheInput {
	name: string;
	engine_version?: string | null;
	memory_gb?: number | null;
	num_cache_nodes?: number | null;
	storage_gb?: number | null;
}
interface QueueInput {
	name: string;
	storage_gb?: number | null;
}

interface HetznerDataServices {
	databases?: DatabaseInput[];
	caches?: CacheInput[];
	queues?: QueueInput[];
}

/** Clamp a positive integer with a default, guarding null/NaN/negatives. */
function posInt(value: number | null | undefined, fallback: number): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 1) {
		return fallback;
	}
	return Math.floor(value);
}

/**
 * Maps a Hetzner project's data components to in-cluster Helm install specs. Returns an
 * `AddOnInstallSpec[]` to append to the DEPLOY snapshot's `addons`:
 *  - the CloudNativePG operator once (sync-wave 0) when any Postgres database is present;
 *  - one CNPG `cluster` Application per database (sync-wave 1);
 *  - one Valkey release per cache; one RabbitMQ release per queue (sync-wave 1).
 * Each id is unique per node (`db-<name>` / `cache-<name>` / `queue-<name>`) so the runner's
 * `AddOnAppName` yields a distinct ArgoCD Application, and health reads back per component.
 */
export function hetznerDataServicesToAddOns(
	services: HetznerDataServices,
): AddOnInstallSpec[] {
	const specs: AddOnInstallSpec[] = [];

	const databases = services.databases ?? [];
	const caches = services.caches ?? [];
	const queues = services.queues ?? [];

	// Postgres databases: install the CNPG operator once, then a Cluster per node.
	const pgDatabases = databases.filter(
		(d) => (d.engine_family ?? "postgres") === "postgres",
	);
	if (pgDatabases.length > 0) {
		specs.push({
			id: "cnpg-operator",
			mode: "managed",
			chartRepo: HETZNER_CHARTS.cnpgOperator.chartRepo,
			chart: HETZNER_CHARTS.cnpgOperator.chart,
			version: HETZNER_CHARTS.cnpgOperator.version,
			namespace: NS.operators,
			values: {},
			syncWave: 0,
		});
	}
	for (const db of pgDatabases) {
		const cluster: Record<string, unknown> = {
			instances: posInt(db.replicas, 1),
			storage: {
				size: `${posInt(db.storage_gb, 10)}Gi`,
				storageClass: HCLOUD_STORAGE_CLASS,
			},
		};
		if (db.engine_version) {
			cluster.imageName = `ghcr.io/cloudnative-pg/postgresql:${db.engine_version}`;
		}
		specs.push({
			id: `db-${db.name}`,
			mode: "managed",
			chartRepo: HETZNER_CHARTS.cnpgCluster.chartRepo,
			chart: HETZNER_CHARTS.cnpgCluster.chart,
			version: HETZNER_CHARTS.cnpgCluster.version,
			namespace: NS.postgres,
			values: { cluster },
			syncWave: 1,
		});
	}

	// Caches → Valkey (standalone, or replication when >1 node).
	for (const cache of caches) {
		const nodes = posInt(cache.num_cache_nodes, 1);
		const storageGb = posInt(cache.storage_gb ?? cache.memory_gb, 8);
		const values: Record<string, unknown> = {
			architecture: nodes > 1 ? "replication" : "standalone",
			primary: {
				persistence: {
					size: `${storageGb}Gi`,
					storageClassName: HCLOUD_STORAGE_CLASS,
				},
			},
			replica: { replicaCount: Math.max(0, nodes - 1) },
		};
		if (cache.engine_version) {
			values.image = { tag: cache.engine_version };
		}
		specs.push({
			id: `cache-${cache.name}`,
			mode: "managed",
			chartRepo: HETZNER_CHARTS.valkey.chartRepo,
			chart: HETZNER_CHARTS.valkey.chart,
			version: HETZNER_CHARTS.valkey.version,
			namespace: NS.cache,
			values,
			syncWave: 1,
		});
	}

	// Queues → RabbitMQ (single node in v1).
	for (const queue of queues) {
		specs.push({
			id: `queue-${queue.name}`,
			mode: "managed",
			chartRepo: HETZNER_CHARTS.rabbitmq.chartRepo,
			chart: HETZNER_CHARTS.rabbitmq.chart,
			version: HETZNER_CHARTS.rabbitmq.version,
			namespace: NS.queue,
			values: {
				replicaCount: 1,
				persistence: {
					size: `${posInt(queue.storage_gb, 8)}Gi`,
					storageClassName: HCLOUD_STORAGE_CLASS,
				},
			},
			syncWave: 1,
		});
	}

	return specs;
}
