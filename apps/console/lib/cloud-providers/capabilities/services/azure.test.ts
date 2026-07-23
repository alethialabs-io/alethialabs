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

	it("dedups versions and namespaces native_id by engine (postgres)", () => {
		const rows = normalizeFlexibleServerVersions("eastus", "postgres", pgFixture);
		expect(rows.map((r) => r.native_id)).toEqual(["postgres-16", "postgres-15"]);
		for (const r of rows) {
			expect(r.service_kind).toBe("database");
			expect(r.engine).toBe("postgres");
			expect(r.launchable).toBe("launchable");
		}
		expect(rows[0].name).toBe("PostgreSQL 16");
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
		expect(rows.map((r) => r.native_id)).toEqual(["mysql-8.0.21", "mysql-5.7"]);
		expect(rows[0].engine).toBe("mysql");
		expect(rows[0].name).toBe("MySQL 8.0.21");
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
		expect(rows).toHaveLength(19); // Basic C0–C6 (7) + Standard C0–C6 (7) + Premium P1–P5 (5)
		expect(rows.every((r) => r.service_kind === "cache")).toBe(true);
		expect(rows.every((r) => r.engine === "redis")).toBe(true);
		expect(rows.every((r) => r.launchable === "launchable")).toBe(true);
		// Basic C1 and Standard C1 are distinct offerings (distinct native_id).
		expect(rows.find((r) => r.native_id === "Basic_C1")?.mem_gb).toBe(1);
		expect(rows.find((r) => r.native_id === "Standard_C1")?.mem_gb).toBe(1);
		expect(rows.find((r) => r.native_id === "Premium_P5")?.mem_gb).toBe(120);
	});

	it("surfaces the tiers as not_launchable when the RP is not registered (account-accurate, not silent)", () => {
		const rows = normalizeRedisTiers("eastus", false);
		expect(rows).toHaveLength(19);
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
