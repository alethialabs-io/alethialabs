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

/** hcloud's minimum Block Storage volume is 10 GiB. Asking for less does not fail — the CSI driver
 *  rounds up — so a chart default below it produces a cluster that quietly disagrees with the
 *  values this repo rendered. Every volume we ask for is clamped here instead. */
const HCLOUD_MIN_VOLUME_GB = 10;

/** Shared namespaces per service category (auto-created by ArgoCD `CreateNamespace=true`). */
const NS = {
	postgres: "databases",
	cache: "caches",
	queue: "queues",
	registry: "registries",
	secret: "secrets",
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
	/**
	 * Harbor — the in-cluster substitute for ECR / Artifact Registry / ACR, one release per
	 * `registry` node. The SAME chart and pin as the `harbor` marketplace add-on
	 * (lib/addons/catalog.ts): a Hetzner project that also enables the add-on must not end up with
	 * two different Harbor versions in one cluster.
	 *
	 * ⚠️ It is not one release with one volume. Harbor ships its OWN Postgres, Redis and Trivy, so
	 * a registry node costs FIVE persistent volumes, and hcloud's minimum volume is 10 GiB — the
	 * chart's 1Gi/1Gi/5Gi defaults for the non-registry three would each be silently rounded up by
	 * the CSI driver. hetznerRegistryValues() asks for what it will actually get.
	 */
	harbor: {
		chartRepo: "https://helm.goharbor.io",
		chart: "harbor",
		version: "1.15.1",
	},
	/**
	 * HashiCorp Vault — the in-cluster substitute for Secrets Manager / Secret Manager / Key Vault /
	 * KMS, ONE release per cluster serving every `secret` node. The SAME chart and pin as the `vault`
	 * marketplace add-on (lib/addons/catalog.ts), for the reason Harbor's note above gives.
	 *
	 * ⚠️ It is deliberately NOT installed under the marketplace add-on's id or namespace. That
	 * add-on is a Vault the CUSTOMER runs and operates; this one is the PLATFORM's, and Alethia
	 * holds its unseal key. A project may reasonably want both, so they must not collide — hence
	 * the `secrets-vault` id and the `secrets` namespace here against the add-on's `vault`/`vault`.
	 */
	vault: {
		chartRepo: "https://helm.releases.hashicorp.com",
		chart: "vault",
		version: "0.28.1",
	},
} as const;

/** Node kinds Hetzner supports in v1 (the canvas hides the rest for Hetzner). */
export const HETZNER_SUPPORTED_DATA_KINDS = [
	"database",
	"cache",
	"queue",
	"registry",
	"secret",
] as const;

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
/** A `registry` node. `storage_gb` sizes the IMAGE store only — Harbor's own database, Redis and
 *  Trivy volumes are fixed at hcloud's 10 GiB minimum and are not user-tunable. */
interface RegistryInput {
	name: string;
	storage_gb?: number | null;
}
/** A `secret` node. It carries no sizing of its own — every secret node on a project is one KV v2
 *  entry in the SAME Vault, so only the presence of at least one matters to the mapper. */
interface SecretInput {
	name: string;
}

interface HetznerDataServices {
	databases?: DatabaseInput[];
	caches?: CacheInput[];
	queues?: QueueInput[];
	registries?: RegistryInput[];
	secrets?: SecretInput[];
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
 *  - one Valkey release per cache; one RabbitMQ release per queue (sync-wave 1);
 *  - one Harbor release per registry (sync-wave 2);
 *  - ONE Vault release for the whole project when any `secret` node exists (sync-wave 0).
 * Each id is unique per node (`db-<name>` / `cache-<name>` / `queue-<name>` / `registry-<name>`) so the runner's
 * `AddOnAppName` yields a distinct ArgoCD Application, and health reads back per component.
 */
export function hetznerDataServicesToAddOns(
	services: HetznerDataServices,
): AddOnInstallSpec[] {
	const specs: AddOnInstallSpec[] = [];

	const databases = services.databases ?? [];
	const caches = services.caches ?? [];
	const queues = services.queues ?? [];
	const registries = services.registries ?? [];
	const secrets = services.secrets ?? [];

	// Secrets → ONE Vault for the project (never one per node: a `secret` node is a KV entry, not a
	// server). syncWave 0 because the ClusterSecretStore over it, and every ExternalSecret that
	// resolves through it, are useless until Vault answers — and nothing waits on the reverse.
	if (secrets.length > 0) {
		specs.push({
			id: HETZNER_VAULT_ADDON_ID,
			mode: "managed",
			chartRepo: HETZNER_CHARTS.vault.chartRepo,
			chart: HETZNER_CHARTS.vault.chart,
			version: HETZNER_CHARTS.vault.version,
			namespace: NS.secret,
			values: hetznerVaultValues(),
			syncWave: 0,
		});
	}

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

	// Registries → Harbor (one release per node). syncWave 2, after the data services: Harbor is
	// the heaviest thing on the cluster (five volumes, its own Postgres/Redis/Trivy) and nothing
	// else waits on it, so it converges last rather than competing for volume attachments while a
	// database is still coming up. Matches the marketplace add-on's own wave.
	for (const registry of registries) {
		specs.push({
			id: `registry-${registry.name}`,
			mode: "managed",
			chartRepo: HETZNER_CHARTS.harbor.chartRepo,
			chart: HETZNER_CHARTS.harbor.chart,
			version: HETZNER_CHARTS.harbor.version,
			namespace: NS.registry,
			values: hetznerRegistryValues(registry),
			syncWave: 2,
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
 * The in-cluster DNS name a `registry` node's Harbor answers on. Exported because it is the
 * registry HOST — it goes into `externalURL`, into the dockerconfigjson the runner seeds, and into
 * the Talos containerd mirror entry, and those three MUST agree or the pull fails in a way that
 * looks like a credential problem.
 */
export function hetznerRegistryHost(name: string): string {
	return `registry-${name}.${NS.registry}.svc.cluster.local`;
}

/**
 * Helm values for one registry node, against the pinned Harbor chart's REAL schema — verified with
 * `helm show values` + `helm template harbor --version 1.15.1`, never guessed. #2058 is why:
 * self-contradictory values render NO manifest at all, and ArgoCD then reports `sync=Unknown`
 * rather than `OutOfSync`, so the failure is invisible.
 *
 *  - `expose.type: clusterIP` with `tls.enabled: false`. NOT `ingress`, the chart default: an
 *    ingress needs an ingress controller AND a resolvable host, and the chart's default host
 *    (`core.harbor.domain`) resolves nowhere — a registry reachable at an address that does not
 *    exist is not a registry. A canvas `registry` node carries no domain, so the cluster network
 *    is the only address it truly has.
 *  - `expose.clusterIP.name` fixes the Service name, so the host is derivable rather than a
 *    function of the Helm release name.
 *  - `externalURL` must agree with how the chart is exposed; Harbor bakes it into the tokens it
 *    issues, so a mismatch yields a registry that authenticates and then 401s on every pull.
 *  - all FIVE volumes are pinned to the hcloud StorageClass at >= 10 GiB. Harbor ships its own
 *    Postgres, Redis and Trivy; the chart's 1Gi/1Gi/5Gi defaults for those are below hcloud's
 *    minimum volume size, so the CSI driver rounds them up and the cluster's actual footprint
 *    stops matching what this repo asked for.
 */
export function hetznerRegistryValues(
	registry: RegistryInput,
): Record<string, unknown> {
	const host = hetznerRegistryHost(registry.name);
	// The image store is the only user-tunable volume; hcloud's floor applies to it too.
	const imageStore = `${Math.max(posInt(registry.storage_gb, 50), HCLOUD_MIN_VOLUME_GB)}Gi`;
	const supporting = {
		size: `${HCLOUD_MIN_VOLUME_GB}Gi`,
		storageClass: HCLOUD_STORAGE_CLASS,
	};
	return {
		// The admin password comes from a Secret the RUNNER seeds and never from a literal here:
		// values are snapshot-persisted and reach the customer's cluster through a rendered
		// manifest. Without these two keys the chart falls back to its published default
		// (`harborAdminPassword: "Harbor12345"`) — which is what #2430 shipped, and what #2431 fixes.
		// The names must match packages/core/argocd/harbor.go exactly; a mismatch is silent.
		existingSecretAdminPassword: `harbor-${registry.name}-admin`,
		existingSecretAdminPasswordKey: "HARBOR_ADMIN_PASSWORD",
		expose: {
			type: "clusterIP",
			tls: { enabled: false },
			clusterIP: { name: `registry-${registry.name}` },
		},
		externalURL: `http://${host}`,
		persistence: {
			persistentVolumeClaim: {
				registry: { size: imageStore, storageClass: HCLOUD_STORAGE_CLASS },
				jobservice: { jobLog: supporting },
				database: supporting,
				redis: supporting,
				trivy: supporting,
			},
		},
	};
}

/**
 * The add-on id of the project's single platform Vault, and therefore — through
 * `argocd.AddOnAppName` — the ArgoCD Application name AND the Helm release name ArgoCD syncs under.
 *
 * ⚠️ The release name is what the chart names its Service (`vault.fullname` is `.Release.Name`), so
 * this id, the namespace, and `hetznerVaultReleaseHost` in packages/core/argocd/vault.go are ONE
 * fact spelled in two languages. The Go test reads it back out of the generated fixture rather than
 * trusting a copy: a drifted host does not error, it resolves nowhere, and the only symptom is a
 * ClusterSecretStore that is simply never Valid.
 */
export const HETZNER_VAULT_ADDON_ID = "secrets-vault";

/**
 * The in-cluster address the platform Vault answers on — the bootstrap Job's api-base and ESO's
 * `server` are both this one address.
 *
 * That they CAN be one address is a property of the chart, not an assumption: its Service sets
 * `publishNotReadyAddresses: true` (verified in the rendered manifest). A sealed Vault fails its
 * readiness probe — `vault status` exits 2 when sealed — so an ordinary Service would carry no
 * endpoints and the bootstrap Job could never reach the very Vault it exists to unseal.
 */
export function hetznerVaultHost(): string {
	return `addon-${HETZNER_VAULT_ADDON_ID}.${NS.secret}.svc.cluster.local`;
}

/**
 * Helm values for the platform Vault, against the pinned chart's REAL schema — verified with
 * `helm show values` + `helm template vault --version 0.28.1`, never guessed.
 *
 *  - `injector.enabled: false`. The Agent sidecar injector is a SECOND delivery path for the same
 *    secrets, carrying a mutating webhook that sits in front of every pod admission in the cluster.
 *    Secrets reach workloads through ESO here, exactly as on the other four clouds; installing a
 *    rival path would be two answers to one question.
 *  - `ui.enabled: false`. The UI is a login surface for a Vault whose only legitimate client is
 *    ESO, and the platform holds the root credential — there is no human meant to log in.
 *  - `server.standalone.enabled: true` / `server.ha.enabled: false`. Raft HA means three replicas,
 *    three volumes and an unseal apiece; one node is what this seal model can actually operate, and
 *    pretending otherwise would ship an HA cluster that stays two-thirds sealed.
 *  - `server.dataStorage` is the KV store; `server.auditStorage` backs the audit device. Audit is
 *    on deliberately: an audit log of every read is the ONLY thing this Vault buys over a plain
 *    Kubernetes Secret (see the custody note in packages/core/argocd/vault.go), so shipping it
 *    without one would make that claim false. Both are pinned to hcloud's StorageClass at its
 *    10 GiB minimum — which is what the CSI driver rounds anything smaller up to anyway.
 */
export function hetznerVaultValues(): Record<string, unknown> {
	const volume = {
		enabled: true,
		size: `${HCLOUD_MIN_VOLUME_GB}Gi`,
		storageClass: HCLOUD_STORAGE_CLASS,
	};
	return {
		injector: { enabled: false },
		ui: { enabled: false },
		server: {
			standalone: { enabled: true },
			ha: { enabled: false },
			dataStorage: volume,
			auditStorage: volume,
		},
	};
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
