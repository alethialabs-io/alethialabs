// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Unit tests for the AWS Wave-2 service-capability normalizers (#972) against recorded SDK-shaped
// fixtures. Pure — no cloud, no DB: they prove the SDK response → `cloud_capability_services` row
// mapping (kind discrimination, latest-version pick, EOL drop, availability gating, honest fail-open).

import type { CacheEngineVersion } from "@aws-sdk/client-elasticache";
import type { ClusterVersionInformation } from "@aws-sdk/client-eks";
import type { DBEngineVersion, OrderableDBInstanceOption } from "@aws-sdk/client-rds";
import { describe, expect, it } from "vitest";
import {
	normalizeCacheTierRows,
	normalizeCacheVersionRows,
	normalizeDatabaseRows,
	normalizeDbInstanceClassRows,
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
	// Inverted by #1351: this used to assert one row per engine AT ITS LATEST major. That collapse is
	// what made an engine-version picker impossible, so the lane now emits every offered major and the
	// read layer groups them back into one engine with a version list.
	it("emits one row per PLATFORM engine AND major, ignoring non-platform engines", () => {
		const fixture: DBEngineVersion[] = [
			{ Engine: "aurora-postgresql", MajorEngineVersion: "15", EngineVersion: "15.4" },
			{ Engine: "aurora-postgresql", MajorEngineVersion: "16", EngineVersion: "16.6" },
			{ Engine: "aurora-mysql", MajorEngineVersion: "8.0", EngineVersion: "8.0.mysql_aurora.3.05.2" },
			{ Engine: "postgres", MajorEngineVersion: "17" }, // not a platform engine → ignored
			{ Engine: "oracle-ee", MajorEngineVersion: "19" }, // not a platform engine → ignored
		];
		const rows = normalizeDatabaseRows(fixture, ctx);

		// Both PG majors survive, newest-first, each under a composite native_id — the unique key
		// carries native_id but not version, so a bare-engine id would overwrite the older major.
		expect(rows.map((r) => r.native_id)).toEqual([
			"aurora-postgresql-16",
			"aurora-postgresql-15",
			"aurora-mysql-8.0",
		]);

		const pg16 = rows.find((r) => r.native_id === "aurora-postgresql-16");
		expect(pg16?.service_kind).toBe("database");
		expect(pg16?.engine).toBe("aurora-postgresql"); // the catalog value, not the composite
		expect(pg16?.version).toBe("16");
		expect(pg16?.name).toBe("Aurora PostgreSQL"); // label from the catalog
		expect(pg16?.launchable).toBe("launchable");

		// The older major is a peer row, not a casualty.
		expect(rows.find((r) => r.native_id === "aurora-postgresql-15")?.version).toBe("15");

		const mysql = rows.find((r) => r.engine === "aurora-mysql");
		expect(mysql?.version).toBe("8.0");
		expect(mysql?.name).toBe("Aurora MySQL");
	});

	it("collapses the many MINORS the API returns into one row per major", () => {
		// DescribeDBEngineVersions returns a row per minor; the platform provisions at major grain, so
		// 16.4/16.6/16.8 must not become three separate offerings.
		const fixture: DBEngineVersion[] = [
			{ Engine: "aurora-postgresql", MajorEngineVersion: "16", EngineVersion: "16.4" },
			{ Engine: "aurora-postgresql", MajorEngineVersion: "16", EngineVersion: "16.6" },
			{ Engine: "aurora-postgresql", MajorEngineVersion: "16", EngineVersion: "16.8" },
		];
		const rows = normalizeDatabaseRows(fixture, ctx);
		expect(rows).toHaveLength(1);
		expect(rows[0].native_id).toBe("aurora-postgresql-16");
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

describe("normalizeCacheVersionRows", () => {
	it("emits one row per (engine, version), newest-first, from the SAME gating response", () => {
		const engines: CacheEngineVersion[] = [
			{ Engine: "redis", EngineVersion: "7.1" },
			{ Engine: "redis", EngineVersion: "6.2" },
			{ Engine: "redis", EngineVersion: "7.1" }, // dup → collapsed
			{ Engine: "valkey", EngineVersion: "8.0" },
			{ Engine: "memcached" }, // no version → skipped
		];
		const rows = normalizeCacheVersionRows(engines, ctx);
		expect(rows.map((r) => r.native_id)).toEqual(["redis-7.1", "redis-6.2", "valkey-8.0"]);
		const redis71 = rows[0];
		expect(redis71.service_kind).toBe("cache_version");
		expect(redis71.engine).toBe("redis");
		expect(redis71.version).toBe("7.1");
		expect(redis71.tier).toBeNull();
		expect(redis71.launchable).toBe("launchable");
	});

	it("never collides with the cache TIER rows built from the same response", () => {
		const engines: CacheEngineVersion[] = [{ Engine: "redis", EngineVersion: "7.1" }];
		const tiers = normalizeCacheTierRows(engines, ctx);
		const versions = normalizeCacheVersionRows(engines, ctx);
		// Both kinds land in one table and the sweep soft-removes by native_id across kinds, so an
		// overlap would let one axis retire the other's rows.
		const overlap = tiers
			.map((t) => t.native_id)
			.filter((id) => versions.some((v) => v.native_id === id));
		expect(overlap).toEqual([]);
	});

	it("returns no rows (fail-open) for an empty response", () => {
		expect(normalizeCacheVersionRows([], ctx)).toEqual([]);
	});
});

describe("normalizeDbInstanceClassRows", () => {
	it("dedupes the (version × AZ) repeats into one row per (engine, SKU)", () => {
		const fixture: OrderableDBInstanceOption[] = [
			{ Engine: "aurora-postgresql", EngineVersion: "16.6", DBInstanceClass: "db.r6g.large" },
			{ Engine: "aurora-postgresql", EngineVersion: "15.4", DBInstanceClass: "db.r6g.large" },
			{ Engine: "aurora-postgresql", EngineVersion: "16.6", DBInstanceClass: "db.r6g.xlarge" },
			{ Engine: "aurora-mysql", EngineVersion: "8.0", DBInstanceClass: "db.r6g.large" },
			{ Engine: "postgres", DBInstanceClass: "db.t4g.micro" }, // not a platform engine → ignored
			{ Engine: "aurora-postgresql" }, // no class → skipped
		];
		const rows = normalizeDbInstanceClassRows(fixture, ctx);
		expect(rows.map((r) => r.native_id)).toEqual([
			"aurora-postgresql-db.r6g.large",
			"aurora-postgresql-db.r6g.xlarge",
			"aurora-mysql-db.r6g.large",
		]);
		const first = rows[0];
		expect(first.service_kind).toBe("database_instance_class");
		expect(first.engine).toBe("aurora-postgresql");
		// The bare SKU lives in `tier` — that is what the picker offers; native_id is only the key.
		expect(first.tier).toBe("db.r6g.large");
		expect(first.version).toBeNull();
	});

	it("keeps the same SKU under two engines as two offerings", () => {
		const fixture: OrderableDBInstanceOption[] = [
			{ Engine: "aurora-postgresql", DBInstanceClass: "db.r6g.large" },
			{ Engine: "aurora-mysql", DBInstanceClass: "db.r6g.large" },
		];
		const rows = normalizeDbInstanceClassRows(fixture, ctx);
		expect(rows).toHaveLength(2);
		expect(new Set(rows.map((r) => r.native_id)).size).toBe(2);
	});

	it("returns no rows (fail-open) for an empty response", () => {
		expect(normalizeDbInstanceClassRows([], ctx)).toEqual([]);
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
