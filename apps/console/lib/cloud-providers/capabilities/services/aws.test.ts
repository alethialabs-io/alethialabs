// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Unit tests for the AWS Wave-2 service-capability normalizers (#972) against recorded SDK-shaped
// fixtures. Pure — no cloud, no DB: they prove the SDK response → `cloud_capability_services` row
// mapping (kind discrimination, latest-version pick, EOL drop, availability gating, honest fail-open).

import type { CacheEngineVersion } from "@aws-sdk/client-elasticache";
import type { ClusterVersionInformation } from "@aws-sdk/client-eks";
import type { DBEngineVersion } from "@aws-sdk/client-rds";
import { describe, expect, it } from "vitest";
import {
	normalizeCacheTierRows,
	normalizeDatabaseRows,
	normalizeK8sVersionRows,
	normalizeNosqlRows,
	type ServiceNormalizeCtx,
} from "./aws";

const ctx: ServiceNormalizeCtx = {
	cloudIdentityId: "ci-1",
	region: "us-east-1",
	now: new Date("2026-01-01T00:00:00Z"),
};

describe("normalizeK8sVersionRows", () => {
	it("keeps supported versions (deduped), drops UNSUPPORTED, maps to kubernetes rows", () => {
		const fixture: ClusterVersionInformation[] = [
			{ clusterVersion: "1.35", versionStatus: "STANDARD_SUPPORT" },
			{ clusterVersion: "1.34", versionStatus: "STANDARD_SUPPORT" },
			{ clusterVersion: "1.30", versionStatus: "EXTENDED_SUPPORT" },
			{ clusterVersion: "1.28", versionStatus: "UNSUPPORTED" }, // EOL → dropped
			{ clusterVersion: "1.35", versionStatus: "STANDARD_SUPPORT" }, // dup → collapsed
			{ versionStatus: "STANDARD_SUPPORT" }, // no version → skipped
		];
		const rows = normalizeK8sVersionRows(fixture, ctx);
		expect(rows.map((r) => r.native_id)).toEqual(["1.35", "1.34", "1.30"]);
		for (const r of rows) {
			expect(r.service_kind).toBe("kubernetes");
			expect(r.provider).toBe("aws");
			expect(r.region).toBe("us-east-1");
			expect(r.version).toBe(r.native_id);
			expect(r.launchable).toBe("launchable");
			expect(r.launchable_reason).toBe("available");
			expect(r.removed_at).toBeNull();
		}
	});

	it("returns no rows for an empty response", () => {
		expect(normalizeK8sVersionRows([], ctx)).toEqual([]);
	});
});

describe("normalizeDatabaseRows", () => {
	it("emits one row per PLATFORM engine at its latest major, ignoring non-platform engines", () => {
		const fixture: DBEngineVersion[] = [
			{ Engine: "aurora-postgresql", MajorEngineVersion: "15", EngineVersion: "15.4" },
			{ Engine: "aurora-postgresql", MajorEngineVersion: "16", EngineVersion: "16.6" },
			{ Engine: "aurora-mysql", MajorEngineVersion: "8.0", EngineVersion: "8.0.mysql_aurora.3.05.2" },
			{ Engine: "postgres", MajorEngineVersion: "17" }, // not a platform engine → ignored
			{ Engine: "oracle-ee", MajorEngineVersion: "19" }, // not a platform engine → ignored
		];
		const rows = normalizeDatabaseRows(fixture, ctx);
		const byEngine = new Map(rows.map((r) => [r.engine, r]));
		expect([...byEngine.keys()].sort()).toEqual(["aurora-mysql", "aurora-postgresql"]);

		const pg = byEngine.get("aurora-postgresql");
		expect(pg?.service_kind).toBe("database");
		expect(pg?.native_id).toBe("aurora-postgresql");
		expect(pg?.version).toBe("16"); // 16 > 15 by numeric major compare
		expect(pg?.name).toBe("Aurora PostgreSQL"); // label from the catalog
		expect(pg?.launchable).toBe("launchable");

		const mysql = byEngine.get("aurora-mysql");
		expect(mysql?.version).toBe("8.0");
		expect(mysql?.name).toBe("Aurora MySQL");
	});

	it("returns no rows when the account offers no platform engines", () => {
		const fixture: DBEngineVersion[] = [{ Engine: "mariadb", MajorEngineVersion: "10.11" }];
		expect(normalizeDatabaseRows(fixture, ctx)).toEqual([]);
	});
});

describe("normalizeCacheTierRows", () => {
	it("gates the catalog tiers on ElastiCache availability", () => {
		const engines: CacheEngineVersion[] = [{ Engine: "redis", EngineVersion: "7.1" }];
		const rows = normalizeCacheTierRows(engines, ctx);
		expect(rows.length).toBeGreaterThan(0);
		expect(rows.every((r) => r.service_kind === "cache")).toBe(true);
		const micro = rows.find((r) => r.native_id === "cache.t3.micro");
		expect(micro?.tier).toBe("cache.t3.micro");
		expect(micro?.mem_gb).toBe(0.5); // memory carried from the catalog
		expect(micro?.launchable).toBe("launchable");
	});

	it("returns no rows (fail-open) when ElastiCache exposes no engines", () => {
		expect(normalizeCacheTierRows([], ctx)).toEqual([]);
	});
});

describe("normalizeNosqlRows", () => {
	it("emits one DynamoDB row when available", () => {
		const rows = normalizeNosqlRows(true, ctx);
		expect(rows).toHaveLength(1);
		expect(rows[0].service_kind).toBe("nosql");
		expect(rows[0].native_id).toBe("DynamoDB");
		expect(rows[0].name).toBe("DynamoDB");
		expect(rows[0].launchable).toBe("launchable");
	});

	it("returns no rows (fail-open) when DynamoDB is not reachable", () => {
		expect(normalizeNosqlRows(false, ctx)).toEqual([]);
	});
});
