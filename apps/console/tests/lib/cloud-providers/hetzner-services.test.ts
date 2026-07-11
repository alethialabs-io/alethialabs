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

describe("hetznerDataServicesToAddOns — caches (Valkey)", () => {
	it("explicit storage_gb wins over the memory_gb fallback", () => {
		const specs = hetznerDataServicesToAddOns({
			caches: [{ name: "primary", memory_gb: 4, storage_gb: 32 }],
		});
		const primary = values(specs.find((s) => s.id === "cache-primary")).primary;
		expect(primary.persistence).toMatchObject({ size: "32Gi" });
	});

	it("falls back to memory_gb, then the 8Gi default", () => {
		const specs = hetznerDataServicesToAddOns({
			caches: [
				{ name: "mem", memory_gb: 4 },
				{ name: "bare" },
			],
		});
		expect(values(specs.find((s) => s.id === "cache-mem")).primary.persistence)
			.toMatchObject({ size: "4Gi" });
		expect(values(specs.find((s) => s.id === "cache-bare")).primary.persistence)
			.toMatchObject({ size: "8Gi" });
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
});
