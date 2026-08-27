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
import { normalizeActivityQuery } from "@/lib/query/use-activity-query";
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
	if (!filters.from || !filters.to) return fallback;
	const from = new Date(filters.from);
	const to = new Date(filters.to);
	return Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())
		? fallback
		: { from, to };
}

/**
 * The stable, normalized query the current filters describe — this object IS the TanStack key,
 * so equal filters hit the cache. `pinnedProjectId` forces the project scope (the project-scoped
 * feed); otherwise the Project facet's selection becomes `resourceIds`, keeping scoping
 * server-side. The debounced search must be passed in, not read from `filters`.
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
	const resourceIds = pinnedProjectId
		? [pinnedProjectId]
		: filters.projectIds.length
			? filters.projectIds
			: undefined;
	return normalizeActivityQuery({
		from: range.from.toISOString(),
		to: range.to.toISOString(),
		actorIds: filters.actorIds,
		resourceTypes,
		decision,
		resourceIds,
		search,
	});
}
