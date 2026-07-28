// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// Alibaba Wave-2 service lane (#975) — unit tests for the pure normalizers against recorded (trimmed) SDK
// response fixtures. The normalizers are the risk surface (SDK response shape → capability rows); they take
// no DB/network, so these assert the mapping deterministically.

import { describe, expect, it } from "vitest";
import {
	type K8sVersionMeta,
	type RdsAvailableZone,
	normalizeCacheTiers,
	normalizeCacheVersions,
	normalizeDbEngines,
	normalizeDbInstanceClasses,
	normalizeK8sVersions,
	normalizeNosql,
	pickClassQueries,
} from "./alibaba";

const IDENTITY = "id-1";
const REGION = "cn-hangzhou";

describe("normalizeK8sVersions", () => {
	it("emits one launchable row per distinct creatable version", () => {
		// Recorded DescribeKubernetesVersionMetadata response body (trimmed).
		const metas: K8sVersionMeta[] = [
			{ version: "1.32.1-aliyun.1", creatable: true },
			{ version: "1.30.1-aliyun.1", creatable: true },
			{ version: "1.30.1-aliyun.1", creatable: true }, // duplicate → deduped
		];
		const rows = normalizeK8sVersions(IDENTITY, REGION, metas);
		expect(rows).toHaveLength(2);
		expect(rows.map((r) => r.native_id).sort()).toEqual([
			"1.30.1-aliyun.1",
			"1.32.1-aliyun.1",
		]);
		expect(rows[0]).toMatchObject({
			cloud_identity_id: IDENTITY,
			provider: "alibaba",
			region: REGION,
			service_kind: "kubernetes",
			launchable: "launchable",
			launchable_reason: "available",
		});
		expect(rows[0].version).toBe(rows[0].native_id);
	});

	it("omits deprecated (creatable=false) and malformed versions", () => {
		const metas: K8sVersionMeta[] = [
			{ version: "1.28.0-aliyun.1", creatable: false },
			{ version: "", creatable: true },
			{ version: null, creatable: true },
			{ creatable: true },
		];
		expect(normalizeK8sVersions(IDENTITY, REGION, metas)).toEqual([]);
	});
});

describe("normalizeDbEngines", () => {
	it("emits one row per distinct engine+version with a composite native_id", () => {
		// Recorded DescribeAvailableZones body.availableZones (trimmed).
		const zones: RdsAvailableZone[] = [
			{
				supportedEngines: [
					{
						engine: "PostgreSQL",
						supportedEngineVersions: [{ version: "16.0" }, { version: "15.0" }],
					},
					{ engine: "MySQL", supportedEngineVersions: [{ version: "8.0" }] },
				],
			},
			{
				// A second zone repeating PostgreSQL 16.0 → deduped.
				supportedEngines: [
					{
						engine: "PostgreSQL",
						supportedEngineVersions: [{ version: "16.0" }],
					},
				],
			},
		];
		const rows = normalizeDbEngines(IDENTITY, REGION, zones);
		expect(rows.map((r) => r.native_id).sort()).toEqual([
			"MySQL-8.0",
			"PostgreSQL-15.0",
			"PostgreSQL-16.0",
		]);
		const pg16 = rows.find((r) => r.native_id === "PostgreSQL-16.0");
		expect(pg16).toMatchObject({
			service_kind: "database",
			engine: "PostgreSQL",
			version: "16.0",
			name: "PostgreSQL 16.0",
			launchable: "launchable",
		});
	});

	it("skips engines/versions with no id", () => {
		const zones: RdsAvailableZone[] = [
			{ supportedEngines: [{ engine: "", supportedEngineVersions: [{ version: "1" }] }] },
			{ supportedEngines: [{ engine: "MySQL", supportedEngineVersions: [{ version: null }] }] },
			{ supportedEngines: null },
		];
		expect(normalizeDbEngines(IDENTITY, REGION, zones)).toEqual([]);
	});
});

describe("pickClassQueries", () => {
	// The zones response already carries every parameter DescribeAvailableClasses requires, so the
	// anchor is derived from it rather than guessed — and derived PURELY, so it can't be an accident of
	// response ordering.
	const zones: RdsAvailableZone[] = [
		{
			zoneId: "cn-hangzhou-h",
			supportedEngines: [
				{
					engine: "PostgreSQL",
					supportedEngineVersions: [
						{
							version: "15.0",
							supportedCategorys: [
								{
									category: "HighAvailability",
									supportedStorageTypes: [{ storageType: "cloud_essd" }],
								},
							],
						},
						{
							version: "16.0",
							supportedCategorys: [
								{
									category: "HighAvailability",
									supportedStorageTypes: [
										{ storageType: "cloud_essd" },
										{ storageType: "cloud_ssd" },
									],
								},
							],
						},
					],
				},
			],
		},
	];

	it("asks once per engine, anchored at its NEWEST offered version", () => {
		const queries = pickClassQueries(zones);
		expect(queries).toHaveLength(1);
		expect(queries[0]).toEqual({
			engine: "PostgreSQL",
			engineVersion: "16.0",
			zoneId: "cn-hangzhou-h",
			category: "HighAvailability",
			storageType: "cloud_essd",
		});
	});

	it("skips a tuple that is incomplete rather than asking a malformed question", () => {
		expect(
			pickClassQueries([
				{ zoneId: null, supportedEngines: [{ engine: "MySQL" }] },
				{ zoneId: "z", supportedEngines: [{ engine: "MySQL", supportedEngineVersions: null }] },
				{
					zoneId: "z",
					// A version with no category cannot be asked about.
					supportedEngines: [{ engine: "MySQL", supportedEngineVersions: [{ version: "8.0" }] }],
				},
			]),
		).toEqual([]);
	});
});

describe("normalizeDbInstanceClasses", () => {
	it("emits one row per class, keyed <engine>-<class> with the bare class in tier", () => {
		const rows = normalizeDbInstanceClasses(IDENTITY, REGION, "PostgreSQL", [
			{ DBInstanceClass: "pg.n2.2c.1m" },
			{ DBInstanceClass: "pg.n2.4c.1m" },
			{ DBInstanceClass: "pg.n2.2c.1m" }, // dup → collapsed
			{ DBInstanceClass: null },
		]);
		expect(rows.map((r) => r.native_id)).toEqual([
			"PostgreSQL-pg.n2.2c.1m",
			"PostgreSQL-pg.n2.4c.1m",
		]);
		expect(rows[0]).toMatchObject({
			service_kind: "database_instance_class",
			engine: "PostgreSQL",
			tier: "pg.n2.2c.1m",
			launchable: "launchable",
		});
	});

	it("returns no rows for an empty response (fail-open)", () => {
		expect(normalizeDbInstanceClasses(IDENTITY, REGION, "MySQL", [])).toEqual([]);
	});
});

describe("normalizeCacheVersions", () => {
	it("carries the enclosing engine down to the versions nested far below it", () => {
		const body = {
			availableZones: {
				availableZone: [
					{
						supportedEngines: {
							supportedEngine: [
								{
									engine: "Redis",
									supportedEditionTypes: {
										supportedEditionType: [
											{
												supportedSeriesTypes: {
													supportedSeriesType: [
														{
															supportedEngineVersions: {
																supportedEngineVersion: [
																	{ version: "7.0" },
																	{ version: "6.0" },
																	{ version: "7.0" }, // dup → collapsed
																],
															},
														},
													],
												},
											},
										],
									},
								},
							],
						},
					},
				],
			},
		};
		const rows = normalizeCacheVersions(IDENTITY, REGION, body);
		expect(rows.map((r) => r.native_id)).toEqual(["Redis-7.0", "Redis-6.0"]);
		expect(rows[0]).toMatchObject({
			service_kind: "cache_version",
			engine: "Redis",
			version: "7.0",
			launchable: "launchable",
		});
	});

	it("emits nothing when no engine encloses the versions", () => {
		// A version with no engine to attach it to is not an offering — better no row than a fabricated one.
		expect(normalizeCacheVersions(IDENTITY, REGION, { some: { version: "7.0" } })).toEqual([]);
	});

	it("returns no rows for an empty/garbage body", () => {
		expect(normalizeCacheVersions(IDENTITY, REGION, null)).toEqual([]);
		expect(normalizeCacheVersions(IDENTITY, REGION, {})).toEqual([]);
	});
});

describe("normalizeCacheTiers", () => {
	it("deep-walks the nested response to collect instance classes + capacity", () => {
		// Recorded DescribeAvailableResource body — the real KVStore shape double-nests the arrays.
		const body = {
			availableZones: {
				availableZone: [
					{
						zoneId: "cn-hangzhou-h",
						supportedEngines: {
							supportedEngine: [
								{
									supportedEditionTypes: {
										supportedEditionType: [
											{
												availableResources: {
													availableResource: [
														{ instanceClass: "redis.master.small.default", capacity: 1024 },
														{ instanceClass: "redis.master.mid.default", capacity: 2048 },
													],
												},
											},
										],
									},
								},
							],
						},
					},
				],
			},
		};
		const rows = normalizeCacheTiers(IDENTITY, REGION, body);
		expect(rows.map((r) => r.native_id).sort()).toEqual([
			"redis.master.mid.default",
			"redis.master.small.default",
		]);
		const small = rows.find(
			(r) => r.native_id === "redis.master.small.default",
		);
		expect(small).toMatchObject({
			service_kind: "cache",
			tier: "redis.master.small.default",
			mem_gb: 1, // 1024 MB → 1 GB
			launchable: "launchable",
		});
		const mid = rows.find((r) => r.native_id === "redis.master.mid.default");
		expect(mid?.mem_gb).toBe(2);
	});

	it("sets mem_gb null when capacity is absent and dedupes classes", () => {
		const body = {
			list: [
				{ instanceClass: "redis.logic.sharding.2g.2db.0rodb.4proxy.default" },
				{ instanceClass: "redis.logic.sharding.2g.2db.0rodb.4proxy.default" },
			],
		};
		const rows = normalizeCacheTiers(IDENTITY, REGION, body);
		expect(rows).toHaveLength(1);
		expect(rows[0].mem_gb).toBeNull();
	});

	it("returns nothing for a body with no instance classes", () => {
		expect(normalizeCacheTiers(IDENTITY, REGION, { unrelated: true })).toEqual(
			[],
		);
		expect(normalizeCacheTiers(IDENTITY, REGION, null)).toEqual([]);
	});
});

describe("normalizeNosql", () => {
	it("emits a single Tablestore row when reachable", () => {
		const rows = normalizeNosql(IDENTITY, REGION, true);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			service_kind: "nosql",
			native_id: "Tablestore",
			name: "Tablestore",
			launchable: "launchable",
			launchable_reason: "available",
		});
	});

	it("emits nothing when unreachable", () => {
		expect(normalizeNosql(IDENTITY, REGION, false)).toEqual([]);
	});
});
