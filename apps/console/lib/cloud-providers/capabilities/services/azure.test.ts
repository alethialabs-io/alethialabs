// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// Azure managed-service capability lane (#973). Tests the PURE normalizers against recorded ARM response
// fixtures (the shape each real ARM op returns) + the best-effort guard on the orchestrator. No network
// or DB — the normalizers are separated from IO precisely so they're testable this way.

import { describe, expect, it } from "vitest";
import type { CapabilityIdentity } from "@/lib/cloud-providers/capabilities/types";
import {
	normalizeAksVersions,
	normalizeCosmos,
	normalizeFlexibleServerSkus,
	normalizeFlexibleServerVersions,
	normalizeRedisTiers,
	syncAzureServiceCapabilities,
} from "@/lib/cloud-providers/capabilities/services/azure";

describe("normalizeAksVersions", () => {
	// Recorded shape of Microsoft.ContainerService .../kubernetesVersions (top-level `values`).
	const fixture = {
		values: [
			{ version: "1.28", isDefault: true },
			{ version: "1.29" },
			{ version: "1.30", isPreview: true },
			{ version: "1.29" }, // duplicate — must dedup
			{ isPreview: true }, // no version — must skip
		],
	};

	it("emits one kubernetes offering per distinct version, marking preview", () => {
		const rows = normalizeAksVersions("eastus", fixture);
		expect(rows.map((r) => r.native_id)).toEqual(["1.28", "1.29", "1.30"]);
		for (const r of rows) {
			expect(r.service_kind).toBe("kubernetes");
			expect(r.region).toBe("eastus");
			expect(r.version).toBe(r.native_id);
			expect(r.launchable).toBe("launchable");
			expect(r.launchable_reason).toBe("available");
		}
		expect(rows.find((r) => r.native_id === "1.30")?.name).toContain("preview");
		expect(rows.find((r) => r.native_id === "1.28")?.name).not.toContain("preview");
	});

	it("returns [] for an empty/absent values array", () => {
		expect(normalizeAksVersions("eastus", {})).toEqual([]);
		expect(normalizeAksVersions("eastus", { values: [] })).toEqual([]);
	});
});

describe("normalizeFlexibleServerVersions", () => {
	// Recorded shape of the DBforPostgreSQL/DBforMySQL location capabilities `value[]` — versions nest
	// under supportedFlexibleServerEditions[].supportedServerVersions[].name, repeated across editions.
	const pgFixture = [
		{
			supportedFlexibleServerEditions: [
				{ supportedServerVersions: [{ name: "16" }, { name: "15" }] },
				{ supportedServerVersions: [{ name: "16" }] }, // dup across editions
			],
		},
	];

	// #1351 changed the VALUE SPACE here, not the grain — this lane already emitted one row per
	// version. The engine is now the catalog value (`azure-postgresql`), so synced rows and the static
	// DB_ENGINES fallback are substitutable; otherwise the fail-open path (#918) hands the picker a
	// different engine identity than the synced rows use.
	it("dedups versions and namespaces native_id by the CATALOG engine value (postgres)", () => {
		const rows = normalizeFlexibleServerVersions("eastus", "postgres", pgFixture);
		expect(rows.map((r) => r.native_id)).toEqual([
			"azure-postgresql-16",
			"azure-postgresql-15",
		]);
		for (const r of rows) {
			expect(r.service_kind).toBe("database");
			expect(r.engine).toBe("azure-postgresql");
			expect(r.launchable).toBe("launchable");
		}
		// The version has its own column; `name` is the engine's stable label, not a composite.
		expect(rows[0].name).toBe("Azure Database for PostgreSQL");
		expect(rows[0].version).toBe("16");
	});

	it("reads the SKUs out of the SAME payload, under all three nesting shapes", () => {
		// The PG and MySQL capability specs disagree on where the SKU list hangs, and some api-versions
		// hang it off the EDITION instead of the version. Reading only one path would silently yield
		// zero SKUs on the others, so all three are traversed — this fixture exercises each.
		const skuFixture = [
			{
				supportedFlexibleServerEditions: [
					{
						supportedServerVersions: [
							{
								name: "16",
								supportedVcores: [
									{ name: "Standard_D2s_v3", vCores: 2, supportedMemoryPerVcoreMB: 4096 },
								],
							},
							{
								name: "15",
								// Standard_D2s_v3 repeats across versions → one offering, not two.
								supportedSkus: [{ name: "Standard_D2s_v3" }, { name: "Standard_D4s_v3" }],
							},
						],
					},
					{ supportedServerSkus: [{ name: "Standard_B1ms" }] },
				],
			},
		];
		const rows = normalizeFlexibleServerSkus("eastus", "postgres", skuFixture);
		expect(rows.map((r) => r.native_id).sort()).toEqual([
			"azure-postgresql-Standard_B1ms",
			"azure-postgresql-Standard_D2s_v3",
			"azure-postgresql-Standard_D4s_v3",
		]);
		const d2s = rows.find((r) => r.tier === "Standard_D2s_v3");
		expect(d2s?.service_kind).toBe("database_instance_class");
		expect(d2s?.engine).toBe("azure-postgresql");
		expect(d2s?.version).toBeNull();
		expect(d2s?.mem_gb).toBe(8); // 2 vCores × 4096 MB
		// No size claimed when the payload omits the vCore fields — null, never 0.
		expect(rows.find((r) => r.tier === "Standard_D4s_v3")?.mem_gb).toBeNull();
	});

	it("emits no SKU rows when the capabilities payload carries none", () => {
		expect(normalizeFlexibleServerSkus("eastus", "postgres", pgFixture)).toEqual([]);
	});

	it("handles the mysql shape identically (versions path is shared)", () => {
		const myFixture = [
			{
				supportedFlexibleServerEditions: [
					{ supportedServerVersions: [{ name: "8.0.21" }, { name: "5.7" }] },
				],
			},
		];
		const rows = normalizeFlexibleServerVersions("westus", "mysql", myFixture);
		expect(rows.map((r) => r.native_id)).toEqual([
			"azure-mysql-8.0.21",
			"azure-mysql-5.7",
		]);
		expect(rows[0].engine).toBe("azure-mysql");
		expect(rows[0].name).toBe("Azure Database for MySQL");
		expect(rows[0].version).toBe("8.0.21");
	});

	it("returns [] when there are no editions/versions", () => {
		expect(normalizeFlexibleServerVersions("eastus", "postgres", [])).toEqual([]);
		expect(
			normalizeFlexibleServerVersions("eastus", "postgres", [
				{ supportedFlexibleServerEditions: [] },
			]),
		).toEqual([]);
	});
});

describe("normalizeRedisTiers", () => {
	it("emits the full static SKU catalog as launchable when the RP is registered", () => {
		const rows = normalizeRedisTiers("eastus", true);
		expect(rows).toHaveLength(6); // Managed Redis Balanced_B0/B1/B3/B5/B10/B20
		expect(rows.every((r) => r.service_kind === "cache")).toBe(true);
		expect(rows.every((r) => r.engine === "redis")).toBe(true);
		expect(rows.every((r) => r.launchable === "launchable")).toBe(true);
		// native_id is the ARM sku_name, mirroring catalog.json's azure cache tiers.
		expect(rows.find((r) => r.native_id === "Balanced_B0")?.mem_gb).toBe(0.5);
		expect(rows.find((r) => r.native_id === "Balanced_B1")?.mem_gb).toBe(1);
		expect(rows.find((r) => r.native_id === "Balanced_B20")?.mem_gb).toBe(24);
		// no retired Azure Cache for Redis SKU is offered anymore.
		expect(rows.some((r) => /_C[0-6]$|_P[1-5]$/.test(r.native_id))).toBe(false);
	});

	it("surfaces the tiers as not_launchable when the RP is not registered (account-accurate, not silent)", () => {
		const rows = normalizeRedisTiers("eastus", false);
		expect(rows).toHaveLength(6);
		expect(rows.every((r) => r.launchable === "not_launchable")).toBe(true);
		expect(
			rows.every((r) => r.launchable_reason === "not_available_for_subscription"),
		).toBe(true);
	});
});

describe("normalizeCosmos", () => {
	it("is launchable when registered and the region is offered", () => {
		const r = normalizeCosmos("eastus", true, new Set(["eastus", "westus"]));
		expect(r.service_kind).toBe("nosql");
		expect(r.native_id).toBe("Cosmos DB");
		expect(r.launchable).toBe("launchable");
		expect(r.launchable_reason).toBe("available");
	});

	it("is region_not_offered when registered but the region isn't in the offered set", () => {
		const r = normalizeCosmos("germanynorth", true, new Set(["eastus"]));
		expect(r.launchable).toBe("not_launchable");
		expect(r.launchable_reason).toBe("region_not_offered");
	});

	it("falls back to the registration flag when no offered-region list is available", () => {
		const r = normalizeCosmos("eastus", true, null);
		expect(r.launchable).toBe("launchable");
		const empty = normalizeCosmos("eastus", true, new Set());
		expect(empty.launchable).toBe("launchable");
	});

	it("is not_available_for_subscription when the RP is not registered", () => {
		const r = normalizeCosmos("eastus", false, new Set(["eastus"]));
		expect(r.launchable).toBe("not_launchable");
		expect(r.launchable_reason).toBe("not_available_for_subscription");
	});
});

describe("syncAzureServiceCapabilities (best-effort guard)", () => {
	it("returns without throwing when the identity has no Azure credentials", async () => {
		const identity: CapabilityIdentity = {
			id: "id-1",
			provider: "azure",
			credentials: {},
		};
		await expect(syncAzureServiceCapabilities(identity)).resolves.toBeUndefined();
	});
});
