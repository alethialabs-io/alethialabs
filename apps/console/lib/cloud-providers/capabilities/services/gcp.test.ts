// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Unit proof for the GCP managed-service normalizer (Wave-2 lane #974). Drives the PURE
// `normalizeGcpServices` + its helpers against recorded GCP API response shapes — no network, no DB — so
// the DB engines/versions, GKE k8s versions, and Firestore availability are proven correct (and the cache
// documented-exclusion proven absent) before the enumeration ever runs against a real project.

import { describe, expect, it } from "vitest";
import {
	latestSqlVersionByFamily,
	normalizeGcpServices,
	offeredK8sMinors,
	parseSqlVersion,
} from "./gcp";

// A trimmed, realistic GKE getServerConfig response (patch versions across two minors + a duplicate).
const K8S_FIXTURE = {
	defaultClusterVersion: "1.34.5-gke.100",
	validMasterVersions: [
		"1.35.1-gke.100",
		"1.35.0-gke.200",
		"1.34.5-gke.100",
		"1.33.9-gke.300",
	],
	channels: [
		{ channel: "STABLE", validVersions: ["1.33.9-gke.300"] },
		{ channel: "REGULAR", validVersions: ["1.34.5-gke.100"] },
	],
};

// A trimmed Cloud SQL flags.list: two Postgres minors, two MySQL minors, and a SQL Server flag the picker
// does not model (must be dropped).
const SQL_FLAGS_FIXTURE = {
	items: [
		{ name: "max_connections", appliesTo: ["POSTGRES_15", "POSTGRES_16", "MYSQL_8_0"] },
		{ name: "log_min_duration", appliesTo: ["POSTGRES_16"] },
		{ name: "long_query_time", appliesTo: ["MYSQL_5_7", "MYSQL_8_0"] },
		{ name: "some_mssql_flag", appliesTo: ["SQLSERVER_2019_STANDARD"] },
	],
};

const TIERS_FIXTURE = {
	items: [
		{ tier: "db-custom-2-7680", region: ["us-central1", "europe-west1"] },
		{ tier: "db-custom-4-15360", region: ["us-central1"] },
	],
};

const BASE = {
	cloudIdentityId: "ci-123",
	region: "us-central1",
	now: new Date("2026-07-23T00:00:00Z"),
};

describe("offeredK8sMinors", () => {
	it("reduces patch versions to de-duplicated minors, sorted high→low", () => {
		expect(offeredK8sMinors(K8S_FIXTURE)).toEqual(["1.35", "1.34", "1.33"]);
	});

	it("falls back to the channels' validVersions when validMasterVersions is absent", () => {
		expect(
			offeredK8sMinors({ channels: K8S_FIXTURE.channels }),
		).toEqual(["1.34", "1.33"]);
	});

	it("returns [] for a null/empty config (fail-open)", () => {
		expect(offeredK8sMinors(null)).toEqual([]);
		expect(offeredK8sMinors({})).toEqual([]);
	});
});

describe("parseSqlVersion", () => {
	it("maps modelled engine families, dotting the numeric tail", () => {
		expect(parseSqlVersion("POSTGRES_16")).toEqual({ family: "POSTGRES", version: "16" });
		expect(parseSqlVersion("MYSQL_8_0")).toEqual({ family: "MYSQL", version: "8.0" });
	});

	it("drops families the picker does not model and malformed tokens", () => {
		expect(parseSqlVersion("SQLSERVER_2019_STANDARD")).toBeNull();
		expect(parseSqlVersion("POSTGRES")).toBeNull();
	});
});

describe("latestSqlVersionByFamily", () => {
	it("picks the highest offered version per family across all flags", () => {
		const m = latestSqlVersionByFamily(SQL_FLAGS_FIXTURE);
		expect(m.get("POSTGRES")).toBe("16");
		expect(m.get("MYSQL")).toBe("8.0");
		// SQL Server was dropped.
		expect(m.has("SQLSERVER")).toBe(false);
	});

	it("returns an empty map for null flags", () => {
		expect(latestSqlVersionByFamily(null).size).toBe(0);
	});
});

describe("normalizeGcpServices", () => {
	it("emits kubernetes + database + nosql rows, all anchored to the region (no cache rows)", () => {
		const rows = normalizeGcpServices({
			...BASE,
			k8s: K8S_FIXTURE,
			sqlTiers: TIERS_FIXTURE,
			sqlFlags: SQL_FLAGS_FIXTURE,
			firestore: true,
		});

		// Every row is scoped + non-empty native_id (softRemoveUnseen keys on native_id).
		for (const r of rows) {
			expect(r.cloud_identity_id).toBe("ci-123");
			expect(r.provider).toBe("gcp");
			expect(r.region).toBe("us-central1");
			expect(r.native_id).toBeTruthy();
		}

		const k8s = rows.filter((r) => r.service_kind === "kubernetes");
		expect(k8s.map((r) => r.native_id)).toEqual(["1.35", "1.34", "1.33"]);
		expect(k8s.every((r) => r.launchable === "launchable")).toBe(true);

		const db = rows.filter((r) => r.service_kind === "database");
		expect(db.map((r) => r.native_id).sort()).toEqual([
			"cloudsql-mysql",
			"cloudsql-postgresql",
		]);
		const pg = db.find((r) => r.native_id === "cloudsql-postgresql");
		expect(pg?.version).toBe("16");
		expect(pg?.name).toBe("Cloud SQL PostgreSQL");
		expect(pg?.engine).toBe("postgres");
		// tiers present ⇒ launchable.
		expect(db.every((r) => r.launchable === "launchable")).toBe(true);

		const nosql = rows.filter((r) => r.service_kind === "nosql");
		expect(nosql).toHaveLength(1);
		expect(nosql[0].native_id).toBe("Firestore");
		expect(nosql[0].launchable).toBe("launchable");

		// cache is the documented exclusion — never emitted.
		expect(rows.some((r) => r.service_kind === "cache")).toBe(false);
	});

	it("marks DB not_evaluable when tiers.list returned nothing (Cloud SQL access unproven)", () => {
		const rows = normalizeGcpServices({
			...BASE,
			k8s: null,
			sqlTiers: { items: [] },
			sqlFlags: SQL_FLAGS_FIXTURE,
			firestore: null,
		});
		const db = rows.filter((r) => r.service_kind === "database");
		expect(db.length).toBeGreaterThan(0);
		expect(db.every((r) => r.launchable === "not_evaluable")).toBe(true);
		expect(db.every((r) => r.launchable_reason === "quota_unknown")).toBe(true);
	});

	it("emits no nosql row when the Firestore probe was inconclusive (null), and a not_evaluable row when it failed", () => {
		const inconclusive = normalizeGcpServices({
			...BASE,
			k8s: null,
			sqlTiers: null,
			sqlFlags: null,
			firestore: null,
		});
		expect(inconclusive.some((r) => r.service_kind === "nosql")).toBe(false);

		const failed = normalizeGcpServices({
			...BASE,
			k8s: null,
			sqlTiers: null,
			sqlFlags: null,
			firestore: false,
		});
		const nosql = failed.filter((r) => r.service_kind === "nosql");
		expect(nosql).toHaveLength(1);
		expect(nosql[0].launchable).toBe("not_evaluable");
	});

	it("emits nothing when every source is null/empty (best-effort, fail-open)", () => {
		const rows = normalizeGcpServices({
			...BASE,
			k8s: null,
			sqlTiers: null,
			sqlFlags: null,
			firestore: null,
		});
		expect(rows).toEqual([]);
	});
});
