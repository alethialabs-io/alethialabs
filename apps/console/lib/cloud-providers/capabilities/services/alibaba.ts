// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Alibaba Wave-2 managed-SERVICE capability enumeration (epic #928, lane #975). The service-axis twin of
// the Wave-1 lane (capabilities/alibaba.ts): auth is KEYLESS (temporary STS creds from AssumeRoleWithOIDC,
// session/alibaba.ts), reads are read-only Describe/List, and the account-accurate offerings land in
// `cloud_capability_services` discriminated by `service_kind`:
//   • database   — ApsaraDB RDS engines + versions (DescribeAvailableZones)
//   • database_instance_class — ApsaraDB RDS instance classes (DescribeAvailableClasses), one bounded call
//                  per engine at its newest offered version (see pickClassQueries for the narrowing)
//   • cache      — ApsaraDB for Redis (KVStore) node classes/tiers (DescribeAvailableResource)
//   • cache_version — the offered Redis engine versions nested in that SAME response
//   • kubernetes — ACK managed-Kubernetes control-plane versions (DescribeKubernetesVersionMetadata)
//   • nosql      — Tablestore availability (ListInstance reachability)
// These are "available"/"metadata" APIs — everything they return is offerable, so each row is
// `launchable=launchable` / `available` (availability is design-time GUIDANCE, never a hard gate).
//
// Structural contract (mirrors index.ts / the Wave-1 lanes): best-effort, NEVER throws. Each axis runs in
// its own try/catch so one cloud API's failure can't sink the others, and a failed axis leaves its existing
// rows untouched (its per-kind soft-remove runs only when the enumeration succeeded — a transient outage
// must not wipe the catalog). Enumeration is anchored at one bootstrap region (offerings are region-uniform
// for these axes); the refresh sweep re-runs it and the picker fails open to the static catalog elsewhere.

import CsClient, {
	DescribeKubernetesVersionMetadataRequest,
} from "@alicloud/cs20151215";
import * as $OpenApi from "@alicloud/openapi-client";
import OtsClient, { ListInstanceRequest } from "@alicloud/ots20160620";
import KvstoreClient, {
	DescribeAvailableResourceRequest,
} from "@alicloud/r-kvstore20150101";
import RdsClient, {
	DescribeAvailableClassesRequest,
	DescribeAvailableZonesRequest,
} from "@alicloud/rds20140815";
import { and, eq, isNull, notInArray, sql } from "drizzle-orm";
import { getServiceDb } from "@/lib/db";
import {
	type CloudCapabilityServiceInsert,
	cloudCapabilityServices,
} from "@/lib/db/schema";
import { asRecord } from "@/lib/records";
import { type AlibabaCredentials, assumeAlibabaRole } from "../../session/alibaba";
import { compareVersions, dedupeVersionsDesc } from "./version";
import type { CapabilityIdentity } from "../types";

/** The region the service axes are enumerated at. ApsaraDB engines/versions, Redis tiers, ACK versions and
 * Tablestore availability are effectively account/region-uniform, so one anchor region keeps the API calls
 * bounded; the sweep refreshes and the picker fails open to the static catalog for other regions. */
const BOOTSTRAP_REGION = "cn-hangzhou";

// ── Minimal SDK-response shapes (only the fields the normalizers read; the recorded-fixture contract) ──

/** One ACK version-metadata entry (DescribeKubernetesVersionMetadata response element). */
export interface K8sVersionMeta {
	version?: string | null;
	/** False ⇒ the version exists but cannot be created (deprecated / upgrade-only) — not launchable. */
	creatable?: boolean | null;
}

/** One RDS DescribeAvailableZones storage-type entry. */
export interface RdsStorageType {
	storageType?: string | null;
}

/** One RDS DescribeAvailableZones category entry (the instance series: Basic / HighAvailability / …). */
export interface RdsCategory {
	category?: string | null;
	supportedStorageTypes?: RdsStorageType[] | null;
}

/** One RDS DescribeAvailableZones supported-engine version entry. */
export interface RdsEngineVersion {
	version?: string | null;
	supportedCategorys?: RdsCategory[] | null;
}

/** One RDS DescribeAvailableZones supported-engine entry. */
export interface RdsSupportedEngine {
	engine?: string | null;
	supportedEngineVersions?: RdsEngineVersion[] | null;
}

/** One RDS DescribeAvailableZones zone entry (the fields we traverse for engines + versions). */
export interface RdsAvailableZone {
	zoneId?: string | null;
	supportedEngines?: RdsSupportedEngine[] | null;
}

/** One DescribeAvailableClasses instance-class entry. */
export interface RdsInstanceClass {
	DBInstanceClass?: string | null;
}

/** The fully-specified tuple ONE DescribeAvailableClasses call needs. ApsaraDB will not answer for a bare
 * engine: the class list is scoped to (zone, engine, version, category, storage type). */
export interface RdsClassQuery {
	engine: string;
	engineVersion: string;
	zoneId: string;
	category: string;
	storageType: string;
}

// ── Row factory ───────────────────────────────────────────────────────────────────

interface ServiceRowInput {
	service_kind: CloudCapabilityServiceInsert["service_kind"];
	native_id: string;
	name?: string;
	engine?: string | null;
	version?: string | null;
	tier?: string | null;
	mem_gb?: number | null;
}

/** Builds one `cloud_capability_services` insert row for this account. Everything these lanes enumerate is
 * offerable, so the verdict is always launchable/available (guidance, not a gate). */
function serviceRow(
	identityId: string,
	region: string,
	input: ServiceRowInput,
): CloudCapabilityServiceInsert {
	const now = new Date();
	return {
		cloud_identity_id: identityId,
		provider: "alibaba",
		region,
		native_id: input.native_id,
		name: input.name ?? input.native_id,
		service_kind: input.service_kind,
		engine: input.engine ?? null,
		version: input.version ?? null,
		tier: input.tier ?? null,
		mem_gb: input.mem_gb ?? null,
		launchable: "launchable",
		launchable_reason: "available",
		last_seen: now,
		last_synced_at: now,
		removed_at: null,
	};
}

// ── Pure normalizers (exported for unit tests against recorded SDK fixtures) ─────────

/** Normalizes ACK version metadata → `kubernetes` rows. Only creatable versions are launchable; a
 * deprecated/upgrade-only version (creatable === false) is omitted rather than shown as launchable. */
export function normalizeK8sVersions(
	identityId: string,
	region: string,
	metas: K8sVersionMeta[],
): CloudCapabilityServiceInsert[] {
	const seen = new Set<string>();
	const rows: CloudCapabilityServiceInsert[] = [];
	for (const meta of metas) {
		const version = meta.version;
		if (typeof version !== "string" || version.length === 0) continue;
		if (meta.creatable === false) continue;
		if (seen.has(version)) continue;
		seen.add(version);
		rows.push(
			serviceRow(identityId, region, {
				service_kind: "kubernetes",
				native_id: version,
				version,
			}),
		);
	}
	return rows;
}

/** Normalizes RDS DescribeAvailableZones → `database` rows, one per distinct (engine, version) the account
 * can launch. `native_id` is the composite `<engine>-<version>` so multiple versions of an engine stay
 * distinct under the (identity, region, kind, native_id) unique key. */
export function normalizeDbEngines(
	identityId: string,
	region: string,
	zones: RdsAvailableZone[],
): CloudCapabilityServiceInsert[] {
	const seen = new Set<string>();
	const rows: CloudCapabilityServiceInsert[] = [];
	for (const zone of zones) {
		for (const supported of zone.supportedEngines ?? []) {
			const engine = supported.engine;
			if (typeof engine !== "string" || engine.length === 0) continue;
			for (const ev of supported.supportedEngineVersions ?? []) {
				const version = ev.version;
				if (typeof version !== "string" || version.length === 0) continue;
				const nativeId = `${engine}-${version}`;
				if (seen.has(nativeId)) continue;
				seen.add(nativeId);
				rows.push(
					serviceRow(identityId, region, {
						service_kind: "database",
						native_id: nativeId,
						name: `${engine} ${version}`,
						engine,
						version,
					}),
				);
			}
		}
	}
	return rows;
}

/** One DescribeAvailableClasses query per ENGINE, at its newest offered version.
 *
 * The full matrix is (zone × engine × version × category × storage type) — enumerating it would be
 * dozens of calls per sweep for a list that barely varies across the tuple. So this picks, per engine,
 * the newest version and the first zone/category/storage-type that offers it: a bounded |engines| calls.
 * The narrowing is real and deliberate — a class offered ONLY on an older version, or only in another
 * zone, is not enumerated — and `withSelected` keeps such a value representable if one is already pinned.
 *
 * Pure, so the choice of anchor is unit-testable rather than an accident of response ordering. */
export function pickClassQueries(zones: RdsAvailableZone[]): RdsClassQuery[] {
	// Best (newest-version) query seen per engine.
	const best = new Map<string, RdsClassQuery>();
	for (const zone of zones) {
		const zoneId = zone.zoneId;
		if (typeof zoneId !== "string" || zoneId.length === 0) continue;
		for (const supported of zone.supportedEngines ?? []) {
			const engine = supported.engine;
			if (typeof engine !== "string" || engine.length === 0) continue;
			for (const ev of supported.supportedEngineVersions ?? []) {
				const engineVersion = ev.version;
				if (typeof engineVersion !== "string" || engineVersion.length === 0) continue;
				for (const cat of ev.supportedCategorys ?? []) {
					const category = cat.category;
					if (typeof category !== "string" || category.length === 0) continue;
					for (const st of cat.supportedStorageTypes ?? []) {
						const storageType = st.storageType;
						if (typeof storageType !== "string" || storageType.length === 0) continue;
						const current = best.get(engine);
						if (
							current === undefined ||
							compareVersions(engineVersion, current.engineVersion) > 0
						) {
							best.set(engine, { engine, engineVersion, zoneId, category, storageType });
						}
						break; // one storage type is enough to ask the question
					}
				}
			}
		}
	}
	return [...best.values()];
}

/** DescribeAvailableClasses → `database_instance_class` rows for ONE engine. `native_id` is the composite
 * `<engine>-<class>` (the same class is orderable for more than one engine, and each is its own
 * offering); the bare class lives in `tier`, which is what the picker reads. */
export function normalizeDbInstanceClasses(
	identityId: string,
	region: string,
	engine: string,
	classes: RdsInstanceClass[],
): CloudCapabilityServiceInsert[] {
	const rows: CloudCapabilityServiceInsert[] = [];
	const seen = new Set<string>();
	for (const entry of classes) {
		const cls = entry.DBInstanceClass;
		if (typeof cls !== "string" || cls.length === 0) continue;
		if (seen.has(cls)) continue;
		seen.add(cls);
		rows.push(
			serviceRow(identityId, region, {
				service_kind: "database_instance_class",
				native_id: `${engine}-${cls}`,
				name: cls,
				engine,
				tier: cls,
			}),
		);
	}
	return rows;
}

/** Recursively collects (engine, version) pairs from the KVStore DescribeAvailableResource response.
 *
 * The response nests the version SIX levels below its engine
 * (availableZones → supportedEngines → supportedEngine{engine} → supportedEditionTypes →
 * supportedSeriesTypes → supportedEngineVersions → supportedEngineVersion{version}), so the walk carries
 * the nearest enclosing `engine` down rather than trying to encode that path — the same defensive shape
 * `collectCacheClasses` uses, and for the same reason: the exact nesting is not a contract we control. */
function collectCacheVersions(
	node: unknown,
	engine: string | null,
	out: Map<string, Set<string>>,
): void {
	if (Array.isArray(node)) {
		for (const item of node) collectCacheVersions(item, engine, out);
		return;
	}
	if (node === null || typeof node !== "object") return;
	const record = asRecord(node);
	const nested =
		typeof record.engine === "string" && record.engine.length > 0
			? record.engine
			: engine;
	const version = record.version;
	if (nested !== null && typeof version === "string" && version.length > 0) {
		const seen = out.get(nested);
		if (seen) seen.add(version);
		else out.set(nested, new Set([version]));
	}
	for (const value of Object.values(record)) collectCacheVersions(value, nested, out);
}

/** Normalizes the KVStore DescribeAvailableResource response → `cache_version` rows, one per (engine,
 * offered version). The response was already fetched for the node classes; the versions rode along in it. */
export function normalizeCacheVersions(
	identityId: string,
	region: string,
	availableResourceBody: unknown,
): CloudCapabilityServiceInsert[] {
	const byEngine = new Map<string, Set<string>>();
	collectCacheVersions(availableResourceBody, null, byEngine);
	const rows: CloudCapabilityServiceInsert[] = [];
	for (const [engine, versions] of byEngine) {
		for (const version of dedupeVersionsDesc([...versions])) {
			rows.push(
				serviceRow(identityId, region, {
					service_kind: "cache_version",
					native_id: `${engine}-${version}`,
					name: `${engine} ${version}`,
					engine,
					version,
				}),
			);
		}
	}
	return rows;
}

/** Recursively collects `instanceClass` leaves (+ their `capacity` in MB) from the deeply-nested KVStore
 * DescribeAvailableResource response. Walking defensively is resilient to the response's exact nesting. */
function collectCacheClasses(
	node: unknown,
	out: Map<string, number | null>,
): void {
	if (Array.isArray(node)) {
		for (const item of node) collectCacheClasses(item, out);
		return;
	}
	if (node === null || typeof node !== "object") return;
	const record = asRecord(node);
	const instanceClass = record.instanceClass;
	if (typeof instanceClass === "string" && instanceClass.length > 0) {
		if (!out.has(instanceClass)) {
			const capacity =
				typeof record.capacity === "number" ? record.capacity : null;
			out.set(instanceClass, capacity);
		}
	}
	for (const value of Object.values(record)) collectCacheClasses(value, out);
}

/** Normalizes the KVStore DescribeAvailableResource response → `cache` rows, one per node class. `mem_gb`
 * is the reported capacity (MB → GB) where present, else NULL (honest not-evaluable). */
export function normalizeCacheTiers(
	identityId: string,
	region: string,
	availableResourceBody: unknown,
): CloudCapabilityServiceInsert[] {
	const classes = new Map<string, number | null>();
	collectCacheClasses(availableResourceBody, classes);
	const rows: CloudCapabilityServiceInsert[] = [];
	for (const [instanceClass, capacityMb] of classes) {
		const memGb =
			capacityMb !== null ? Math.round((capacityMb / 1024) * 100) / 100 : null;
		rows.push(
			serviceRow(identityId, region, {
				service_kind: "cache",
				native_id: instanceClass,
				tier: instanceClass,
				mem_gb: memGb,
			}),
		);
	}
	return rows;
}

/** Normalizes Tablestore reachability → a single `nosql` row when the account can reach the OTS API
 * (service enabled). Reachability is the availability signal — no instances need exist. */
export function normalizeNosql(
	identityId: string,
	region: string,
	reachable: boolean,
): CloudCapabilityServiceInsert[] {
	if (!reachable) return [];
	return [
		serviceRow(identityId, region, {
			service_kind: "nosql",
			native_id: "Tablestore",
			name: "Tablestore",
		}),
	];
}

// ── SDK clients (keyless STS creds + regional endpoint) ──────────────────────────────

/** Builds an OpenAPI config from the temporary STS credentials, targeting a regional endpoint. */
function openApiConfig(
	creds: AlibabaCredentials,
	endpoint: string,
): $OpenApi.Config {
	return new $OpenApi.Config({
		accessKeyId: creds.accessKeyId,
		accessKeySecret: creds.accessKeySecret,
		securityToken: creds.securityToken,
		endpoint,
	});
}

// ── Per-axis enumeration + upsert (best-effort) ──────────────────────────────────────

/** Upserts a batch of service rows on the (identity, provider, region, service-kind, native_id) key. */
async function upsertServiceRows(
	rows: CloudCapabilityServiceInsert[],
): Promise<void> {
	if (rows.length === 0) return;
	await getServiceDb()
		.insert(cloudCapabilityServices)
		.values(rows)
		.onConflictDoUpdate({
			target: [
				cloudCapabilityServices.cloud_identity_id,
				cloudCapabilityServices.provider,
				cloudCapabilityServices.region,
				cloudCapabilityServices.service_kind,
				cloudCapabilityServices.native_id,
			],
			set: {
				name: sql`excluded.name`,
				engine: sql`excluded.engine`,
				version: sql`excluded.version`,
				tier: sql`excluded.tier`,
				mem_gb: sql`excluded.mem_gb`,
				launchable: sql`excluded.launchable`,
				launchable_reason: sql`excluded.launchable_reason`,
				last_seen: sql`excluded.last_seen`,
				last_synced_at: sql`excluded.last_synced_at`,
				removed_at: sql`excluded.removed_at`,
			},
		});
}

/** Soft-removes this account's rows of one service kind whose native_id wasn't seen this run (scoped by
 * kind so a failing axis never withdraws another axis's offerings). Called only when the axis succeeded. */
async function softRemoveKindUnseen(
	identityId: string,
	kind: CloudCapabilityServiceInsert["service_kind"],
	seen: string[],
): Promise<void> {
	await getServiceDb()
		.update(cloudCapabilityServices)
		.set({ removed_at: new Date() })
		.where(
			and(
				eq(cloudCapabilityServices.cloud_identity_id, identityId),
				eq(cloudCapabilityServices.service_kind, kind),
				isNull(cloudCapabilityServices.removed_at),
				seen.length > 0
					? notInArray(cloudCapabilityServices.native_id, seen)
					: sql`true`,
			),
		);
}

/** Enumerate + persist the ACK managed-Kubernetes versions. */
async function syncK8sVersions(
	creds: AlibabaCredentials,
	identityId: string,
	region: string,
): Promise<void> {
	const client = new CsClient(
		openApiConfig(creds, `cs.${region}.aliyuncs.com`),
	);
	const resp = await client.describeKubernetesVersionMetadata(
		new DescribeKubernetesVersionMetadataRequest({
			region,
			clusterType: "ManagedKubernetes",
		}),
	);
	const rows = normalizeK8sVersions(identityId, region, resp.body ?? []);
	await upsertServiceRows(rows);
	await softRemoveKindUnseen(
		identityId,
		"kubernetes",
		rows.map((r) => r.native_id),
	);
}

/** Enumerate + persist the ApsaraDB RDS engines + versions. */
async function syncDbEngines(
	creds: AlibabaCredentials,
	identityId: string,
	region: string,
): Promise<void> {
	const client = new RdsClient(
		openApiConfig(creds, `rds.${region}.aliyuncs.com`),
	);
	const resp = await client.describeAvailableZones(
		new DescribeAvailableZonesRequest({ regionId: region }),
	);
	const zones = resp.body?.availableZones ?? [];
	const rows = normalizeDbEngines(identityId, region, zones);
	await upsertServiceRows(rows);
	await softRemoveKindUnseen(
		identityId,
		"database",
		rows.map((r) => r.native_id),
	);

	// database_instance_class rides on the SAME zones response: it carries every parameter
	// DescribeAvailableClasses requires, so no second enumeration call is needed to work out what to ask.
	const classRows: CloudCapabilityServiceInsert[] = [];
	for (const query of pickClassQueries(zones)) {
		const classes = await client.describeAvailableClasses(
			new DescribeAvailableClassesRequest({
				regionId: region,
				zoneId: query.zoneId,
				engine: query.engine,
				engineVersion: query.engineVersion,
				category: query.category,
				DBInstanceStorageType: query.storageType,
				instanceChargeType: "Postpaid",
			}),
		);
		classRows.push(
			...normalizeDbInstanceClasses(
				identityId,
				region,
				query.engine,
				classes.body?.DBInstanceClasses ?? [],
			),
		);
	}
	await upsertServiceRows(classRows);
	await softRemoveKindUnseen(
		identityId,
		"database_instance_class",
		classRows.map((r) => r.native_id),
	);
}

/** Enumerate + persist the ApsaraDB for Redis (KVStore) node classes. */
async function syncCacheTiers(
	creds: AlibabaCredentials,
	identityId: string,
	region: string,
): Promise<void> {
	const client = new KvstoreClient(
		openApiConfig(creds, `r-kvstore.${region}.aliyuncs.com`),
	);
	const resp = await client.describeAvailableResource(
		new DescribeAvailableResourceRequest({
			engine: "Redis",
			instanceChargeType: "PostPaid",
		}),
	);
	const rows = normalizeCacheTiers(identityId, region, resp.body);
	await upsertServiceRows(rows);
	await softRemoveKindUnseen(
		identityId,
		"cache",
		rows.map((r) => r.native_id),
	);

	// One response, two axes: the node classes above and the engine versions nested beside them.
	const versionRows = normalizeCacheVersions(identityId, region, resp.body);
	await upsertServiceRows(versionRows);
	await softRemoveKindUnseen(
		identityId,
		"cache_version",
		versionRows.map((r) => r.native_id),
	);
}

/** Probe Tablestore availability + persist the single nosql row. */
async function syncNosqlAvailability(
	creds: AlibabaCredentials,
	identityId: string,
	region: string,
): Promise<void> {
	const client = new OtsClient(
		openApiConfig(creds, `ots.${region}.aliyuncs.com`),
	);
	// Reachability is the signal — a successful list (even empty) means the service is enabled.
	await client.listInstance(new ListInstanceRequest({ pageNum: 1, pageSize: 1 }));
	const rows = normalizeNosql(identityId, region, true);
	await upsertServiceRows(rows);
	await softRemoveKindUnseen(
		identityId,
		"nosql",
		rows.map((r) => r.native_id),
	);
}

/**
 * Enumerate this Alibaba account's launchable managed services (DB/cache/k8s/NoSQL) into
 * `cloud_capability_services`. Best-effort per the Wave-2 contract — never throws; each axis is isolated so
 * one API failure can't sink the others, and a failed axis leaves its rows intact.
 */
export async function syncAlibabaServiceCapabilities(
	identity: CapabilityIdentity,
): Promise<void> {
	const session = await assumeAlibabaRole(identity, { purpose: "capabilities" });
	if (!session.credentials) return;
	const creds = session.credentials;
	const region = BOOTSTRAP_REGION;

	for (const axis of [
		syncK8sVersions,
		syncDbEngines,
		syncCacheTiers,
		syncNosqlAvailability,
	]) {
		try {
			await axis(creds, identity.id, region);
		} catch {
			// Best-effort — a single axis's failure is isolated; the refresh sweep retries.
		}
	}
}
