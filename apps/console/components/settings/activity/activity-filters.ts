// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Pure filter plumbing for Settings · Activity — the console filter standard's "normalize"
// step (lib/query/README.md → "Server-side filters"). No React and no server imports, so it
// is unit-testable on its own and safe to import from both the store and the component.
//
// Every field is a string or string[] because `useFilterUrlSync`'s codec only represents
// those: the time window therefore travels as two ISO strings rather than a `DateRange`, and
// an empty pair means "the default preset window", resolved once at mount.

import type { ActivityQuery } from "@/app/server/actions/activity";
import { normalizeActivityQuery } from "@/lib/query/activity-query";
import { filterStateFromUrl, type ParamReader } from "@/lib/query/filter-url-codec";
import type { DateRange } from "@repo/ui/range";

/**
 * The Activity feed's filter state. A type alias (not an interface) so it satisfies the
 * store / url-sync `Record` constraints through the implicit index signature.
 */
export type ActivityFilters = {
	search: string;
	actorIds: string[];
	projectIds: string[];
	eventTokens: string[];
	/** ISO window bounds. Both empty = the default preset, resolved against the clock. */
	from: string;
	to: string;
	/** The label the range picker shows. Carried so a shared link reproduces the trigger
	 *  text ("Last 30 days"), which cannot be recovered from `from`/`to` alone. */
	rangeLabel: string;
};

/** Pristine filters — the store's defaults and the Reset target. */
export const DEFAULT_ACTIVITY_FILTERS: ActivityFilters = {
	search: "",
	actorIds: [],
	projectIds: [],
	eventTokens: [],
	from: "",
	to: "",
	rangeLabel: "",
};

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
 * The stored window as a concrete `DateRange`, falling back to the caller's default when the
 * filters are pristine. `fallback` must be a stable value (resolved once at mount) — resolving
 * a preset per render would produce a new `to` every time and a query key that never settles.
 */
export function activityRange(
	filters: ActivityFilters,
	fallback: DateRange,
): DateRange {
	return explicitRange(filters) ?? fallback;
}

/** The window the viewer picked (both bounds present and valid), or null for the default one. */
function explicitRange(filters: ActivityFilters): DateRange | null {
	if (!filters.from || !filters.to) return null;
	const from = new Date(filters.from);
	const to = new Date(filters.to);
	return Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) ? null : { from, to };
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
	// refetch the very same rows and a new entry would never appear. Only a range the viewer PICKED
	// carries its `to`. The key stays stable either way: the default `from` is resolved once.
	const picked = explicitRange(filters) !== null;
	return normalizeActivityQuery({
		projectId: pinnedProjectId,
		from: range.from.toISOString(),
		to: picked ? range.to.toISOString() : undefined,
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
	const filters = filterStateFromUrl(params, DEFAULT_ACTIVITY_FILTERS);
	const range = activityRange(filters, {
		from: new Date(defaultWindow.from),
		to: new Date(defaultWindow.to),
	});
	return activityQueryFrom({ filters, range, search: filters.search, pinnedProjectId });
}
