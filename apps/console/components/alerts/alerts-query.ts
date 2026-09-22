// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Pure, client-safe filter/query plumbing for the Alerts hub — the console filter
// standard's "normalize" step (lib/query/README.md → "Server-side filters"). No React
// and no DB imports: types only, so this file is unit-testable on its own.
//
// The RESOLVE step is not here any more (#4890). It used to be — `filter*()` narrowed the
// bootstrap's universe in memory, because the three server-side siblings existed since #2899
// and nothing called them — and every filtered view of a panel therefore shared one cache
// entry. `alerts-filters.ts` now keys `qk.alert*(org, query)` on the normalized objects below
// and `getAlert*Page(query)` resolves them in SQL, with the facet counts coming from each
// builder's own UNFILTERED pass.
//
// So what is left is exactly the normalize step and the vocabulary around it: the filter
// shapes, their defaults, the status/kind buckets a row falls in, and the human labels for
// those buckets. The labels stay client-side because they are what the USER calls a status,
// and alerts-status.ts reads the same maps for the same values.

import type {
	ChannelDTO,
	DeliveryDTO,
	PolicyDTO,
} from "@/app/server/actions/alerts";
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

/** Sorted, deduped copy of a selection — or undefined when empty. */
function normalizeList(values: string[]): string[] | undefined {
	if (values.length === 0) return undefined;
	return [...new Set(values)].sort();
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

// ── Activity (delivery ledger) ─────────────────────────────────────────────────

// The chip row's ORDER is no longer declared here. `lib/queries/alerts-lists.ts` orders the
// status facet as it counts it, and a second copy of that order on this side is a thing that
// can disagree with the list the user is looking at.

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
