// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Every capability-backed picker on the design canvas resolves through this module.
//
// Each export IS a `(ctx: FieldCtx) => FieldOption[]` — i.e. literally a `Resolvable<FieldOption[]>`
// — so a schema field reads `options: instanceTypeOptions` and nothing about the field engine has to
// change. Pure: no React, no fetch, no promises. The account data arrives pre-resolved on
// `ctx.caps` (see CapabilityBag).
//
// THREE INVARIANTS LIVE HERE AND NOWHERE ELSE. Putting them in one pure module is the whole point of
// the seam — it is what stops #939 / #977 / #980 from each re-implementing them in `config-schema.ts`
// and colliding on that file:
//
//   1. FAIL-OPEN (#918). An account with no synced rows falls back to the static catalog. The picker
//      is NEVER empty — an empty <Select> renders a blank trigger and silently says nothing.
//   2. TRI-STATE → ADVISORY. `launchable` becomes guidance ink, never a `disabled` attribute, and
//      never an affirmative marker (see OptionAdvisory).
//   3. PROVIDER-MISMATCH GUARD. The bag describes ONE identity; a node's effective provider can
//      diverge from it. On mismatch we degrade to the static catalog — showing another cloud's SKUs
//      would be worse than showing none.

import {
	CACHE_NODE_TYPES,
	INSTANCE_TYPES,
	K8S_VERSIONS,
	NOSQL,
	REGION_LABELS,
} from "@/lib/cloud-providers";
import type {
	CapabilityOption,
	FieldCtx,
	FieldOption,
	OptionAdvisory,
} from "./config-schema";

/**
 * Does the loaded bag actually describe THIS node's cloud?
 *
 * `getEffectiveIdentity` and `getEffectiveProvider` (use-canvas-store) resolve by independent paths
 * and can disagree — a node can carry a `provider` with no `cloud_identity_id`. Keying the bag on
 * the effective identity *should* make a mismatch unreachable; this guard is kept anyway, because
 * the failure it prevents (an AWS project offering GCP machine types) is silent and wrong-looking
 * rather than merely unhelpful.
 */
function forThisNode(ctx: FieldCtx): boolean {
	return ctx.provider !== null && ctx.caps.provider === ctx.provider;
}

/** Account rows for an axis, or [] when there is no usable per-account signal. */
function accountRows(ctx: FieldCtx, rows: CapabilityOption[]): CapabilityOption[] {
	return forThisNode(ctx) ? rows : [];
}

/**
 * The ONLY place a `launchable` verdict becomes UI.
 *
 * `undefined` (a static fallback row) and `"launchable"` both yield NO advisory — deliberately
 * indistinguishable, because being able to tell "we verified this" from "we have no signal" in a way
 * that implies certainty is exactly the false confidence the tri-state exists to avoid.
 */
export function advisoryFor(
	launchable: CapabilityOption["launchable"],
	reason: string | null | undefined,
): OptionAdvisory | undefined {
	if (launchable === undefined || launchable === "launchable") return undefined;
	return {
		level: launchable === "not_launchable" ? "unavailable" : "unverified",
		note: REASON_TEXT[reason ?? "quota_unknown"] ?? REASON_TEXT.quota_unknown,
	};
}

/**
 * `capability_launchable_reason` is a BOUNDED pgEnum, so it is mapped, never interpolated — the
 * reason ultimately originates from a cloud provider's API and must not reach the DOM as free text.
 * An unrecognised value falls back to the honest "couldn't check" wording.
 */
const REASON_TEXT: Record<string, string> = {
	available: "Available to this account.",
	region_not_offered: "Not offered in this region.",
	quota_zero: "Your quota for this family is 0.",
	sku_restricted: "Restricted on your subscription's offer.",
	not_available_for_subscription: "Not available to your subscription.",
	sold_out: "Capacity sold out.",
	capacity_blocked: "Temporarily out of capacity.",
	quota_unknown: "Quota can't be checked read-only.",
};

/** Map account rows to options, carrying the advisory. */
function toOptions(rows: CapabilityOption[]): FieldOption[] {
	return rows.map((r) => ({
		value: r.value,
		label: r.label,
		advisory: advisoryFor(r.launchable, r.launchableReason),
	}));
}

/**
 * Guarantees the STORED value is representable in the list.
 *
 * Without this, a value the account can't launch — or one left over from a provider/region change —
 * simply vanishes from the options, the Select renders a BLANK trigger, and the panel silently
 * disagrees with what is actually saved in the config. That bug predates capabilities; converting a
 * free-text field to a picker would otherwise make it much more common.
 */
export function withSelected(options: FieldOption[], raw: unknown): FieldOption[] {
	const v = typeof raw === "string" ? raw : "";
	if (!v || options.some((o) => o.value === v)) return options;
	return [
		...options,
		{
			value: v,
			label: v,
			advisory: { level: "unverified", note: "Not reported for this account." },
		},
	];
}

// ── region ──────────────────────────────────────────────────────────────────────────────────────

/** Region CODES for the grouped region select. `groupRegions` handles unknown codes gracefully. */
export function regionCodes(ctx: FieldCtx): string[] {
	const { provider } = ctx;
	if (!provider) return [];
	const account = forThisNode(ctx) ? ctx.caps.regions : [];
	return account.length > 0 ? account : Object.keys(REGION_LABELS[provider] ?? {});
}

// ── compute ─────────────────────────────────────────────────────────────────────────────────────

export function instanceTypeOptions(ctx: FieldCtx): FieldOption[] {
	const { provider } = ctx;
	if (!provider) return [];
	const rows = accountRows(ctx, ctx.caps.instanceTypes);
	if (rows.length > 0) return toOptions(rows);
	return INSTANCE_TYPES[provider].map((it) => ({
		value: it.value,
		label: `${it.label} · ${it.vcpu} vCPU / ${it.memoryGb} GB`,
	}));
}

export function k8sVersionOptions(ctx: FieldCtx): FieldOption[] {
	const { provider } = ctx;
	if (!provider) return [];
	const rows = accountRows(ctx, ctx.caps.k8sVersions);
	if (rows.length > 0) return toOptions(rows);
	return K8S_VERSIONS[provider].map((v) => ({ value: v, label: v }));
}

// ── data services ───────────────────────────────────────────────────────────────────────────────

export function cacheTierOptions(ctx: FieldCtx): FieldOption[] {
	const { provider } = ctx;
	if (!provider) return [];
	const rows = accountRows(ctx, ctx.caps.cacheTiers);
	if (rows.length > 0) return toOptions(rows);
	return CACHE_NODE_TYPES[provider].map((n) => ({
		value: n.value,
		label: `${n.label} · ${n.memoryGb} GB (${n.cost})`,
	}));
}

/**
 * NoSQL key types. `nosql_key_type` is a Postgres ENUM (`["S","N","B"]`), so any account-reported
 * value outside it is DROPPED: it would save happily through the free-text-ish form path and then
 * fail on insert. Widening the enum needs a migration, which is board-mutex'd.
 */
const NOSQL_KEY_TYPES = ["S", "N", "B"];

export function nosqlKeyTypeOptions(ctx: FieldCtx): FieldOption[] {
	const { provider } = ctx;
	const rows = accountRows(ctx, ctx.caps.nosqlKeyTypes).filter((r) =>
		NOSQL_KEY_TYPES.includes(r.value),
	);
	if (rows.length > 0) return toOptions(rows);
	const statics = provider
		? NOSQL[provider].keyTypes
		: [{ value: "S", label: "String" }];
	return statics.map((k) => ({ value: k.value, label: k.label }));
}

/**
 * Intersect account-reported engines with a STATIC floor (`variantOptionsFor`, which encodes
 * deploy-time truth — the Hetzner chart mapper only knows CNPG/Valkey, regardless of what the
 * account could theoretically run).
 *
 * If the intersection is EMPTY the floor wins. Otherwise a project whose capability sync failed —
 * or a cloud we enumerate imperfectly — renders an empty engine radio, which is a direct #918
 * violation and leaves the user unable to pick anything at all.
 */
export function intersectWithFloor(
	floor: { value: string; label: string; description?: string }[],
	account: CapabilityOption[],
): FieldOption[] {
	if (account.length === 0) return floor;
	const allowed = new Set(account.map((a) => a.value));
	const kept = floor.filter((f) => allowed.has(f.value));
	if (kept.length === 0) return floor;
	const advisoryByValue = new Map(
		account.map((a) => [a.value, advisoryFor(a.launchable, a.launchableReason)]),
	);
	return kept.map((f) => ({ ...f, advisory: advisoryByValue.get(f.value) }));
}

// ── placement inventory (#980) ──────────────────────────────────────────────────────────────────

/**
 * Existing networks. The option VALUE is the provider-native id (`vpc-…`) because
 * `project_network.network_id` stores that, not the `cloud_networks` row uuid — writing a uuid there
 * would silently break the OpenTofu path that consumes it.
 */
export function existingNetworkOptions(ctx: FieldCtx): FieldOption[] {
	if (!forThisNode(ctx)) return [];
	return ctx.caps.networks.map((n) => ({
		value: n.nativeId,
		label: n.name ? `${n.name} · ${n.nativeId}` : n.nativeId,
		description:
			[n.region, n.cidrBlock, n.isDefault ? "default" : null]
				.filter(Boolean)
				.join(" · ") || undefined,
	}));
}

/** Subnets, optionally narrowed to the selected network. */
export function subnetOptions(ctx: FieldCtx, networkNativeId?: string): FieldOption[] {
	if (!forThisNode(ctx)) return [];
	const parent = networkNativeId
		? ctx.caps.networks.find((n) => n.nativeId === networkNativeId)
		: undefined;
	const rows = parent
		? ctx.caps.subnets.filter((s) => s.networkRowId === null || s.networkRowId === parent.nativeId)
		: ctx.caps.subnets;
	return rows.map((s) => ({
		value: s.nativeId,
		label: s.name ? `${s.name} · ${s.nativeId}` : s.nativeId,
		description:
			[s.availabilityZone, s.cidrBlock, s.isPublic ? "public" : "private"]
				.filter(Boolean)
				.join(" · ") || undefined,
	}));
}
