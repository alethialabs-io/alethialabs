// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import "server-only";

// Read builder for the per-tenant capabilities catalog (epic #928 / wave:capabilities). The design-canvas
// pickers read THIS account's launchable regions + instance types here, with FAIL-OPEN fallback to the
// static Catalog #2 (lib/cloud-providers/{regions,compute}.ts) whenever the account has no synced rows
// (fresh connect / sync error) — so the picker is never empty.
//
// SECURITY: unlike lib/queries/runner-capabilities.ts (platform-internal, getServiceDb + RLS-bypass),
// these are TENANT reads — they run PDP-gated under withActorScope so the programmables.sql RLS actually
// enforces cross-tenant isolation (a caller can only read capabilities for a cloud_identity they
// own/share), and every query also filters `provider` (the cross-provider-leak rule). `launchable` /
// `launchable_reason` are BOUNDED enums; render them as escaped text, never dangerouslySetInnerHTML.

import { and, eq, isNull } from "drizzle-orm";
import { authorize } from "@/lib/authz/guard";
import { withActorScope } from "@/lib/db";
import {
	cloudCapabilityInstanceTypes,
	cloudCapabilityQuotas,
	cloudCapabilityRegions,
	cloudCapabilityServices,
} from "@/lib/db/schema";
import {
	CACHE_NODE_TYPES,
	type CloudProviderSlug,
	DB_CAPACITY,
	DB_ENGINES,
	INSTANCE_TYPES,
	K8S_VERSIONS,
	NOSQL,
	REGION_LABELS,
} from "@/lib/cloud-providers/generated/catalog";
import type {
	CapabilityLaunchable,
	CapabilityLaunchableReason,
	CapabilityQuotaKind,
} from "@/lib/db/schema";
import { sortVersionsDesc } from "@/lib/cloud-providers/capabilities/services/version";

/** An instance-type option the pickers consume — the static Catalog #2 shape plus the account-accurate
 * tri-state verdict (absent when the row is a static fallback). */
export interface CapabilityInstanceOption {
	value: string;
	label: string;
	vcpu: number | null;
	memoryGb: number | null;
	/** Rough monthly cost (static-catalog rows only; null for federated rows). */
	cost?: string;
	/** Account-accurate launch verdict. `undefined` ⇒ static fallback (no per-account signal). */
	launchable?: CapabilityLaunchable;
	launchableReason?: CapabilityLaunchableReason | null;
}

/** A region read, with its provenance. */
export interface CapabilityRegions {
	codes: string[];
	/** `account` = the account's synced regions · `catalog` = the fail-open full set. */
	source: "account" | "catalog";
}

/**
 * The region CODES this account can deploy to. Fails open to the static catalog's full region set for
 * the provider when nothing has synced yet. The picker groups these via `groupRegions(codes, provider)`.
 *
 * Returns the SOURCE alongside the codes: the fail-open is otherwise invisible in the payload (both
 * branches are just `string[]`), so a caller cannot tell "your account's 12 regions" from "the
 * catalog's 34" — which is exactly the distinction the picker's provenance footnote needs.
 */
export async function getRegionCapabilities(
	cloudIdentityId: string,
	provider: CloudProviderSlug,
): Promise<CapabilityRegions> {
	const actor = await authorize("view", {
		type: "cloud_identity",
		id: cloudIdentityId,
	});
	const rows = await withActorScope(actor, (tx) =>
		tx
			.select({ code: cloudCapabilityRegions.native_id })
			.from(cloudCapabilityRegions)
			.where(
				and(
					eq(cloudCapabilityRegions.cloud_identity_id, cloudIdentityId),
					eq(cloudCapabilityRegions.provider, provider),
					isNull(cloudCapabilityRegions.removed_at),
				),
			)
			.orderBy(cloudCapabilityRegions.native_id),
	);
	if (rows.length > 0) return { codes: rows.map((r) => r.code), source: "account" };
	// Fail-open: the static catalog's full region set for this provider.
	return { codes: Object.keys(REGION_LABELS[provider] ?? {}), source: "catalog" };
}

/**
 * The instance/machine/server types this account can launch — optionally scoped to a region. Fails open
 * to the static catalog's per-provider list (which carries no per-account `launchable` signal) when
 * nothing has synced yet. Availability is GUIDANCE — the picker renders `not_launchable`/`not_evaluable`
 * as advisory, never a hard gate.
 */
export async function getInstanceTypeCapabilities(
	cloudIdentityId: string,
	provider: CloudProviderSlug,
	region?: string,
): Promise<CapabilityInstanceOption[]> {
	const actor = await authorize("view", {
		type: "cloud_identity",
		id: cloudIdentityId,
	});
	const rows = await withActorScope(actor, (tx) =>
		tx
			.select({
				value: cloudCapabilityInstanceTypes.native_id,
				name: cloudCapabilityInstanceTypes.name,
				vcpu: cloudCapabilityInstanceTypes.vcpu,
				memGb: cloudCapabilityInstanceTypes.mem_gb,
				launchable: cloudCapabilityInstanceTypes.launchable,
				launchableReason: cloudCapabilityInstanceTypes.launchable_reason,
			})
			.from(cloudCapabilityInstanceTypes)
			.where(
				and(
					eq(cloudCapabilityInstanceTypes.cloud_identity_id, cloudIdentityId),
					eq(cloudCapabilityInstanceTypes.provider, provider),
					isNull(cloudCapabilityInstanceTypes.removed_at),
					region
						? eq(cloudCapabilityInstanceTypes.region, region)
						: undefined,
				),
			)
			.orderBy(cloudCapabilityInstanceTypes.native_id),
	);
	if (rows.length > 0) {
		return rows.map((r) => ({
			value: r.value,
			label: r.name ?? r.value,
			vcpu: r.vcpu,
			memoryGb: r.memGb,
			launchable: r.launchable,
			launchableReason: r.launchableReason,
		}));
	}
	// Fail-open: the static catalog for this provider (no per-account launch verdict).
	return (INSTANCE_TYPES[provider] ?? []).map((it) => ({
		value: it.value,
		label: it.label,
		vcpu: it.vcpu,
		memoryGb: it.memoryGb,
		cost: it.cost,
	}));
}

// ── Managed-SERVICE reads (Wave-2) ──────────────────────────────────────────────────
// The service-axis twin of the region/instance reads: each queries `cloud_capability_services` for its
// `service_kind` and fails open to the matching static Catalog #2 slice when nothing has synced yet.
// Same tenancy discipline — PDP-gated `authorize("view", cloud_identity)` → RLS-enforced withActorScope,
// always filtered by `provider`. `launchable`/`launchableReason` are BOUNDED enums (render as text).

/** A managed-Kubernetes version option — the offered control-plane version plus, for federated rows, the
 * account-accurate launch verdict (absent when it is a static fallback). */
export interface CapabilityK8sVersionOption {
	version: string;
	launchable?: CapabilityLaunchable;
	launchableReason?: CapabilityLaunchableReason | null;
}

/** A managed database engine option — the engine value plus EVERY offered version, newest-first, and
 * the account verdict for federated rows.
 *
 * `versions` is the engine-version axis the picker offers (#1351). It is never empty: a federated row
 * always carries a version, and the static fallback contributes the catalog's default as a
 * one-element list. `version` is the NEWEST offered version — a convenience mirror of `versions[0]`,
 * kept because a single-value caller shouldn't have to know that the list is sorted newest-first. */
export interface CapabilityDbEngineOption {
	value: string;
	label: string;
	version: string | null;
	versions: string[];
	launchable?: CapabilityLaunchable;
	launchableReason?: CapabilityLaunchableReason | null;
}

/** A managed database read: the launchable engines for this account plus the static (UI-only) capacity
 * model for the provider — the scaling-unit metadata is not account-enumerated. */
export interface CapabilityDatabaseOption {
	engines: CapabilityDbEngineOption[];
	capacity: (typeof DB_CAPACITY)[CloudProviderSlug];
}

/** A concrete managed-DB SKU this account can launch (`db.r6g.large`, `db-custom-2-7680`,
 * `Standard_D2s_v3`). `memoryGb` is null where the provider doesn't report it — an honest gap, not 0.
 * There is no static-catalog counterpart: a SKU is the non-portable escape hatch the catalog omits. */
export interface CapabilityInstanceClassOption {
	value: string;
	label: string;
	/** The engine the SKU was reported for; null = every engine (Cloud SQL lists tiers per project). */
	engine: string | null;
	memoryGb: number | null;
	launchable?: CapabilityLaunchable;
	launchableReason?: CapabilityLaunchableReason | null;
}

/** An offered cache ENGINE version (`7.1`). Distinct from the cache TIER axis — a node class and an
 * engine version are orthogonal choices on the same service. */
export interface CapabilityCacheVersionOption {
	version: string;
	launchable?: CapabilityLaunchable;
	launchableReason?: CapabilityLaunchableReason | null;
}

/** A managed cache tier option — the node class + memory, plus the account verdict for federated rows.
 * `cost` is carried on static-catalog rows only. */
export interface CapabilityCacheTierOption {
	value: string;
	label: string;
	memoryGb: number | null;
	cost?: string;
	launchable?: CapabilityLaunchable;
	launchableReason?: CapabilityLaunchableReason | null;
}

/** A managed-NoSQL read: the provider's static service metadata (billing modes / key types / portability
 * note — the picker's shape) plus this account's availability verdict (`available` is false for a cloud
 * with no NoSQL offering, e.g. Hetzner, and reflects a federated `not_launchable` row when present). */
export interface CapabilityNosqlOption {
	serviceName: string;
	available: boolean;
	config: (typeof NOSQL)[CloudProviderSlug];
	launchable?: CapabilityLaunchable;
	launchableReason?: CapabilityLaunchableReason | null;
}

/**
 * The managed-Kubernetes control-plane versions this account can launch. Fails open to the static
 * catalog's `K8S_VERSIONS[provider]` when nothing has synced yet (no per-account verdict on fallback).
 */
export async function getK8sVersionCapabilities(
	cloudIdentityId: string,
	provider: CloudProviderSlug,
): Promise<CapabilityK8sVersionOption[]> {
	const actor = await authorize("view", {
		type: "cloud_identity",
		id: cloudIdentityId,
	});
	const rows = await withActorScope(actor, (tx) =>
		tx
			.select({
				version: cloudCapabilityServices.version,
				nativeId: cloudCapabilityServices.native_id,
				launchable: cloudCapabilityServices.launchable,
				launchableReason: cloudCapabilityServices.launchable_reason,
			})
			.from(cloudCapabilityServices)
			.where(
				and(
					eq(cloudCapabilityServices.cloud_identity_id, cloudIdentityId),
					eq(cloudCapabilityServices.provider, provider),
					eq(cloudCapabilityServices.service_kind, "kubernetes"),
					isNull(cloudCapabilityServices.removed_at),
				),
			)
			.orderBy(cloudCapabilityServices.native_id),
	);
	if (rows.length > 0) {
		return rows.map((r) => ({
			version: r.version ?? r.nativeId,
			launchable: r.launchable,
			launchableReason: r.launchableReason,
		}));
	}
	// Fail-open: the static catalog's version set for this provider.
	return (K8S_VERSIONS[provider] ?? []).map((version) => ({ version }));
}

/**
 * The managed database engines this account can launch — each with EVERY offered version — plus the
 * static capacity model. Fails open to `DB_ENGINES[provider]` when nothing has synced yet.
 *
 * The lanes emit one row per (engine, version) and per region, so this GROUPS BY ENGINE. That is not
 * cosmetic: before #1351 the read projected `native_id` as the engine identity, so on Azure — whose
 * lane enumerates every subscription location — the picker received `azure-postgresql-16` once per
 * region as a separate "engine". Grouping by the `engine` column and deduping versions collapses that
 * back to one engine with a version list, which is also the shape the version picker needs.
 *
 * Deliberately region-agnostic: the other four lanes anchor their rows to a single canonical region,
 * so filtering by region here would silently empty the picker for them. A version offered in ANY
 * region keeps the most permissive verdict — an account that can launch it somewhere should not be
 * told it cannot.
 */
export async function getDatabaseCapabilities(
	cloudIdentityId: string,
	provider: CloudProviderSlug,
): Promise<CapabilityDatabaseOption> {
	const actor = await authorize("view", {
		type: "cloud_identity",
		id: cloudIdentityId,
	});
	const rows = await withActorScope(actor, (tx) =>
		tx
			.select({
				engine: cloudCapabilityServices.engine,
				nativeId: cloudCapabilityServices.native_id,
				name: cloudCapabilityServices.name,
				version: cloudCapabilityServices.version,
				launchable: cloudCapabilityServices.launchable,
				launchableReason: cloudCapabilityServices.launchable_reason,
			})
			.from(cloudCapabilityServices)
			.where(
				and(
					eq(cloudCapabilityServices.cloud_identity_id, cloudIdentityId),
					eq(cloudCapabilityServices.provider, provider),
					eq(cloudCapabilityServices.service_kind, "database"),
					isNull(cloudCapabilityServices.removed_at),
				),
			)
			.orderBy(cloudCapabilityServices.native_id),
	);
	const capacity = DB_CAPACITY[provider];
	if (rows.length > 0) {
		return { engines: groupDbEnginesByVersion(rows), capacity };
	}
	// Fail-open: the static catalog's engine set (no per-account launch verdict). The catalog knows
	// only one version per engine, so `versions` is honestly a one-element list rather than a guess.
	// `launchable` stays UNDEFINED here — that sentinel is what marks a row as catalog-sourced for
	// `sourceOf` (the provenance footnote) and `advisoryFor`; setting it would claim an account
	// verdict we never obtained.
	return {
		engines: (DB_ENGINES[provider] ?? []).map((e) => ({
			value: e.value,
			label: e.label,
			version: e.defaultVersion,
			versions: [e.defaultVersion],
		})),
		capacity,
	};
}

/** Row shape `groupDbEnginesByVersion` folds — the federated `database` rows as selected above. */
export interface DbCapabilityRow {
	engine: string | null;
	nativeId: string;
	name: string | null;
	version: string | null;
	launchable: CapabilityLaunchable;
	launchableReason: CapabilityLaunchableReason | null;
}

/**
 * Folds per-(engine, version, region) rows into one option per engine, versions newest-first.
 *
 * Keyed on the `engine` column, falling back to `native_id` for any legacy row written before the
 * lanes canonicalized (a stale row is soft-removed on the next sweep, but it must not crash or
 * duplicate an engine in the meantime). Verdicts merge permissively: `launchable` beats
 * `not_evaluable` beats `not_launchable`, because the rows differ by region and the picker is not
 * region-scoped — reporting the worst region's verdict would understate what the account can do.
 */
export function groupDbEnginesByVersion(
	rows: DbCapabilityRow[],
): CapabilityDbEngineOption[] {
	const RANK: Record<CapabilityLaunchable, number> = {
		launchable: 2,
		not_evaluable: 1,
		not_launchable: 0,
	};
	const byEngine = new Map<
		string,
		{ option: CapabilityDbEngineOption; versions: Set<string> }
	>();
	for (const r of rows) {
		const key = r.engine ?? r.nativeId;
		const entry = byEngine.get(key);
		if (!entry) {
			byEngine.set(key, {
				option: {
					value: key,
					label: r.name ?? key,
					version: r.version,
					versions: [],
					launchable: r.launchable,
					launchableReason: r.launchableReason,
				},
				versions: new Set(r.version ? [r.version] : []),
			});
			continue;
		}
		if (r.version) entry.versions.add(r.version);
		if (RANK[r.launchable] > RANK[entry.option.launchable ?? "not_launchable"]) {
			entry.option.launchable = r.launchable;
			entry.option.launchableReason = r.launchableReason;
		}
	}
	const out: CapabilityDbEngineOption[] = [];
	for (const { option, versions } of byEngine.values()) {
		const sorted = sortVersionsDesc([...versions]);
		out.push({ ...option, versions: sorted, version: sorted[0] ?? option.version });
	}
	return out.sort((a, b) => a.value.localeCompare(b.value));
}

/**
 * The concrete managed-DB SKUs this account can launch, optionally narrowed to one engine.
 *
 * There is NO static Catalog #2 slice to fail open to — the catalog models capacity portably (vCPU/ACU
 * ranges), and a SKU is by definition the non-portable escape hatch. So "nothing synced" returns an
 * EMPTY list, and the caller is responsible for still offering the resolver default (see
 * `dbInstanceClassOptions`): an empty list here means "we have nothing to tell you", never "there is
 * nothing".
 *
 * `engine === null` on a row means the SKU is offerable for every engine — Cloud SQL lists tiers per
 * PROJECT, and pretending otherwise would attach a per-engine claim the API never made. Those rows
 * therefore match whatever engine is asked for.
 *
 * Region-agnostic for the same reason as `getDatabaseCapabilities`: four of the five lanes anchor rows
 * to one canonical region, so filtering here would silently empty the picker for them.
 */
export async function getDbInstanceClassCapabilities(
	cloudIdentityId: string,
	provider: CloudProviderSlug,
	engine?: string,
): Promise<CapabilityInstanceClassOption[]> {
	const actor = await authorize("view", {
		type: "cloud_identity",
		id: cloudIdentityId,
	});
	const rows = await withActorScope(actor, (tx) =>
		tx
			.select({
				engine: cloudCapabilityServices.engine,
				tier: cloudCapabilityServices.tier,
				nativeId: cloudCapabilityServices.native_id,
				name: cloudCapabilityServices.name,
				memGb: cloudCapabilityServices.mem_gb,
				launchable: cloudCapabilityServices.launchable,
				launchableReason: cloudCapabilityServices.launchable_reason,
			})
			.from(cloudCapabilityServices)
			.where(
				and(
					eq(cloudCapabilityServices.cloud_identity_id, cloudIdentityId),
					eq(cloudCapabilityServices.provider, provider),
					eq(cloudCapabilityServices.service_kind, "database_instance_class"),
					isNull(cloudCapabilityServices.removed_at),
				),
			)
			.orderBy(cloudCapabilityServices.native_id),
	);
	return dedupeInstanceClasses(rows, engine);
}

/** Row shape `dedupeInstanceClasses` folds — the federated `database_instance_class` rows. */
export interface InstanceClassRow {
	engine: string | null;
	tier: string | null;
	nativeId: string;
	name: string | null;
	memGb: number | null;
	launchable: CapabilityLaunchable;
	launchableReason: CapabilityLaunchableReason | null;
}

/**
 * Folds SKU rows into one option per (engine, SKU), optionally narrowed to one engine.
 *
 * The SKU lives in `tier`; `native_id` is the engine-prefixed composite the unique key needs, so it is
 * only a fallback for a row written before that convention. Keyed on (engine, SKU) rather than SKU
 * alone so the caller can still narrow by engine — the same class is orderable for more than one
 * engine, and collapsing them would lose which. Verdicts merge permissively across REGIONS — identical
 * to `groupDbEnginesByVersion`, and for the same reason: the picker is not region-scoped, so the worst
 * region's verdict would understate the account.
 */
export function dedupeInstanceClasses(
	rows: InstanceClassRow[],
	engine?: string,
): CapabilityInstanceClassOption[] {
	const RANK: Record<CapabilityLaunchable, number> = {
		launchable: 2,
		not_evaluable: 1,
		not_launchable: 0,
	};
	const byKey = new Map<string, CapabilityInstanceClassOption>();
	for (const r of rows) {
		// A null engine is the engine-agnostic case (GCP tiers) and matches every requested engine.
		if (engine && r.engine !== null && r.engine !== engine) continue;
		const value = r.tier ?? r.nativeId;
		const key = `${r.engine ?? "*"}|${value}`;
		const existing = byKey.get(key);
		if (!existing) {
			byKey.set(key, {
				value,
				label: r.name ?? value,
				engine: r.engine,
				memoryGb: r.memGb,
				launchable: r.launchable,
				launchableReason: r.launchableReason,
			});
			continue;
		}
		if (RANK[r.launchable] > RANK[existing.launchable ?? "not_launchable"]) {
			existing.launchable = r.launchable;
			existing.launchableReason = r.launchableReason;
		}
		if (existing.memoryGb === null && r.memGb !== null) existing.memoryGb = r.memGb;
	}
	return [...byKey.values()].sort(
		(a, b) => a.value.localeCompare(b.value) || (a.engine ?? "").localeCompare(b.engine ?? ""),
	);
}

/**
 * The cache ENGINE VERSIONS this account can launch. Like the SKU reader there is no static slice to
 * fail open to — the catalog models cache tiers, not engine versions — so an unsynced account returns
 * an empty list and the caller keeps offering the cloud default.
 *
 * Region-agnostic, and deduped across engines: the canvas has one `engine_version` box per cache node
 * and no cache-engine selector, so splitting the list per engine would offer a distinction the form
 * cannot express.
 */
export async function getCacheVersionCapabilities(
	cloudIdentityId: string,
	provider: CloudProviderSlug,
): Promise<CapabilityCacheVersionOption[]> {
	const actor = await authorize("view", {
		type: "cloud_identity",
		id: cloudIdentityId,
	});
	const rows = await withActorScope(actor, (tx) =>
		tx
			.select({
				version: cloudCapabilityServices.version,
				launchable: cloudCapabilityServices.launchable,
				launchableReason: cloudCapabilityServices.launchable_reason,
			})
			.from(cloudCapabilityServices)
			.where(
				and(
					eq(cloudCapabilityServices.cloud_identity_id, cloudIdentityId),
					eq(cloudCapabilityServices.provider, provider),
					eq(cloudCapabilityServices.service_kind, "cache_version"),
					isNull(cloudCapabilityServices.removed_at),
				),
			)
			.orderBy(cloudCapabilityServices.native_id),
	);
	const seen = new Map<string, CapabilityCacheVersionOption>();
	for (const r of rows) {
		if (!r.version || seen.has(r.version)) continue;
		seen.set(r.version, {
			version: r.version,
			launchable: r.launchable,
			launchableReason: r.launchableReason,
		});
	}
	return sortVersionsDesc([...seen.keys()]).map((v) => {
		const row = seen.get(v);
		return row ?? { version: v };
	});
}

/**
 * The managed cache tiers this account can launch — optionally scoped to a region. Fails open to
 * `CACHE_NODE_TYPES[provider]` (which carries the static `cost` hint, absent on federated rows) when
 * nothing has synced yet.
 */
export async function getCacheTierCapabilities(
	cloudIdentityId: string,
	provider: CloudProviderSlug,
	region?: string,
): Promise<CapabilityCacheTierOption[]> {
	const actor = await authorize("view", {
		type: "cloud_identity",
		id: cloudIdentityId,
	});
	const rows = await withActorScope(actor, (tx) =>
		tx
			.select({
				value: cloudCapabilityServices.native_id,
				name: cloudCapabilityServices.name,
				memGb: cloudCapabilityServices.mem_gb,
				launchable: cloudCapabilityServices.launchable,
				launchableReason: cloudCapabilityServices.launchable_reason,
			})
			.from(cloudCapabilityServices)
			.where(
				and(
					eq(cloudCapabilityServices.cloud_identity_id, cloudIdentityId),
					eq(cloudCapabilityServices.provider, provider),
					eq(cloudCapabilityServices.service_kind, "cache"),
					isNull(cloudCapabilityServices.removed_at),
					region ? eq(cloudCapabilityServices.region, region) : undefined,
				),
			)
			.orderBy(cloudCapabilityServices.native_id),
	);
	if (rows.length > 0) {
		return rows.map((r) => ({
			value: r.value,
			label: r.name ?? r.value,
			memoryGb: r.memGb,
			launchable: r.launchable,
			launchableReason: r.launchableReason,
		}));
	}
	// Fail-open: the static catalog for this provider (carries the `cost` hint, no launch verdict).
	return (CACHE_NODE_TYPES[provider] ?? []).map((c) => ({
		value: c.value,
		label: c.label,
		memoryGb: c.memoryGb,
		cost: c.cost,
	}));
}

/**
 * This account's managed-NoSQL availability + the provider's static service config. Fails open to the
 * static `NOSQL[provider]` (with `available` derived from whether the provider offers a NoSQL service)
 * when nothing has synced yet. A federated `not_launchable` row flips `available` to false.
 */
export async function getNosqlCapability(
	cloudIdentityId: string,
	provider: CloudProviderSlug,
): Promise<CapabilityNosqlOption> {
	const actor = await authorize("view", {
		type: "cloud_identity",
		id: cloudIdentityId,
	});
	const config = NOSQL[provider];
	const rows = await withActorScope(actor, (tx) =>
		tx
			.select({
				name: cloudCapabilityServices.name,
				nativeId: cloudCapabilityServices.native_id,
				launchable: cloudCapabilityServices.launchable,
				launchableReason: cloudCapabilityServices.launchable_reason,
			})
			.from(cloudCapabilityServices)
			.where(
				and(
					eq(cloudCapabilityServices.cloud_identity_id, cloudIdentityId),
					eq(cloudCapabilityServices.provider, provider),
					eq(cloudCapabilityServices.service_kind, "nosql"),
					isNull(cloudCapabilityServices.removed_at),
				),
			)
			.limit(1),
	);
	const row = rows[0];
	if (row) {
		return {
			serviceName: row.name ?? row.nativeId,
			available: row.launchable !== "not_launchable",
			config,
			launchable: row.launchable,
			launchableReason: row.launchableReason,
		};
	}
	// Fail-open: static config; a provider with no NoSQL offering (serviceName "—") is unavailable.
	return {
		serviceName: config.serviceName,
		available: config.serviceName !== "—",
		config,
	};
}

// ── Service-quota HEADROOM read (the quota axis, #981; seams #1115) ──────────────────
// Unlike the region/instance/service reads there is NO static Catalog #2 baseline for numeric quotas —
// a limit/used figure is inherently account-specific. So this fails open to an EMPTY list: when nothing
// has synced (fresh connect / sync error / a provider that can't report a quota) the picker simply shows
// no headroom advisory — availability is GUIDANCE, and its absence is honest `not_evaluable`, never a
// hard gate. Same tenancy discipline as the other reads: PDP-gated `authorize("view", cloud_identity)`
// → RLS-enforced withActorScope, always filtered by `provider`.

/** One networking service-quota headroom row the pickers consume. `limit`/`used`/`available` are null
 * when the provider/plan couldn't report the figure (honest `not_evaluable`, not a fabricated zero). */
export interface CapabilityQuotaOption {
	kind: CapabilityQuotaKind;
	/** The provider-native quota code (e.g. AWS `L-0263D0A3`). */
	nativeId: string;
	label: string;
	region: string | null;
	limit: number | null;
	used: number | null;
	available: number | null;
}

/**
 * This account's networking service-quota headroom (EIP / NAT-gateway / load-balancer / security-group),
 * optionally scoped to a region. Fails open to an EMPTY list (no static numeric baseline exists) so the
 * picker degrades to "no advisory" rather than a hard block when nothing has synced.
 */
export async function getQuotaCapabilities(
	cloudIdentityId: string,
	provider: CloudProviderSlug,
	region?: string,
): Promise<CapabilityQuotaOption[]> {
	const actor = await authorize("view", {
		type: "cloud_identity",
		id: cloudIdentityId,
	});
	const rows = await withActorScope(actor, (tx) =>
		tx
			.select({
				kind: cloudCapabilityQuotas.quota_kind,
				nativeId: cloudCapabilityQuotas.native_id,
				name: cloudCapabilityQuotas.name,
				region: cloudCapabilityQuotas.region,
				quotaLimit: cloudCapabilityQuotas.quota_limit,
				used: cloudCapabilityQuotas.used,
				available: cloudCapabilityQuotas.available,
			})
			.from(cloudCapabilityQuotas)
			.where(
				and(
					eq(cloudCapabilityQuotas.cloud_identity_id, cloudIdentityId),
					eq(cloudCapabilityQuotas.provider, provider),
					isNull(cloudCapabilityQuotas.removed_at),
					region ? eq(cloudCapabilityQuotas.region, region) : undefined,
				),
			)
			.orderBy(cloudCapabilityQuotas.quota_kind, cloudCapabilityQuotas.native_id),
	);
	// Fail-open: empty when nothing has synced (no static numeric baseline for quotas).
	return rows.map((r) => ({
		kind: r.kind,
		nativeId: r.nativeId,
		label: r.name ?? r.nativeId,
		region: r.region,
		limit: r.quotaLimit,
		used: r.used,
		available: r.available,
	}));
}
