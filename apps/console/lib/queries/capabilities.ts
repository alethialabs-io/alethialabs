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
import { CACHE_NODE_TYPES } from "@/lib/cloud-providers/cache";
import { INSTANCE_TYPES, K8S_VERSIONS } from "@/lib/cloud-providers/compute";
import { DB_CAPACITY, DB_ENGINES } from "@/lib/cloud-providers/database";
import { NOSQL } from "@/lib/cloud-providers/nosql";
import { REGION_LABELS } from "@/lib/cloud-providers/regions";
import type { CloudProviderSlug } from "@/lib/cloud-providers/registry";
import type {
	CapabilityLaunchable,
	CapabilityLaunchableReason,
	CapabilityQuotaKind,
} from "@/lib/db/schema";

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

/**
 * The region CODES this account can deploy to. Fails open to the static catalog's full region set for
 * the provider when nothing has synced yet. The picker groups these via `groupRegions(codes, provider)`.
 */
export async function getRegionCapabilities(
	cloudIdentityId: string,
	provider: CloudProviderSlug,
): Promise<string[]> {
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
	if (rows.length > 0) return rows.map((r) => r.code);
	// Fail-open: the static catalog's full region set for this provider.
	return Object.keys(REGION_LABELS[provider] ?? {});
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

/** A managed database engine option — the engine value + offered version, plus the account verdict for
 * federated rows. `version` is null when the provider/row does not pin one. */
export interface CapabilityDbEngineOption {
	value: string;
	label: string;
	version: string | null;
	launchable?: CapabilityLaunchable;
	launchableReason?: CapabilityLaunchableReason | null;
}

/** A managed database read: the launchable engines for this account plus the static (UI-only) capacity
 * model for the provider — the scaling-unit metadata is not account-enumerated. */
export interface CapabilityDatabaseOption {
	engines: CapabilityDbEngineOption[];
	capacity: (typeof DB_CAPACITY)[CloudProviderSlug];
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
 * The managed database engines this account can launch, plus the static capacity model. Fails open to
 * `DB_ENGINES[provider]` (one row per engine at its default version) when nothing has synced yet.
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
				value: cloudCapabilityServices.native_id,
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
		return {
			engines: rows.map((r) => ({
				value: r.value,
				label: r.name ?? r.value,
				version: r.version,
				launchable: r.launchable,
				launchableReason: r.launchableReason,
			})),
			capacity,
		};
	}
	// Fail-open: the static catalog's engine set (no per-account launch verdict).
	return {
		engines: (DB_ENGINES[provider] ?? []).map((e) => ({
			value: e.value,
			label: e.label,
			version: e.defaultVersion,
		})),
		capacity,
	};
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
