// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Pure filter plumbing for Settings · Activity — the console filter standard's "normalize"
// step (lib/query/README.md → "Server-side filters"). No React and no server imports, so it
// is unit-testable on its own and safe to import from both the store and the component.
//
// Every field is a string or string[] because `useFilterUrlSync`'s codec only represents
// those. The time window is ONE `range` value (`lib/query/range-filter.ts`, #6740): "" is the
// default preset window (resolved once, by the route), a preset id stays relative and is resolved
// by the read, and "<from>/<to>" is an explicit window. It used to be `from` + `to` + `rangeLabel`:
// one choice counted 3 on Reset, and a preset was frozen into absolute bounds under its relative
// name.
//
// OLD LINKS STILL OPEN THEIR WINDOW. This is the audit log, and a link carrying `from`/`to` is
// usually evidence someone shared: "this is what happened between these two instants". Dropping it
// to the default window would silently show different rows under the same link. So when a link has
// no `range` but has a valid `from` AND `to`, `activityFiltersFromUrl` opens exactly that window,
// as an explicit window. It is labelled "Custom range" even if the old link's `rangeLabel` said
// "Last 30 days": those bounds were frozen when the link was made, so reading them as "the last 30
// days from now" would be the old defect again. The retired params are then removed from the URL.

import type { ActivityQuery } from "@/app/server/actions/activity";
import { normalizeActivityQuery } from "@/lib/query/activity-query";
import { filterStateFromUrl, type ParamReader } from "@/lib/query/filter-url-codec";
import { parseRangeFilter, rangeWindowValue, windowFilter } from "@/lib/query/range-filter";
import { type DateRange, presetRange } from "@repo/ui/range";

/**
 * The Activity feed's filter state. A type alias (not an interface) so it satisfies the
 * store / url-sync `Record` constraints through the implicit index signature.
 */
export type ActivityFilters = {
	search: string;
	actorIds: string[];
	projectIds: string[];
	eventTokens: string[];
	/** The time-window choice (`lib/query/range-filter.ts`). "" = the default preset window. */
	range: string;
};

/** Pristine filters — the store's defaults and the Reset target. */
export const DEFAULT_ACTIVITY_FILTERS: ActivityFilters = {
	search: "",
	actorIds: [],
	projectIds: [],
	eventTokens: [],
	range: "",
};

/** The params the three-key window used, which a link may still carry (see the header). */
export const RETIRED_ACTIVITY_PARAMS = ["from", "to", "rangeLabel"] as const;

/**
 * The full filter state a link describes: `filterStateFromUrl`, plus an old `from`/`to` link
 * read as the explicit window it names. The route's prefetch and the feed's first render both
 * decode through this, so they agree about the key.
 */
export function activityFiltersFromUrl(params: ParamReader): ActivityFilters {
	const filters = filterStateFromUrl(params, DEFAULT_ACTIVITY_FILTERS);
	if (params.get("range") !== null) return filters;
	const legacy = windowFilter(params.get("from") ?? "", params.get("to") ?? "");
	if (legacy === null) return filters;
	return {
		...filters,
		range: rangeWindowValue({ from: new Date(legacy.from), to: new Date(legacy.to) }),
	};
}

/** Splits the event-type tokens into the resource-type + decision filters the query takes. */
export function splitEventTokens(tokens: string[]): {
	resourceTypes: string[];
	decision: boolean | null;
} {
	const resourceTypes = tokens
		.filter((t) => t.startsWith("type:"))
		.map((t) => t.slice(5));
	const results = tokens
		.filter((t) => t.startsWith("result:"))
		.map((t) => t.slice(7));
	// One side selected → that decision; both/none → no constraint.
	const decision = results.length === 1 ? results[0] === "allow" : null;
	return { resourceTypes, decision };
}

/**
 * The window the pickers show for the current choice. `fallback` is the default window and `now`
 * the instant a preset is shown against. Both must be stable values, resolved once at mount:
 * resolving per render would move `to` every time.
 */
export function activityRange(
	filters: ActivityFilters,
	fallback: DateRange,
	now: Date = fallback.to,
): DateRange {
	const choice = parseRangeFilter(filters.range);
	if (choice.kind === "window") return { from: new Date(choice.from), to: new Date(choice.to) };
	if (choice.kind === "preset") return presetRange(choice.preset, now);
	return fallback;
}

/**
 * The stable, normalized query the current filters describe — this object IS the TanStack key,
 * so equal filters hit the cache. `pinnedProjectId` forces the project scope (`projectId`, the
 * project-scoped feed); otherwise the Project facet's selection becomes `resourceIds`, keeping
 * scoping server-side. The debounced search must be passed in, not read from `filters`.
 */
export function activityQueryFrom({
	filters,
	range,
	search,
	pinnedProjectId,
}: {
	filters: ActivityFilters;
	range: DateRange;
	/** The DEBOUNCED search text. */
	search: string;
	pinnedProjectId?: string;
}): ActivityQuery {
	const { resourceTypes, decision } = splitEventTokens(filters.eventTokens);
	// The pinned project is SCOPE (`projectId`), which the server's facet counts see; the Project
	// facet's selection is a FILTER (`resourceIds`), which they must not. Sending the pin as a
	// `resourceIds` filter would leave the server unable to tell the two apart.
	const resourceIds =
		!pinnedProjectId && filters.projectIds.length ? filters.projectIds : undefined;
	// THE DEFAULT WINDOW IS OPEN-ENDED (#6129). The default preset ("Last 7 days") means "from a
	// week ago until now", and now keeps moving: a `to` frozen at the instant the page resolved it
	// would make the server answer `ts <= that instant` forever, so a live `activity` hint would
	// refetch the very same rows and a new entry would never appear. Its `from` is the route's,
	// resolved once, so the key stays stable. A PICKED preset travels as `within` and the read
	// resolves it (#6740), so it is open-ended for the same reason and its link stays relative.
	// Only an explicit window carries both bounds.
	const choice = parseRangeFilter(filters.range);
	return normalizeActivityQuery({
		projectId: pinnedProjectId,
		...(choice.kind === "preset" ? { within: choice.preset } : {}),
		...(choice.kind === "window" ? { from: choice.from, to: choice.to } : {}),
		...(choice.kind === "default" ? { from: range.from.toISOString() } : {}),
		actorIds: filters.actorIds,
		resourceTypes,
		decision,
		resourceIds,
		search,
	});
}

/**
 * A default window as it travels from the route to the feed: two ISO instants. Only `from` reaches
 * the query (the default window is open-ended, see `activityQueryFrom`); `to` is what the range
 * controls display.
 */
export interface ActivityWindow {
	from: string;
	to: string;
}

/**
 * The first page's query for a URL, against the default window the ROUTE resolved — the
 * `activity.page` input the feed settles on once `useFilterUrlSync` has read the link (#4999's rule,
 * #6129). The default window is resolved once, on the server, and handed to the feed, because a
 * window resolved separately in the browser lands a few milliseconds later: a different key, so the
 * prefetched page would never be read.
 */
export function activityQueryFromUrl(
	params: ParamReader,
	defaultWindow: ActivityWindow,
	pinnedProjectId?: string,
): ActivityQuery {
	const filters = activityFiltersFromUrl(params);
	const range = activityRange(filters, {
		from: new Date(defaultWindow.from),
		to: new Date(defaultWindow.to),
	});
	return activityQueryFrom({ filters, range, search: filters.search, pinnedProjectId });
}
