// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// AWS managed-SERVICE capability enumeration (Wave-2, epic #928, lane #972). Assumes the customer's
// keyless identity (session/aws) and reads, READ-ONLY, what managed services THIS account can launch,
// into `cloud_capability_services`:
//   - kubernetes: EKS DescribeClusterVersions → the offerable EKS control-plane versions (excluding
//                 UNSUPPORTED/EOL ones — an honest verdict, never an EOL version the account can't create).
//   - database:   RDS DescribeDBEngineVersions for the platform's engine set (Aurora PG/MySQL) → one row
//                 per engine at its latest offered major version.
//   - cache:      ElastiCache DescribeCacheEngineVersions gates the platform cache tiers (there is no
//                 read-only per-node-type list API, so availability of the service ⇒ the catalog tiers
//                 are launchable, memory carried from the catalog).
//   - cache_version: the SAME DescribeCacheEngineVersions call, read for what it actually returns — one
//                 row per (engine, offered version). It was already fetched and thrown away.
//   - database_instance_class: RDS DescribeOrderableDBInstanceOptions → the concrete SKUs each platform
//                 engine can be launched at in this region.
//   - nosql:      DynamoDB DescribeLimits reachable ⇒ the account can launch DynamoDB.
//
// Availability is design-time GUIDANCE, never a hard gate (#918 fail-open): the pickers fall back to the
// static Catalog #2 when nothing has synced. Each axis is best-effort and independent — one axis's SDK
// error (e.g. a missing grant) never loses the others. The soft-remove reconcile only runs when EVERY
// axis succeeded, so a transient/partial failure can't wrongly retire a healthy axis's offerings. The
// dispatcher (services-index.ts) swallows any throw and stamps freshness; this lane fills its AWS seam.
//
// Grants (read-only): eks:DescribeClusterVersions, rds:DescribeDBEngineVersions,
// rds:DescribeOrderableDBInstanceOptions, elasticache:DescribeCacheEngineVersions,
// dynamodb:DescribeLimits. The connector's bootstrap policy already carries `rds:Describe*`, so the
// instance-class axis needs no re-bootstrap of an already-connected account.

import {
	DescribeLimitsCommand,
	DynamoDBClient,
} from "@aws-sdk/client-dynamodb";
import {
	type CacheEngineVersion,
	DescribeCacheEngineVersionsCommand,
	ElastiCacheClient,
} from "@aws-sdk/client-elasticache";
import {
	type ClusterVersionInformation,
	DescribeClusterVersionsCommand,
	EKSClient,
} from "@aws-sdk/client-eks";
import {
	type DBEngineVersion,
	DescribeDBEngineVersionsCommand,
	DescribeOrderableDBInstanceOptionsCommand,
	type OrderableDBInstanceOption,
	RDSClient,
} from "@aws-sdk/client-rds";
import { sql } from "drizzle-orm";
import { getServiceDb } from "@/lib/db";
import {
	type CloudCapabilityServiceInsert,
	cloudCapabilityServices,
} from "@/lib/db/schema";
import {
	CACHE_NODE_TYPES,
	DB_ENGINES,
	NOSQL,
} from "@/lib/cloud-providers/generated/catalog";
import { assumeAwsRole } from "../../session/aws";
import { softRemoveUnseen } from "../../inventory/upsert";
import { dedupeVersionsDesc } from "./version";
import type { CapabilityIdentity } from "../types";

const TIMEOUT_MS = 15_000;
const MAX_PAGES = 50; // strict-progress bound on every paginated loop
const AWS_CREDS_OPTS = { requestHandler: { requestTimeout: TIMEOUT_MS }, maxAttempts: 2 } as const;

type AwsCreds = { accessKeyId: string; secretAccessKey: string; sessionToken: string };

/** The shared per-row context: the identity being enumerated + the region the rows are scoped to (a
 * real region code, never NULL — the account-wide axes reuse the session region so the unique key
 * doesn't trip Postgres's "NULLs are distinct" rule on upsert). */
export interface ServiceNormalizeCtx {
	cloudIdentityId: string;
	region: string;
	now: Date;
}

/** Builds a `cloud_capability_services` insert row with the common fields filled from ctx. Every
 * enumerated offering is `launchable`/`available` (it was returned by a read-only Describe). */
function serviceRow(
	ctx: ServiceNormalizeCtx,
	fields: Pick<
		CloudCapabilityServiceInsert,
		"service_kind" | "native_id" | "name" | "engine" | "version" | "tier" | "mem_gb"
	>,
): CloudCapabilityServiceInsert {
	return {
		cloud_identity_id: ctx.cloudIdentityId,
		provider: "aws",
		region: ctx.region,
		launchable: "launchable",
		launchable_reason: "available",
		last_seen: ctx.now,
		last_synced_at: ctx.now,
		removed_at: null,
		...fields,
	};
}

// ── Pure normalizers (unit-tested against recorded SDK fixtures) ──────────────────────

/** EKS DescribeClusterVersions → one `kubernetes` row per offerable, still-supported control-plane
 * version. UNSUPPORTED (EOL) versions are dropped — an EOL version isn't launchable, so surfacing it
 * would be a wrong verdict. `native_id` = `version` = the version string; deduped + kept stable. */
export function normalizeK8sVersionRows(
	versions: ClusterVersionInformation[],
	ctx: ServiceNormalizeCtx,
): CloudCapabilityServiceInsert[] {
	const rows: CloudCapabilityServiceInsert[] = [];
	const seen = new Set<string>();
	for (const v of versions) {
		const version = v.clusterVersion?.trim();
		if (!version || seen.has(version)) continue;
		if (v.versionStatus === "UNSUPPORTED") continue;
		seen.add(version);
		rows.push(
			serviceRow(ctx, {
				service_kind: "kubernetes",
				native_id: version,
				name: version,
				engine: null,
				version,
				tier: null,
				mem_gb: null,
			}),
		);
	}
	return rows;
}

/** RDS DescribeDBEngineVersions → one `database` row per PLATFORM engine AND offered major version
 * (the Catalog #2 AWS engine set: Aurora PG/MySQL). Engines the platform doesn't provision are
 * ignored; the engine label comes from the catalog so the picker copy is stable.
 *
 * One row per (engine, major) rather than per engine: the version is an axis the picker offers, so
 * collapsing to the latest here makes an engine-version selector impossible (#1351). `native_id` is
 * the composite `<engine>-<version>` — the convention the Azure and Alibaba lanes already use —
 * because the unique key is (identity, provider, region, kind, native_id) and `version` is NOT in it,
 * so per-version rows under a bare-engine id would silently overwrite one another.
 *
 * The API returns one row per MINOR, so we key on `MajorEngineVersion`: "16.4" and "16.6" collapse to
 * a single offered "16", which is the grain the platform provisions at. */
export function normalizeDatabaseRows(
	engineVersions: DBEngineVersion[],
	ctx: ServiceNormalizeCtx,
): CloudCapabilityServiceInsert[] {
	// The engines the platform actually provisions on AWS (Catalog #2), keyed by RDS engine value.
	const catalog = new Map(DB_ENGINES.aws.map((e) => [e.value, e]));
	const versionsByEngine = new Map<string, string[]>();
	for (const ev of engineVersions) {
		const engine = ev.Engine;
		if (!engine || !catalog.has(engine)) continue;
		const ver = ev.MajorEngineVersion ?? ev.EngineVersion;
		if (!ver) continue;
		const seen = versionsByEngine.get(engine);
		if (seen) seen.push(ver);
		else versionsByEngine.set(engine, [ver]);
	}
	const rows: CloudCapabilityServiceInsert[] = [];
	for (const [engine, versions] of versionsByEngine) {
		const meta = catalog.get(engine);
		for (const version of dedupeVersionsDesc(versions)) {
			rows.push(
				serviceRow(ctx, {
					service_kind: "database",
					native_id: `${engine}-${version}`,
					name: meta?.label ?? engine,
					engine,
					version,
					tier: null,
					mem_gb: null,
				}),
			);
		}
	}
	return rows;
}

/** ElastiCache DescribeCacheEngineVersions gates the platform cache tiers: if the account exposes ≥1
 * cache engine (the service is available + authorized), the Catalog #2 AWS node classes are launchable
 * (memory carried from the catalog — there is no read-only per-node-type list API). Empty ⇒ no rows
 * (fail-open to the static catalog). */
export function normalizeCacheTierRows(
	engineVersions: CacheEngineVersion[],
	ctx: ServiceNormalizeCtx,
): CloudCapabilityServiceInsert[] {
	if (engineVersions.length === 0) return [];
	return CACHE_NODE_TYPES.aws.map((t) =>
		serviceRow(ctx, {
			service_kind: "cache",
			native_id: t.value,
			name: t.label,
			engine: null,
			version: null,
			tier: t.value,
			mem_gb: t.memoryGb,
		}),
	);
}

/** The SAME ElastiCache DescribeCacheEngineVersions response, read for the versions it carries: one
 * `cache_version` row per (engine, offered version). The tier normalizer above only asks whether the
 * response was non-empty; the versions were in hand and discarded, which is why `engine_version` on a
 * cache node was a free-text box a user had to already know the answer for.
 *
 * `native_id` is the composite `<engine>-<version>` — the unique key carries `native_id` but not
 * `version`, so per-version rows under a bare-engine id would silently overwrite one another (the same
 * reason the database kind uses it). Versions are newest-first per engine. */
export function normalizeCacheVersionRows(
	engineVersions: CacheEngineVersion[],
	ctx: ServiceNormalizeCtx,
): CloudCapabilityServiceInsert[] {
	const versionsByEngine = new Map<string, string[]>();
	for (const ev of engineVersions) {
		const engine = ev.Engine?.trim();
		const version = ev.EngineVersion?.trim();
		if (!engine || !version) continue;
		const seen = versionsByEngine.get(engine);
		if (seen) seen.push(version);
		else versionsByEngine.set(engine, [version]);
	}
	const rows: CloudCapabilityServiceInsert[] = [];
	for (const [engine, versions] of versionsByEngine) {
		for (const version of dedupeVersionsDesc(versions)) {
			rows.push(
				serviceRow(ctx, {
					service_kind: "cache_version",
					native_id: `${engine}-${version}`,
					name: `${engine} ${version}`,
					engine,
					version,
					tier: null,
					mem_gb: null,
				}),
			);
		}
	}
	return rows;
}

/** RDS DescribeOrderableDBInstanceOptions → one `database_instance_class` row per (platform engine,
 * SKU). The API returns one entry per (engine, engine version, class, AZ set), so the same class
 * recurs heavily — rows are deduped on (engine, class) and the version dimension is dropped: the
 * picker offers a SKU for an engine, and a class that is orderable for one of the engine's versions
 * is the honest set to show. Engines the platform doesn't provision are ignored.
 *
 * `native_id` is the composite `<engine>-<class>` because the same SKU is orderable for more than one
 * engine and each is its own offering; the bare SKU lives in `tier`, which is what the picker reads. */
export function normalizeDbInstanceClassRows(
	options: OrderableDBInstanceOption[],
	ctx: ServiceNormalizeCtx,
): CloudCapabilityServiceInsert[] {
	const catalog = new Map(DB_ENGINES.aws.map((e) => [e.value, e]));
	const rows: CloudCapabilityServiceInsert[] = [];
	const seen = new Set<string>();
	for (const opt of options) {
		const engine = opt.Engine;
		const cls = opt.DBInstanceClass?.trim();
		if (!engine || !cls || !catalog.has(engine)) continue;
		const nativeId = `${engine}-${cls}`;
		if (seen.has(nativeId)) continue;
		seen.add(nativeId);
		rows.push(
			serviceRow(ctx, {
				service_kind: "database_instance_class",
				native_id: nativeId,
				name: cls,
				engine,
				version: null,
				tier: cls,
				mem_gb: null,
			}),
		);
	}
	return rows;
}

/** DynamoDB availability → one `nosql` row when the service is reachable/authorized (DescribeLimits
 * resolved). `native_id` = `name` = the catalog service name ("DynamoDB"). A non-available account
 * produces no row (fail-open to the static catalog — we never fabricate a not_launchable from a throw). */
export function normalizeNosqlRows(
	available: boolean,
	ctx: ServiceNormalizeCtx,
): CloudCapabilityServiceInsert[] {
	if (!available) return [];
	const name = NOSQL.aws.serviceName;
	return [
		serviceRow(ctx, {
			service_kind: "nosql",
			native_id: name,
			name,
			engine: null,
			version: null,
			tier: null,
			mem_gb: null,
		}),
	];
}

// ── SDK fetch helpers (the I/O shell) ────────────────────────────────────────────────

/** All offerable EKS control-plane versions for the account (paginated). */
async function fetchK8sVersions(
	region: string,
	credentials: AwsCreds,
): Promise<ClusterVersionInformation[]> {
	const client = new EKSClient({ region, credentials, ...AWS_CREDS_OPTS });
	const out: ClusterVersionInformation[] = [];
	let token: string | undefined;
	for (let i = 0; i < MAX_PAGES; i++) {
		const resp = await client.send(
			new DescribeClusterVersionsCommand({ maxResults: 100, nextToken: token }),
		);
		out.push(...(resp.clusterVersions ?? []));
		token = resp.nextToken;
		if (!token) break;
	}
	return out;
}

/** The offered RDS engine versions for the platform engine set (per-engine, paginated). */
async function fetchDbEngineVersions(
	region: string,
	credentials: AwsCreds,
): Promise<DBEngineVersion[]> {
	const client = new RDSClient({ region, credentials, ...AWS_CREDS_OPTS });
	const out: DBEngineVersion[] = [];
	for (const { value: engine } of DB_ENGINES.aws) {
		let marker: string | undefined;
		for (let i = 0; i < MAX_PAGES; i++) {
			const resp = await client.send(
				new DescribeDBEngineVersionsCommand({ Engine: engine, MaxRecords: 100, Marker: marker }),
			);
			out.push(...(resp.DBEngineVersions ?? []));
			marker = resp.Marker;
			if (!marker) break;
		}
	}
	return out;
}

/** The orderable DB instance options for the platform engine set (per-engine, paginated).
 *
 * `EngineVersion` is deliberately NOT passed: the picker offers a SKU for an ENGINE, and pinning one
 * version would hide classes only orderable on another. That costs pages — the API returns an entry per
 * (version, class, AZ set) — so the shared MAX_PAGES bound applies here as everywhere else. Truncation
 * would drop the tail of the SKU list rather than corrupt it, and the normalizer dedupes to a few dozen
 * rows; a truncated sweep is re-run by the refresh sweep. */
async function fetchOrderableDbInstanceOptions(
	region: string,
	credentials: AwsCreds,
): Promise<OrderableDBInstanceOption[]> {
	const client = new RDSClient({ region, credentials, ...AWS_CREDS_OPTS });
	const out: OrderableDBInstanceOption[] = [];
	for (const { value: engine } of DB_ENGINES.aws) {
		let marker: string | undefined;
		for (let i = 0; i < MAX_PAGES; i++) {
			const resp = await client.send(
				new DescribeOrderableDBInstanceOptionsCommand({
					Engine: engine,
					MaxRecords: 100,
					Marker: marker,
				}),
			);
			out.push(...(resp.OrderableDBInstanceOptions ?? []));
			marker = resp.Marker;
			if (!marker) break;
		}
	}
	return out;
}

/** The account's ElastiCache engine versions (presence ⇒ the service is available/authorized). */
async function fetchCacheEngineVersions(
	region: string,
	credentials: AwsCreds,
): Promise<CacheEngineVersion[]> {
	const client = new ElastiCacheClient({ region, credentials, ...AWS_CREDS_OPTS });
	const resp = await client.send(new DescribeCacheEngineVersionsCommand({ MaxRecords: 100 }));
	return resp.CacheEngineVersions ?? [];
}

/** Whether DynamoDB is reachable/authorized for the account (DescribeLimits resolves). */
async function fetchNosqlAvailable(region: string, credentials: AwsCreds): Promise<boolean> {
	const client = new DynamoDBClient({ region, credentials, ...AWS_CREDS_OPTS });
	await client.send(new DescribeLimitsCommand({}));
	return true;
}

/** Enumerate this AWS account's launchable managed services (DB engines+versions, cache tiers, EKS
 * versions, DynamoDB availability) into `cloud_capability_services`. Fills the dispatcher's AWS stub;
 * best-effort (the dispatcher stamps freshness + swallows errors). */
export async function syncAwsServiceCapabilities(
	identity: CapabilityIdentity,
): Promise<void> {
	const db = getServiceDb();
	const identityId = identity.id;
	const root = await assumeAwsRole(identity, { purpose: "svc-capabilities" });
	const ctx: ServiceNormalizeCtx = {
		cloudIdentityId: identityId,
		region: root.region,
		now: new Date(),
	};
	const creds = root.credentials;

	const rows: CloudCapabilityServiceInsert[] = [];
	const seenNativeIds: string[] = [];
	let allAxesOk = true;

	// Each axis is independent + best-effort: a missing grant on one never loses the others. The
	// soft-remove reconcile below only runs when EVERY axis succeeded (no partial retirement).
	const collect = async (
		fetchNormalize: () => Promise<CloudCapabilityServiceInsert[]>,
	): Promise<void> => {
		try {
			const axisRows = await fetchNormalize();
			for (const r of axisRows) {
				rows.push(r);
				seenNativeIds.push(r.native_id);
			}
		} catch {
			allAxesOk = false;
		}
	};

	await collect(async () =>
		normalizeK8sVersionRows(await fetchK8sVersions(root.region, creds), ctx),
	);
	await collect(async () =>
		normalizeDatabaseRows(await fetchDbEngineVersions(root.region, creds), ctx),
	);
	await collect(async () =>
		normalizeDbInstanceClassRows(
			await fetchOrderableDbInstanceOptions(root.region, creds),
			ctx,
		),
	);
	// One fetch, two axes: the tiers the service gates and the engine versions it reports.
	await collect(async () => {
		const cacheVersions = await fetchCacheEngineVersions(root.region, creds);
		return [
			...normalizeCacheTierRows(cacheVersions, ctx),
			...normalizeCacheVersionRows(cacheVersions, ctx),
		];
	});
	await collect(async () =>
		normalizeNosqlRows(await fetchNosqlAvailable(root.region, creds), ctx),
	);

	if (rows.length > 0) {
		await db
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

	// Only reconcile removals on a fully-consistent sweep — a partial failure must not retire a healthy
	// axis's offerings. One call covers the table because native_ids don't collide across the kinds: the
	// composites are engine-prefixed (`<engine>-<version>` / `<engine>-<sku>`), and a SKU can never read
	// as a version, so a `database` row and a `database_instance_class` row are never the same string.
	if (allAxesOk) {
		await softRemoveUnseen("cloud_capability_services", identityId, seenNativeIds);
	}
}
