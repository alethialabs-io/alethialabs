// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Hetzner in-cluster data services: canvas database/cache/queue nodes map to Helm install
// specs (CloudNativePG / Valkey / RabbitMQ). These pin the user-tunable sizing path — the
// optional `storage_gb`/`replicas` columns flow into the chart values, NULL keeps the
// mapper defaults authoritative, and a cache's explicit storage wins over memory_gb.

import { describe, expect, it } from "vitest";
import {
	HETZNER_CHARTS,
	hetznerDataServicesToAddOns,
} from "@/lib/cloud-providers/hetzner-services";

/** Narrow a spec's `values` for nested reads without repeating casts in every test. */
function values(spec: { values?: Record<string, unknown> } | undefined) {
	return (spec?.values ?? {}) as Record<string, Record<string, unknown>>;
}

describe("hetznerDataServicesToAddOns — databases (CloudNativePG)", () => {
	it("applies defaults (10Gi / 1 instance) when sizing is NULL", () => {
		const specs = hetznerDataServicesToAddOns({
			databases: [{ name: "primary", storage_gb: null, replicas: null }],
		});
		const db = specs.find((s) => s.id === "db-primary");
		const cluster = values(db).cluster;
		expect(cluster.instances).toBe(1);
		expect(cluster.storage).toMatchObject({ size: "10Gi" });
	});

	it("flows explicit storage_gb and replicas into the Cluster values", () => {
		const specs = hetznerDataServicesToAddOns({
			databases: [{ name: "primary", storage_gb: 50, replicas: 3 }],
		});
		const cluster = values(specs.find((s) => s.id === "db-primary")).cluster;
		expect(cluster.instances).toBe(3);
		expect(cluster.storage).toMatchObject({ size: "50Gi" });
	});

	it("installs the CNPG operator once (sync-wave 0) when any Postgres DB exists", () => {
		const specs = hetznerDataServicesToAddOns({
			databases: [{ name: "a" }, { name: "b" }],
		});
		const operators = specs.filter((s) => s.id === "cnpg-operator");
		expect(operators).toHaveLength(1);
		expect(operators[0].syncWave).toBe(0);
		expect(operators[0].chart).toBe(HETZNER_CHARTS.cnpgOperator.chart);
	});

	it("clamps invalid sizing (negatives / NaN / floats) via posInt", () => {
		const specs = hetznerDataServicesToAddOns({
			databases: [
				{ name: "neg", storage_gb: -5, replicas: 0 },
				{ name: "nan", storage_gb: Number.NaN, replicas: Number.NaN },
				{ name: "frac", storage_gb: 20.9, replicas: 2.7 },
			],
		});
		expect(values(specs.find((s) => s.id === "db-neg")).cluster).toMatchObject({
			instances: 1,
			storage: expect.objectContaining({ size: "10Gi" }),
		});
		expect(values(specs.find((s) => s.id === "db-nan")).cluster).toMatchObject({
			instances: 1,
			storage: expect.objectContaining({ size: "10Gi" }),
		});
		// Fractional inputs floor rather than round.
		expect(values(specs.find((s) => s.id === "db-frac")).cluster).toMatchObject({
			instances: 2,
			storage: expect.objectContaining({ size: "20Gi" }),
		});
	});
});

// The cache chart moved from Bitnami (whose valkey 1.0.6 was DELETED from the index — ArgoCD
// could not fetch it, so Hetzner caches were broken in prod) to the UPSTREAM valkey-io chart.
// Its value schema is completely different, so these assertions are written against the keys the
// real chart actually reads (verified with `helm show values` + `helm template`) — a mapping
// translated by eye ships a chart that silently ignores sizing, or hard-fails at sync.
describe("hetznerDataServicesToAddOns — caches (Valkey, upstream valkey-io chart)", () => {
	it("targets the upstream valkey-io chart, not Bitnami", () => {
		const specs = hetznerDataServicesToAddOns({ caches: [{ name: "primary" }] });
		const spec = specs.find((s) => s.id === "cache-primary");
		expect(spec?.chartRepo).toBe("https://valkey-io.github.io/valkey-helm");
		expect(spec?.chartRepo).not.toContain("bitnami");
	});

	it("explicit storage_gb wins over the memory_gb fallback (dataStorage.requestedSize)", () => {
		const specs = hetznerDataServicesToAddOns({
			caches: [{ name: "primary", memory_gb: 4, storage_gb: 32 }],
		});
		const v = values(specs.find((s) => s.id === "cache-primary"));
		expect(v.dataStorage).toMatchObject({
			enabled: true,
			requestedSize: "32Gi",
			className: "hcloud-volumes",
		});
	});

	it("uses the chart's REAL storage keys (dataStorage.requestedSize/className)", () => {
		const specs = hetznerDataServicesToAddOns({
			caches: [{ name: "primary", storage_gb: 32 }],
		});
		const v = values(specs.find((s) => s.id === "cache-primary"));
		const ds = v.dataStorage as Record<string, unknown>;
		// The Bitnami keys are gone — asserting their ABSENCE is what keeps a future edit from
		// silently reintroducing values this chart ignores.
		expect(v).not.toHaveProperty("primary");
		expect(v).not.toHaveProperty("architecture");
		expect(ds).not.toHaveProperty("size");
		expect(ds).not.toHaveProperty("storageClass");
		expect(ds.requestedSize).toBe("32Gi");
		expect(ds.className).toBe("hcloud-volumes");
	});

	it("replicas are ADDITIONAL to the primary (N nodes ⇒ N-1 replicas) and carry mandatory persistence", () => {
		const specs = hetznerDataServicesToAddOns({
			caches: [{ name: "primary", storage_gb: 32, num_cache_nodes: 3 }],
		});
		const replica = values(specs.find((s) => s.id === "cache-primary"))
			.replica as Record<string, unknown>;
		expect(replica.enabled).toBe(true);
		// 3 nodes = 1 primary + 2 replicas. (Bitnami's key was `replicaCount`.)
		expect(replica.replicas).toBe(2);
		// MANDATORY when replicas are on: the chart hard-errors with "Replica mode requires
		// persistent storage" without it — the exact trap a guessed mapping falls into.
		expect(replica.persistence).toMatchObject({
			size: "32Gi",
			storageClass: "hcloud-volumes",
		});
	});

	it("a single-node cache disables replication (no replica StatefulSet)", () => {
		const specs = hetznerDataServicesToAddOns({
			caches: [{ name: "solo", storage_gb: 8 }],
		});
		const replica = values(specs.find((s) => s.id === "cache-solo"))
			.replica as Record<string, unknown>;
		expect(replica.enabled).toBe(false);
		expect(replica.replicas).toBe(0);
	});

	it("falls back to memory_gb, then the 8Gi default", () => {
		const specs = hetznerDataServicesToAddOns({
			caches: [{ name: "mem", memory_gb: 4 }, { name: "bare" }],
		});
		expect(values(specs.find((s) => s.id === "cache-mem")).dataStorage).toMatchObject(
			{ requestedSize: "4Gi" },
		);
		expect(values(specs.find((s) => s.id === "cache-bare")).dataStorage).toMatchObject(
			{ requestedSize: "8Gi" },
		);
	});
});

describe("hetznerDataServicesToAddOns — queues (RabbitMQ)", () => {
	it("applies the 8Gi default and flows explicit storage_gb", () => {
		const specs = hetznerDataServicesToAddOns({
			queues: [{ name: "jobs" }, { name: "big", storage_gb: 64 }],
		});
		expect(values(specs.find((s) => s.id === "queue-jobs")).persistence)
			.toMatchObject({ size: "8Gi" });
		expect(values(specs.find((s) => s.id === "queue-big")).persistence)
			.toMatchObject({ size: "64Gi" });
	});

	it("uses the chart's `persistence.storageClass` key (NOT the k8s storageClassName)", () => {
		const specs = hetznerDataServicesToAddOns({ queues: [{ name: "jobs" }] });
		const persistence = values(specs.find((s) => s.id === "queue-jobs")).persistence;
		expect(persistence.enabled).toBe(true);
		expect(persistence.storageClass).toBe("hcloud-volumes");
		expect(persistence).not.toHaveProperty("storageClassName");
	});

	// bitnami/rabbitmq 14.7.0's default image (docker.io/bitnami/rabbitmq:3.13.7-debian-12-r2) is
	// now HTTP 404 — Broadcom relocated the Bitnami images to bitnamilegacy/* — so every fresh
	// Hetzner queue ImagePullBackOff'd. The replacement chart pulls the OFFICIAL docker.io/rabbitmq
	// image. Guard the repo so nobody drifts back onto the archive.
	it("does NOT use a Bitnami chart (its images were relocated and 404)", () => {
		const specs = hetznerDataServicesToAddOns({ queues: [{ name: "jobs" }] });
		const spec = specs.find((s) => s.id === "queue-jobs");
		expect(spec?.chartRepo).not.toContain("bitnami");
		expect(spec?.chartRepo).toBe("https://cloudpirates-io.github.io/helm-charts");
	});
});

describe("hetznerDataServicesToAddOns — engine filtering (databases)", () => {
	it("charts only postgres-family databases (NULL family defaults to postgres)", () => {
		const specs = hetznerDataServicesToAddOns({
			databases: [
				{ name: "pg", engine_family: "postgres" },
				{ name: "legacy", engine_family: null },
				{ name: "my", engine_family: "mysql" },
			],
		});
		expect(specs.some((s) => s.id === "db-pg")).toBe(true);
		expect(specs.some((s) => s.id === "db-legacy")).toBe(true);
		// The mapper drops it — buildConfigSnapshot's fail-closed gate must throw first.
		expect(specs.some((s) => s.id === "db-my")).toBe(false);
	});
});
