// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import "server-only";
import {
	and,
	count,
	desc,
	eq,
	exists,
	ilike,
	inArray,
	or,
	type SQL,
	sql,
} from "drizzle-orm";
import type {
	ChannelDTO,
	DeliveryDTO,
	PolicyDTO,
} from "@/app/server/actions/alerts";
import {
	CHANNEL_TYPE_META,
	CHANNEL_TYPE_ORDER,
} from "@/components/alerts/channel-meta";
import { getServiceDb } from "@/lib/db";
import { likeTerm } from "@/lib/db/like";
import {
	alertChannels,
	alertDeliveries,
	alertRuleChannels,
	alertRules,
} from "@/lib/db/schema";
import {
	type AlertChannelType,
	alertChannelType,
	type AlertDeliveryStatus,
	alertDeliveryStatus,
	type AlertSeverity,
} from "@/lib/db/schema/enums";
import {
	type FacetOption,
	narrowTo,
	nonEmpty,
	orderedOptions,
	searchTerm,
	tally,
} from "./facets";
import {
	KEYSET_DEFAULT_LIMIT,
	type KeysetListPage,
	type KeysetPageRequest,
	keysetAfter,
	keysetFetchLimit,
	keysetListPage,
	keysetOrderBy,
	keysetPage,
	keysetSortKey,
} from "./keyset";

// The Alerts hub's three lists — channels, policies, and the delivery ledger — filtered in
// SQL (the console filter standard's server half). Service path with an explicit `org_id`
// filter: the service role bypasses RLS, so the org scope is enforced HERE, on every query, from
// the org the caller passes — the actor the read router resolved from the address
// (lib/rpc/procedures/alerts.ts, #6125).
//
// The hub reads these over the `alerts.*` GET procedures; each list's PRISTINE page is also the
// universe the panels cross-reference against. Writes invalidate the keys and the `alerts` topic
// does the same for every other tab, so nothing here depends on `router.refresh()`.
//
// The DTO mappers live here so every read of a row (these lists, the overview's Alerts card)
// returns one shape. The DTO TYPES stay declared in the action module (components import them
// from there); that import is type-only, so it is erased — no runtime cycle.

// ── DTO mapping ─────────────────────────────────────────────────────────────────

/** Maps a channel row to its client-safe DTO (never carries the encrypted secret). */
export function toChannelDTO(row: typeof alertChannels.$inferSelect): ChannelDTO {
	return {
		id: row.id,
		type: row.type,
		name: row.name,
		enabled: row.enabled,
		is_verified: row.is_verified,
		recipients: row.config.recipients ?? [],
		has_secret: Boolean(row.secret),
		last_verified_at: row.last_verified_at?.toISOString() ?? null,
	};
}

/** Maps a rule row + its channel bindings to the policy DTO. */
export function toPolicyDTO(
	row: typeof alertRules.$inferSelect,
	channels: { id: string; minSeverity: AlertSeverity | null }[],
	isSecurity: boolean,
): PolicyDTO {
	return {
		id: row.id,
		name: row.name,
		description: row.description,
		event_patterns: row.event_patterns,
		is_security: isSecurity,
		severity: row.severity,
		match: row.match,
		throttle_seconds: row.throttle_seconds,
		escalate: row.escalate,
		recipient: row.recipient,
		enabled: row.enabled,
		channels,
		channelIds: channels.map((c) => c.id),
	};
}

/** Maps a delivery-ledger row to its DTO. */
export function toDeliveryDTO(
	row: typeof alertDeliveries.$inferSelect,
): DeliveryDTO {
	return {
		id: row.id,
		event_key: row.event_key,
		status: row.status,
		title: row.context.title,
		attempts: row.attempts,
		last_error: row.last_error,
		created_at: row.created_at.toISOString(),
		sent_at: row.sent_at?.toISOString() ?? null,
	};
}

// ── Channels ───────────────────────────────────────────────────────────────────

/** The three states a channel can be in, as a filterable dimension. */
export const CHANNEL_STATUSES = ["verified", "unverified", "paused"] as const;

export type ChannelStatus = (typeof CHANNEL_STATUSES)[number];

/** The Channels panel's normalized query (the `normalizeChannelsQuery()` output). */
export interface AlertChannelsQuery {
	/** Contains-match over the channel name and its transport (slug or display name). */
	search?: string;
	/** Restrict to these channel types; empty/unknown = all. */
	types?: string[];
	/** Restrict to these status buckets; empty/unknown = all. */
	status?: string[];
}

/**
 * The most alert channels one org may configure. Channels are configuration, not a ledger, so the
 * Channels list is UNPAGED by a recorded decision (`apps/console/list-standard/alert-channels.json`)
 * — and this is the server-side bound that decision names, enforced when a channel is created
 * (`addChannel`, app/server/actions/alerts.ts). The read never cuts at it: an org that predates the
 * cap still sees every channel it has.
 */
export const ALERT_CHANNELS_MAX = 50;

/** Rows + the facet options behind the Channels filter bar. Unpaged: see {@link ALERT_CHANNELS_MAX}. */
export interface AlertChannelsPage {
	rows: ChannelDTO[];
	/** The org has no channel at all (the first-run empty state), whatever the filters. Never a count. */
	universeEmpty: boolean;
	facets: {
		/** Types present in the org, in the panel's transport order. */
		types: FacetOption[];
		/** All three buckets, always. */
		status: FacetOption[];
	};
}

/** The status bucket a channel row falls in — the mirror of the client's `channelStatusKey`. */
function channelStatusOf(row: { enabled: boolean; is_verified: boolean }): ChannelStatus {
	if (!row.enabled) return "paused";
	return row.is_verified ? "verified" : "unverified";
}

/** The predicate selecting one channel status bucket. */
function channelStatusPredicate(status: ChannelStatus): SQL | undefined {
	switch (status) {
		case "paused":
			return eq(alertChannels.enabled, false);
		case "verified":
			return and(eq(alertChannels.enabled, true), eq(alertChannels.is_verified, true));
		case "unverified":
			return and(eq(alertChannels.enabled, true), eq(alertChannels.is_verified, false));
	}
}

/**
 * Channel types whose DISPLAY name (or slug) contains `term`. The panel renders "Rocket.Chat"
 * for `rocketchat`, so a search for "rocket chat" has to reach the row — the label is a
 * constant in the transport catalog, not a column, so it is resolved to a VALUE LIST here and
 * matched in SQL. No row is filtered in JS.
 */
function typesMatchingLabel(term: string): AlertChannelType[] {
	const needle = term.toLowerCase();
	return CHANNEL_TYPE_ORDER.filter(
		(type) =>
			type.includes(needle) ||
			CHANNEL_TYPE_META[type].name.toLowerCase().includes(needle),
	);
}

/**
 * The org's alert channels for `query` — rows filtered in SQL, plus facet counts over the
 * org's UNFILTERED channels (the facet pass gets the org predicate and nothing else).
 */
export async function queryAlertChannelsPage(
	orgId: string,
	query: AlertChannelsQuery = {},
): Promise<AlertChannelsPage> {
	const db = getServiceDb();
	const search = searchTerm(query.search);
	const like = search ? likeTerm(search) : undefined;
	const types = narrowTo(alertChannelType.enumValues, query.types);
	const statuses = narrowTo(CHANNEL_STATUSES, query.status);
	const labelTypes = search ? typesMatchingLabel(search) : [];

	const filterConditions = [
		types ? inArray(alertChannels.type, types) : undefined,
		statuses ? or(...statuses.map(channelStatusPredicate)) : undefined,
		like
			? or(
					ilike(alertChannels.name, like),
					labelTypes.length
						? inArray(alertChannels.type, labelTypes)
						: undefined,
				)
			: undefined,
	].filter((c) => c !== undefined);

	const [rows, facetRows] = await Promise.all([
		// ROWS: org scope + the query's predicates.
		db
			.select()
			.from(alertChannels)
			.where(and(eq(alertChannels.org_id, orgId), ...filterConditions))
			.orderBy(desc(alertChannels.created_at)),
		// FACETS: the org predicate ONLY — the whole channel universe, tallied below.
		db
			.select({
				type: alertChannels.type,
				enabled: alertChannels.enabled,
				is_verified: alertChannels.is_verified,
			})
			.from(alertChannels)
			.where(eq(alertChannels.org_id, orgId)),
	]);

	const typeCounts = tally(facetRows, (r) => r.type);
	const statusCounts = tally(facetRows, channelStatusOf);

	return {
		rows: rows.map(toChannelDTO),
		universeEmpty: facetRows.length === 0,
		facets: {
			// Every type the org actually uses, in the transport catalog's order.
			types: CHANNEL_TYPE_ORDER.filter((t) => (typeCounts.get(t) ?? 0) > 0).map(
				(value) => ({
					value,
					label: CHANNEL_TYPE_META[value].name,
					count: typeCounts.get(value) ?? 0,
				}),
			),
			status: orderedOptions(statusCounts, CHANNEL_STATUSES),
		},
	};
}

// ── Policies ───────────────────────────────────────────────────────────────────

/** Whether a policy is currently watching its events. */
export const POLICY_STATUSES = ["enabled", "off"] as const;

/** PDP-sourced security policies vs everything else. */
export const POLICY_KINDS = ["security", "operational"] as const;

export type PolicyKind = (typeof POLICY_KINDS)[number];

/**
 * True when a policy watches SECURITY events.
 *
 * This is the SQL mirror of `is_security` in the DTO — `event_patterns.some(isSecurityKey)`,
 * and `isSecurityKey` is `key.startsWith("authz.")` (lib/alerts/catalog.ts). The two must
 * agree or the kind facet counts one thing while the kind filter selects another: change
 * `isSecurityKey` and this fragment changes with it.
 */
const IS_SECURITY_POLICY = sql<boolean>`exists (
	select 1 from unnest(${alertRules.event_patterns}) as pattern
	where pattern like 'authz.%'
)`;

/** The Policies panel's normalized query (the `normalizePoliciesQuery()` output). */
export interface AlertPoliciesQuery {
	/** Contains-match over the policy name and description. */
	search?: string;
	/** "enabled" / "off"; empty = both. */
	status?: string[];
	/** "security" / "operational"; empty = both. */
	kinds?: string[];
	/** Restrict to policies bound to these channel ids (OR semantics). */
	channels?: string[];
}

/**
 * The most alert policies one org may configure — the server-side bound behind the Policies list's
 * `bounded` decision (`apps/console/list-standard/alert-policies.json`), enforced when a policy is
 * created (`createPolicy`). Like {@link ALERT_CHANNELS_MAX}, the read never cuts at it.
 */
export const ALERT_POLICIES_MAX = 100;

/** Rows + the facet options behind the Policies filter bar. Unpaged: see {@link ALERT_POLICIES_MAX}. */
export interface AlertPoliciesPage {
	rows: PolicyDTO[];
	/** The org has no policy at all (the first-run empty state), whatever the filters. Never a count. */
	universeEmpty: boolean;
	facets: {
		/** Both statuses, always. */
		status: FacetOption[];
		/** Both kinds, always. */
		kinds: FacetOption[];
		/** EVERY configured channel, even at zero — a destination must be selectable
		 * before any policy routes to it. */
		channels: FacetOption[];
	};
}

/**
 * The org's alert policies for `query` — rows filtered in SQL, plus facet counts over the
 * org's UNFILTERED policies (the facet passes get the org predicate and nothing else).
 */
export async function queryAlertPoliciesPage(
	orgId: string,
	query: AlertPoliciesQuery = {},
): Promise<AlertPoliciesPage> {
	const db = getServiceDb();
	const search = searchTerm(query.search);
	const like = search ? likeTerm(search) : undefined;
	const statuses = narrowTo(POLICY_STATUSES, query.status);
	const kinds = narrowTo(POLICY_KINDS, query.kinds);
	const channelIds = nonEmpty(query.channels);

	const wantsEnabled = statuses?.includes("enabled") ?? false;
	const wantsOff = statuses?.includes("off") ?? false;
	const wantsSecurity = kinds?.includes("security") ?? false;
	const wantsOperational = kinds?.includes("operational") ?? false;

	const filterConditions = [
		statuses && wantsEnabled !== wantsOff
			? eq(alertRules.enabled, wantsEnabled)
			: undefined,
		kinds && wantsSecurity !== wantsOperational
			? wantsSecurity
				? IS_SECURITY_POLICY
				: sql`not ${IS_SECURITY_POLICY}`
			: undefined,
		channelIds
			? exists(
					db
						.select({ one: sql`1` })
						.from(alertRuleChannels)
						.where(
							and(
								eq(alertRuleChannels.rule_id, alertRules.id),
								inArray(alertRuleChannels.channel_id, channelIds),
							),
						),
				)
			: undefined,
		like
			? or(ilike(alertRules.name, like), ilike(alertRules.description, like))
			: undefined,
	].filter((c) => c !== undefined);

	const [ruleRows, bindingRows, facetRules, facetBindings, facetChannels] =
		await Promise.all([
			// ROWS: org scope + the query's predicates.
			db
				.select({ rule: alertRules, isSecurity: IS_SECURITY_POLICY })
				.from(alertRules)
				.where(and(eq(alertRules.org_id, orgId), ...filterConditions))
				.orderBy(desc(alertRules.created_at)),
			// The bindings of every rule in the org (a policy renders its own channels).
			db
				.select()
				.from(alertRuleChannels)
				.innerJoin(alertRules, eq(alertRules.id, alertRuleChannels.rule_id))
				.where(eq(alertRules.org_id, orgId)),
			// FACETS: the org predicate ONLY, on all three passes. Never the filters.
			db
				.select({ enabled: alertRules.enabled, isSecurity: IS_SECURITY_POLICY })
				.from(alertRules)
				.where(eq(alertRules.org_id, orgId)),
			db
				.select({ channelId: alertRuleChannels.channel_id })
				.from(alertRuleChannels)
				.innerJoin(alertRules, eq(alertRules.id, alertRuleChannels.rule_id))
				.where(eq(alertRules.org_id, orgId)),
			db
				.select({ id: alertChannels.id, name: alertChannels.name })
				.from(alertChannels)
				.where(eq(alertChannels.org_id, orgId))
				.orderBy(desc(alertChannels.created_at)),
		]);

	const channelsByRule = new Map<
		string,
		{ id: string; minSeverity: AlertSeverity | null }[]
	>();
	for (const b of bindingRows) {
		const row = b.alert_rule_channels;
		const list = channelsByRule.get(row.rule_id) ?? [];
		list.push({ id: row.channel_id, minSeverity: row.min_severity });
		channelsByRule.set(row.rule_id, list);
	}

	const statusCounts = tally(facetRules, (r) => (r.enabled ? "enabled" : "off"));
	const kindCounts = tally(facetRules, (r) =>
		r.isSecurity ? "security" : "operational",
	);
	const routed = tally(facetBindings, (b) => b.channelId);

	return {
		rows: ruleRows.map((r) =>
			toPolicyDTO(r.rule, channelsByRule.get(r.rule.id) ?? [], r.isSecurity),
		),
		universeEmpty: facetRules.length === 0,
		facets: {
			status: orderedOptions(statusCounts, POLICY_STATUSES),
			kinds: orderedOptions(kindCounts, POLICY_KINDS),
			channels: facetChannels.map((c) => ({
				value: c.id,
				label: c.name,
				count: routed.get(c.id) ?? 0,
			})),
		},
	};
}

// ── Activity (the delivery ledger) ─────────────────────────────────────────────

/** Delivery statuses in the order the ledger's chip row presents them. */
const DELIVERY_STATUS_ORDER: AlertDeliveryStatus[] = [
	"sent",
	"pending",
	"failed",
	"dead",
];

/** The Activity panel's normalized query (the `normalizeActivityQuery()` output). */
export interface AlertDeliveriesQuery {
	/** Contains-match over the rendered title and the event key. */
	search?: string;
	/** Restrict to these delivery statuses; empty/unknown = all. */
	status?: string[];
}

/** The facet options behind the Activity filter bar. */
export interface AlertDeliveriesFacets {
	/** All four statuses, always, counted over the WHOLE ledger. */
	status: FacetOption[];
}

/** One keyset page of the delivery ledger (lib/query/README.md → "Paging"). */
export type AlertDeliveriesPage = KeysetListPage<DeliveryDTO, AlertDeliveriesFacets>;

/**
 * One keyset page of the org's delivery ledger for `query` (epic #7481, LST-7 #7489).
 *
 * The ledger is append-only, so it is paged, never windowed: it used to return the newest 50 (at
 * most 200) and leave every older delivery unreachable, with a "showing the newest N of M" line in
 * place of a way to reach them. Now the rows pass is filtered in SQL, ordered by
 * `(created_at truncated to ms, id)` descending — a TOTAL order, so two deliveries in one
 * millisecond can neither be skipped nor repeated at a page boundary — and cut after the request's
 * cursor. Any row in the ledger is reachable by walking the pages.
 *
 * The status facet is a single grouped aggregate over the org's UNFILTERED ledger, issued on the
 * first page only (a later page walks the same universe), and it also answers `universeEmpty`.
 * There is no result count: totals exist only as facet option counts (README → "Counts").
 */
export async function queryAlertDeliveriesPage(
	orgId: string,
	query: AlertDeliveriesQuery = {},
	page: KeysetPageRequest = { limit: KEYSET_DEFAULT_LIMIT },
): Promise<AlertDeliveriesPage> {
	const db = getServiceDb();
	const search = searchTerm(query.search);
	const like = search ? likeTerm(search) : undefined;
	const statuses = narrowTo(alertDeliveryStatus.enumValues, query.status);
	const sortKey = keysetSortKey(alertDeliveries.created_at);
	const scope = eq(alertDeliveries.org_id, orgId);

	const filterConditions = [
		statuses ? inArray(alertDeliveries.status, statuses) : undefined,
		like
			? or(
					ilike(alertDeliveries.event_key, like),
					ilike(sql`${alertDeliveries.context} ->> 'title'`, like),
				)
			: undefined,
	].filter((c) => c !== undefined);

	const [fetched, facetRows] = await Promise.all([
		// ROWS: org scope + the query's predicates + the cursor, in the total order, one extra row
		// read so the end of the ledger is known exactly.
		db
			.select()
			.from(alertDeliveries)
			.where(
				and(
					scope,
					...filterConditions,
					keysetAfter(sortKey, alertDeliveries.id, page.cursor),
				),
			)
			.orderBy(...keysetOrderBy(sortKey, alertDeliveries.id))
			.limit(keysetFetchLimit(page.limit)),
		// FACETS: the org predicate ONLY, aggregated in the database — first page only.
		page.cursor === undefined
			? db
					.select({ status: alertDeliveries.status, n: count() })
					.from(alertDeliveries)
					.where(scope)
					.groupBy(alertDeliveries.status)
			: null,
	]);

	const cut = keysetPage(fetched, page.limit, (r) => ({ at: r.created_at, id: r.id }));
	return keysetListPage(
		{ rows: cut.rows.map(toDeliveryDTO), nextCursor: cut.nextCursor },
		facetRows === null
			? null
			: {
					facets: {
						status: orderedOptions(
							new Map(facetRows.map((r) => [r.status, r.n])),
							DELIVERY_STATUS_ORDER,
						),
					},
					universeEmpty: facetRows.every((r) => r.n === 0),
				},
	);
}
