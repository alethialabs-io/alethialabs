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
	/**
	 * Valkey (OSS Redis fork) — one release per cache node, from the UPSTREAM VALKEY PROJECT'S
	 * OWN chart (valkey-io/valkey-helm), which ships the official `docker.io/valkey/valkey` image.
	 *
	 * NOT Bitnami: `bitnami/valkey` 1.0.6 was DELETED from the Bitnami index (`helm show chart`
	 * → "no chart version found for valkey-1.0.6"), so ArgoCD could not even fetch it — Hetzner
	 * caches were broken in production. Broadcom's Bitnami wind-down also relocated
	 * `docker.io/bitnami/*` images to `bitnamilegacy/*`, so staying on Bitnami means an
	 * unmaintained, unpatched image archive. This chart is first-party and maintained.
	 *
	 * ⚠️ Its value schema is NOTHING like Bitnami's — see hetznerCacheValues() for the mapping,
	 * which is verified against `helm show values`/`helm template`, never guessed.
	 */
	valkey: {
		chartRepo: "https://valkey-io.github.io/valkey-helm",
		chart: "valkey",
		version: "0.10.0",
	},
	/**
	 * RabbitMQ — the SQS analogue, one release per queue node. Pulls the OFFICIAL upstream
	 * `docker.io/rabbitmq` image (the chart digest-pins it), app v4.3.x.
	 *
	 * NOT Bitnami: `bitnami/rabbitmq` 14.7.0's default image
	 * `docker.io/bitnami/rabbitmq:3.13.7-debian-12-r2` is HTTP 404 — Broadcom relocated the
	 * Bitnami catalog's images to `bitnamilegacy/*` — so every fresh Hetzner queue
	 * ImagePullBackOff'd. The Bitnami-hosted `rabbitmq-cluster-operator` chart is NOT an escape:
	 * it still pulls `docker.io/bitnami/*`.
	 *
	 * Durable upgrade path (deliberately NOT taken here): the OFFICIAL RabbitMQ Cluster Operator
	 * (rabbitmq/cluster-operator, images `rabbitmqoperator/*`) ships as a `kubectl apply` release
	 * manifest, which the new `source: "manifest"` add-on rail can now install — but a
	 * RabbitmqCluster CR is not a Helm chart, so delivering the per-queue CR (and reading its
	 * health back) needs the inline-manifest + CR-health work. This chart keeps queues on the
	 * Helm rail (so ArgoCD health/status keeps working) with official images, today.
	 */
	rabbitmq: {
		chartRepo: "https://cloudpirates-io.github.io/helm-charts",
		chart: "rabbitmq",
		version: "0.21.9",
	},
} as const;

/** Node kinds Hetzner supports in v1 (the canvas hides the rest for Hetzner). */
export const HETZNER_SUPPORTED_DATA_KINDS = ["database", "cache", "queue"] as const;

/** Database engines available on Hetzner (Postgres only in v1 — via CloudNativePG). */
export const HETZNER_DB_ENGINES = ["postgres"] as const;

/** Cache engines available on Hetzner (the in-cluster chart is Valkey — Redis-compatible,
 *  but offering "Redis" would be dishonest: the deploy always ships Valkey). */
export const HETZNER_CACHE_ENGINES = ["valkey"] as const;

/** Minimal views of the component rows the mapper needs. `storage_gb` and `replicas` are
 *  the user-tunable in-cluster sizing columns (Hetzner-gated inspector fields); NULL means
 *  the defaults here stay authoritative. A cache's explicit `storage_gb` wins over the
 *  `memory_gb` fallback. */
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
			// The CRD each database's `Cluster` CR (sync-wave 1) needs. The runner applies the
			// add-on Applications in wave order and BLOCKS on this CRD becoming Established before
			// wave 1 — ArgoCD's sync-wave annotation does NOT order separate top-level
			// Applications, so without this the operator and the Cluster CR race and the CR's first
			// sync fails with `no matches for kind "Cluster"`. Name verified against the real chart
			// (cloudnative-pg 0.22.1 renders clusters.postgresql.cnpg.io).
			crds: ["clusters.postgresql.cnpg.io"],
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
		specs.push({
			id: `cache-${cache.name}`,
			mode: "managed",
			chartRepo: HETZNER_CHARTS.valkey.chartRepo,
			chart: HETZNER_CHARTS.valkey.chart,
			version: HETZNER_CHARTS.valkey.version,
			namespace: NS.cache,
			values: hetznerCacheValues(cache),
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
			values: hetznerQueueValues(queue),
			syncWave: 1,
		});
	}

	return specs;
}

/**
 * Helm values for one cache node, against the UPSTREAM valkey-io chart's REAL schema — which is
 * nothing like the Bitnami chart this replaced. Every key below was verified with
 * `helm show values` + `helm template` (a guessed mapping is how you ship a chart that silently
 * ignores your sizing, or that hard-errors at sync):
 *
 *  - `dataStorage.{enabled,requestedSize,className}` — the primary's PVC (Bitnami used
 *    `primary.persistence.{size,storageClass}`).
 *  - `replica.{enabled,replicas}` — replicas are ADDITIONAL to the primary, so N nodes ⇒
 *    `replicas: N-1` (asserted in the tests: 3 nodes renders 3 pods, not 4).
 *  - `replica.persistence.{size,storageClass}` — MANDATORY when replicas are on: the chart
 *    hard-fails with "Replica mode requires persistent storage" if it is missing. This is exactly
 *    the trap a translated-by-eye mapping falls into.
 */
export function hetznerCacheValues(
	cache: CacheInput,
): Record<string, unknown> {
	const nodes = posInt(cache.num_cache_nodes, 1);
	const storageGb = posInt(cache.storage_gb ?? cache.memory_gb, 8);
	const size = `${storageGb}Gi`;

	const values: Record<string, unknown> = {
		dataStorage: {
			enabled: true,
			requestedSize: size,
			className: HCLOUD_STORAGE_CLASS,
		},
		replica: {
			enabled: nodes > 1,
			// The primary is not a replica — N nodes ⇒ N-1 replicas.
			replicas: Math.max(0, nodes - 1),
			// Required whenever replica.enabled: the chart refuses to render without it. Same
			// volume size as the primary so "N GiB per node" stays true.
			persistence: { size, storageClass: HCLOUD_STORAGE_CLASS },
		},
	};
	if (cache.engine_version) {
		values.image = { tag: cache.engine_version };
	}
	return values;
}

/**
 * Helm values for one queue node. The chart pulls the OFFICIAL upstream `docker.io/rabbitmq`
 * image (digest-pinned by the chart), not a Bitnami image — the previous `bitnami/rabbitmq`
 * chart's default image tag is now HTTP 404 (Broadcom relocated it to `bitnamilegacy/*`), so
 * every fresh Hetzner queue ImagePullBackOff'd. Keys verified with `helm template`.
 */
export function hetznerQueueValues(
	queue: QueueInput,
): Record<string, unknown> {
	return {
		replicaCount: 1,
		persistence: {
			enabled: true,
			size: `${posInt(queue.storage_gb, 8)}Gi`,
			storageClass: HCLOUD_STORAGE_CLASS,
		},
	};
}
