// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The DB capability read path had NO test file before #1351, which is how the cross-region
// duplication below survived: the lanes emit one row per (engine, version) AND per region, but the
// reader projected `native_id` as the engine identity, so an Azure account — whose lane enumerates
// every subscription location — saw `azure-postgresql-16` once per region as a separate "engine".
//
// These drive the pure fold directly (no DB, no authz), which is the same shape the lane tests use.

import { describe, expect, it } from "vitest";
import {
	type DbCapabilityRow,
	groupDbEnginesByVersion,
} from "@/lib/queries/capabilities";

/** A federated row as the reader selects it; region is folded away by the grouping. */
function row(over: Partial<DbCapabilityRow>): DbCapabilityRow {
	return {
		engine: "azure-postgresql",
		nativeId: "azure-postgresql-16",
		name: "Azure Database for PostgreSQL",
		version: "16",
		launchable: "launchable",
		launchableReason: "available",
		...over,
	};
}

describe("groupDbEnginesByVersion", () => {
	it("folds one row per (engine, version) into one engine carrying every version", () => {
		const out = groupDbEnginesByVersion([
			row({ nativeId: "azure-postgresql-15", version: "15" }),
			row({ nativeId: "azure-postgresql-16", version: "16" }),
		]);

		expect(out).toHaveLength(1);
		expect(out[0].value).toBe("azure-postgresql");
		expect(out[0].versions).toEqual(["16", "15"]); // newest-first, the picker's order
		expect(out[0].label).toBe("Azure Database for PostgreSQL");
	});

	// THE bug this unit fixes.
	it("collapses the same version repeated across regions into ONE engine", () => {
		const regions = ["eastus", "westus", "northeurope", "japaneast"];
		const rows = regions.flatMap((_r) => [
			row({ nativeId: "azure-postgresql-16", version: "16" }),
			row({ nativeId: "azure-postgresql-15", version: "15" }),
		]);

		const out = groupDbEnginesByVersion(rows);

		// Before: 8 rows → 8 "engines". After: one engine, two versions.
		expect(out).toHaveLength(1);
		expect(out[0].versions).toEqual(["16", "15"]);
	});

	it("keeps distinct engines apart and orders them stably", () => {
		const out = groupDbEnginesByVersion([
			row({ engine: "azure-mysql", nativeId: "azure-mysql-8.0", version: "8.0", name: "MySQL" }),
			row({ nativeId: "azure-postgresql-16", version: "16" }),
		]);

		expect(out.map((e) => e.value)).toEqual(["azure-mysql", "azure-postgresql"]);
	});

	it("sorts versions numerically, not lexically", () => {
		// "9" > "10" as strings — the trap a naive sort falls into.
		const out = groupDbEnginesByVersion([
			row({ nativeId: "azure-postgresql-9", version: "9" }),
			row({ nativeId: "azure-postgresql-10", version: "10" }),
			row({ nativeId: "azure-postgresql-16", version: "16" }),
		]);

		expect(out[0].versions).toEqual(["16", "10", "9"]);
	});

	it("reports `version` as the newest offered, so single-value callers stay correct", () => {
		const out = groupDbEnginesByVersion([
			row({ nativeId: "azure-postgresql-15", version: "15" }),
			row({ nativeId: "azure-postgresql-16", version: "16" }),
		]);

		expect(out[0].version).toBe("16");
	});

	// The rows differ by REGION and the picker is not region-scoped, so reporting the worst region's
	// verdict would understate what the account can actually launch.
	it("merges verdicts permissively across regions", () => {
		const out = groupDbEnginesByVersion([
			row({ version: "16", launchable: "not_launchable", launchableReason: "quota_zero" }),
			row({ version: "16", launchable: "launchable", launchableReason: "available" }),
		]);

		expect(out[0].launchable).toBe("launchable");
		expect(out[0].launchableReason).toBe("available");
	});

	it("prefers not_evaluable over not_launchable — unknown is not a denial", () => {
		const out = groupDbEnginesByVersion([
			row({ version: "16", launchable: "not_launchable", launchableReason: "quota_zero" }),
			row({ version: "16", launchable: "not_evaluable", launchableReason: "quota_unknown" }),
		]);

		expect(out[0].launchable).toBe("not_evaluable");
	});

	// A row written before the lanes canonicalized must not crash or split an engine in two. The next
	// sweep soft-removes it (softRemoveUnseen keys on native_id), but the picker runs before that.
	it("falls back to native_id when a legacy row has no engine", () => {
		const out = groupDbEnginesByVersion([
			row({ engine: null, nativeId: "cloudsql-postgresql", version: "15" }),
		]);

		expect(out[0].value).toBe("cloudsql-postgresql");
		expect(out[0].versions).toEqual(["15"]);
	});

	it("tolerates a row with no version at all", () => {
		const out = groupDbEnginesByVersion([row({ version: null })]);

		expect(out).toHaveLength(1);
		expect(out[0].versions).toEqual([]);
	});

	it("returns nothing for no rows, so the caller's fail-open branch takes over", () => {
		expect(groupDbEnginesByVersion([])).toEqual([]);
	});
});
