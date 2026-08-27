// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Pure, client-safe filter/query plumbing for the Alerts hub — the console filter
// standard's "normalize" step (lib/query/README.md → "Server-side filters"). No React
// and no DB imports: types only, so this file is unit-testable on its own and can be
// lifted behind a server action unchanged.
//
// The alerts surface is RSC-fed: `getAlertsBootstrap()` hands the client the whole
// channel/policy/delivery universe in one payload and has no filtered sibling, so the
// resolve step below runs against that universe in memory rather than over the wire.
// Everything up to it is the documented pipeline — store → URL sync → debounce →
// normalize — and the normalized objects are exactly what `qk.alertChannels(org, q)` /
// `qk.alertPolicies(org, q)` are shaped to key, so moving the resolve server-side is a
// swap of `filter*()` for a `queryFn`, not a rewrite. See alerts-filters.ts.

import type {
	ChannelDTO,
	DeliveryDTO,
	PolicyDTO,
} from "@/app/server/actions/alerts";
import {
	CHANNEL_TYPE_META,
	CHANNEL_TYPE_ORDER,
} from "@/components/alerts/channel-meta";
import type { AlertDeliveryStatus } from "@/lib/db/schema/enums";

// ── Facets ─────────────────────────────────────────────────────────────────────

/**
 * One facet option with its match count. Counts are always computed over the
 * UNFILTERED universe so options never vanish as you select them.
 */
export interface FacetCount {
	value: string;
	label: string;
	count: number;
}

/** Tally one keyed dimension over a collection, dropping keys nothing maps to. */
function tally<T>(rows: T[], keyOf: (row: T) => string): Map<string, number> {
	const counts = new Map<string, number>();
	for (const row of rows) {
		const key = keyOf(row);
		counts.set(key, (counts.get(key) ?? 0) + 1);
	}
	return counts;
}

/**
 * Order a tally by a fixed value order, keeping only values present in the universe.
 * Generic over the value union so the label lookups stay exhaustive without a cast.
 */
function orderedFacet<V extends string>(
	counts: Map<string, number>,
	order: readonly V[],
	labelOf: (value: V) => string,
): FacetCount[] {
	return order
		.filter((value) => (counts.get(value) ?? 0) > 0)
		.map((value) => ({
			value,
			label: labelOf(value),
			count: counts.get(value) ?? 0,
		}));
}

/** Sorted, deduped copy of a selection — or undefined when empty. */
function normalizeList(values: string[]): string[] | undefined {
	if (values.length === 0) return undefined;
	return [...new Set(values)].sort();
}

/** True when the needle appears in any of the haystacks (case-insensitive). */
function matches(needle: string, haystacks: (string | null | undefined)[]): boolean {
	const q = needle.toLowerCase();
	return haystacks.some((h) => (h ?? "").toLowerCase().includes(q));
}

// ── Channels ───────────────────────────────────────────────────────────────────

/** The three states a channel can be in, as a filterable dimension. */
export const CHANNEL_STATUS_VALUES = ["verified", "unverified", "paused"] as const;

export type ChannelStatusValue = (typeof CHANNEL_STATUS_VALUES)[number];

/** Human labels for the channel status facet. */
export const CHANNEL_STATUS_LABEL: Record<ChannelStatusValue, string> = {
	verified: "Verified",
	unverified: "Not verified",
	paused: "Paused",
};

/** Which status bucket a channel falls in — one row is in exactly one. */
export function channelStatusKey(channel: ChannelDTO): ChannelStatusValue {
	if (!channel.enabled) return "paused";
	return channel.is_verified ? "verified" : "unverified";
}

/** The Channels panel's filter state (the shape its zustand store holds).
 * A type alias (not an interface) so it satisfies the store/url-sync generics'
 * `Record` constraints via the implicit index signature. */
export type ChannelFilters = {
	search: string;
	types: string[];
	status: string[];
};

/** Pristine channel filters — the store's defaults and the Reset target. */
export const DEFAULT_CHANNEL_FILTERS: ChannelFilters = {
	search: "",
	types: [],
	status: [],
};

/**
 * The stable query object placed in the TanStack key (`qk.alertChannels`). Only
 * non-empty fields are present and arrays are sorted + deduped, so two equivalent
 * filter states always produce an identical key (no cache fragmentation).
 */
export interface NormalizedChannelsQuery {
	search?: string;
	types?: string[];
	status?: string[];
}

/** Normalize channel filter state into the stable query object. */
export function normalizeChannelsQuery(
	filters: ChannelFilters,
): NormalizedChannelsQuery {
	const query: NormalizedChannelsQuery = {};
	const search = filters.search.trim();
	if (search) query.search = search;
	const types = normalizeList(filters.types);
	if (types) query.types = types;
	const status = normalizeList(filters.status);
	if (status) query.status = status;
	return query;
}

/** Resolve the normalized channel query against a channel universe. */
export function filterChannels(
	channels: ChannelDTO[],
	query: NormalizedChannelsQuery,
): ChannelDTO[] {
	const types = query.types ? new Set(query.types) : null;
	const status = query.status ? new Set(query.status) : null;
	return channels.filter((c) => {
		if (types && !types.has(c.type)) return false;
		if (status && !status.has(channelStatusKey(c))) return false;
		if (
			query.search &&
			!matches(query.search, [c.name, c.type, CHANNEL_TYPE_META[c.type].name])
		)
			return false;
		return true;
	});
}

/** Channel facet options + counts over the unfiltered universe. */
export function channelFacets(channels: ChannelDTO[]): {
	types: FacetCount[];
	status: FacetCount[];
} {
	return {
		types: orderedFacet(
			tally(channels, (c) => c.type),
			CHANNEL_TYPE_ORDER,
			(value) => CHANNEL_TYPE_META[value].name,
		),
		status: orderedFacet(
			tally(channels, channelStatusKey),
			CHANNEL_STATUS_VALUES,
			(value) => CHANNEL_STATUS_LABEL[value],
		),
	};
}

// ── Policies ───────────────────────────────────────────────────────────────────

/** Whether a policy is currently watching its events. */
export const POLICY_STATUS_VALUES = ["enabled", "off"] as const;

export type PolicyStatusValue = (typeof POLICY_STATUS_VALUES)[number];

/** Human labels for the policy status facet. */
export const POLICY_STATUS_LABEL: Record<PolicyStatusValue, string> = {
	enabled: "Enabled",
	off: "Off",
};

/** PDP-sourced security policies vs everything else. */
export const POLICY_KIND_VALUES = ["security", "operational"] as const;

export type PolicyKindValue = (typeof POLICY_KIND_VALUES)[number];

/** Human labels for the policy kind facet. */
export const POLICY_KIND_LABEL: Record<PolicyKindValue, string> = {
	security: "Security",
	operational: "Operational",
};

/** Which status bucket a policy falls in. */
export function policyStatusKey(policy: PolicyDTO): PolicyStatusValue {
	return policy.enabled ? "enabled" : "off";
}

/** Which kind bucket a policy falls in. */
export function policyKindKey(policy: PolicyDTO): PolicyKindValue {
	return policy.is_security ? "security" : "operational";
}

/** The Policies panel's filter state (see ChannelFilters for the alias rationale). */
export type PolicyFilters = {
	search: string;
	status: string[];
	kinds: string[];
	channels: string[];
};

/** Pristine policy filters — the store's defaults and the Reset target. */
export const DEFAULT_POLICY_FILTERS: PolicyFilters = {
	search: "",
	status: [],
	kinds: [],
	channels: [],
};

/** The stable query object placed in the TanStack key (`qk.alertPolicies`). */
export interface NormalizedPoliciesQuery {
	search?: string;
	status?: string[];
	kinds?: string[];
	channels?: string[];
}

/** Normalize policy filter state into the stable query object. */
export function normalizePoliciesQuery(
	filters: PolicyFilters,
): NormalizedPoliciesQuery {
	const query: NormalizedPoliciesQuery = {};
	const search = filters.search.trim();
	if (search) query.search = search;
	const status = normalizeList(filters.status);
	if (status) query.status = status;
	const kinds = normalizeList(filters.kinds);
	if (kinds) query.kinds = kinds;
	const channels = normalizeList(filters.channels);
	if (channels) query.channels = channels;
	return query;
}

/** Resolve the normalized policy query against a policy universe. */
export function filterPolicies(
	policies: PolicyDTO[],
	query: NormalizedPoliciesQuery,
): PolicyDTO[] {
	const status = query.status ? new Set(query.status) : null;
	const kinds = query.kinds ? new Set(query.kinds) : null;
	const channels = query.channels ? new Set(query.channels) : null;
	return policies.filter((p) => {
		if (status && !status.has(policyStatusKey(p))) return false;
		if (kinds && !kinds.has(policyKindKey(p))) return false;
		if (channels && !p.channelIds.some((id) => channels.has(id))) return false;
		if (query.search && !matches(query.search, [p.name, p.description]))
			return false;
		return true;
	});
}

/**
 * Policy facet options + counts over the unfiltered universe. The channel facet
 * enumerates every configured channel (not only the routed-to ones) so a policy's
 * destination can be picked before any policy uses it.
 */
export function policyFacets(
	policies: PolicyDTO[],
	channels: ChannelDTO[],
): { status: FacetCount[]; kinds: FacetCount[]; channels: FacetCount[] } {
	const routed = new Map<string, number>();
	for (const p of policies)
		for (const id of new Set(p.channelIds))
			routed.set(id, (routed.get(id) ?? 0) + 1);

	return {
		status: orderedFacet(
			tally(policies, policyStatusKey),
			POLICY_STATUS_VALUES,
			(value) => POLICY_STATUS_LABEL[value],
		),
		kinds: orderedFacet(
			tally(policies, policyKindKey),
			POLICY_KIND_VALUES,
			(value) => POLICY_KIND_LABEL[value],
		),
		channels: channels.map((c) => ({
			value: c.id,
			label: c.name,
			count: routed.get(c.id) ?? 0,
		})),
	};
}

// ── Activity (delivery ledger) ─────────────────────────────────────────────────

/** Delivery statuses, in the order the ledger's chip row presents them. */
export const DELIVERY_STATUS_ORDER: AlertDeliveryStatus[] = [
	"sent",
	"pending",
	"failed",
	"dead",
];

/** Human labels for the delivery status facet and the ledger's Status column. */
export const DELIVERY_STATUS_LABEL: Record<AlertDeliveryStatus, string> = {
	pending: "Pending",
	sent: "Sent",
	failed: "Failed",
	dead: "Dead",
};

/** The Activity panel's filter state (see ChannelFilters for the alias rationale). */
export type ActivityFilters = {
	search: string;
	status: string[];
};

/** Pristine activity filters — the store's defaults and the Reset target. */
export const DEFAULT_ACTIVITY_FILTERS: ActivityFilters = {
	search: "",
	status: [],
};

/** The stable query object for the delivery ledger. */
export interface NormalizedActivityQuery {
	search?: string;
	status?: string[];
}

/** Normalize activity filter state into the stable query object. */
export function normalizeActivityQuery(
	filters: ActivityFilters,
): NormalizedActivityQuery {
	const query: NormalizedActivityQuery = {};
	const search = filters.search.trim();
	if (search) query.search = search;
	const status = normalizeList(filters.status);
	if (status) query.status = status;
	return query;
}

/** Resolve the normalized activity query against a delivery universe. */
export function filterDeliveries(
	deliveries: DeliveryDTO[],
	query: NormalizedActivityQuery,
): DeliveryDTO[] {
	const status = query.status ? new Set(query.status) : null;
	return deliveries.filter((d) => {
		if (status && !status.has(d.status)) return false;
		if (query.search && !matches(query.search, [d.title, d.event_key]))
			return false;
		return true;
	});
}

/** Delivery facet options + counts over the unfiltered universe. */
export function activityFacets(deliveries: DeliveryDTO[]): {
	status: FacetCount[];
} {
	return {
		status: orderedFacet(
			tally(deliveries, (d) => d.status),
			DELIVERY_STATUS_ORDER,
			(value) => DELIVERY_STATUS_LABEL[value],
		),
	};
}
