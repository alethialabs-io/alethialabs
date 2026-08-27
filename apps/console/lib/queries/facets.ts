// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Shared vocabulary for the console filter standard's server half
// (lib/query/README.md → "Server-side filters", step 6).
//
// THE INVARIANT these helpers exist to protect: a facet's counts are computed over the
// UNFILTERED universe, never over the rows the current query selected — otherwise an
// option vanishes the moment you pick it and the filter bar becomes un-un-selectable.
// Every `query*Page` builder below therefore issues TWO reads: a filtered ROWS pass and
// a separate, deliberately unfiltered FACET pass that only ever sees the scope
// predicates (org, and where a surface has one, its resource scope).
//
// No `import "server-only"` here: this module holds pure tallying + input-narrowing, no
// DB access, so the same code can be reused (or type-imported) from a client component.

/**
 * One selectable option in a filter facet.
 *
 * `label` is null when the CLIENT owns the labeling — enum-shaped dimensions (a delivery
 * status, a team-size bucket) already have static labels in the component layer, and
 * duplicating them here would give the same value two sources of truth. It is a string
 * when only the server knows it (a channel name, a role name, a team name).
 */
export interface FacetOption {
	value: string;
	label: string | null;
	count: number;
}

/** Tallies one keyed dimension, skipping rows the key does not apply to (null). */
export function tally<T>(
	rows: T[],
	keyOf: (row: T) => string | null | undefined,
): Map<string, number> {
	const counts = new Map<string, number>();
	for (const row of rows) {
		const key = keyOf(row);
		if (!key) continue;
		counts.set(key, (counts.get(key) ?? 0) + 1);
	}
	return counts;
}

/**
 * A tally as facet options, sorted by label (falling back to the value). Only values the
 * unfiltered universe actually contains appear — an option for something nobody has is
 * noise, not honesty.
 */
export function asOptions(
	counts: Map<string, number>,
	labelOf?: (value: string) => string | null,
): FacetOption[] {
	return [...counts.entries()]
		.map(([value, count]) => ({
			value,
			label: labelOf?.(value) ?? null,
			count,
		}))
		.sort((a, b) => (a.label ?? a.value).localeCompare(b.label ?? b.value));
}

/**
 * A tally rendered in a FIXED value order, keeping every value in `order` even at zero.
 * For dimensions whose option list is part of the surface's meaning (the three team-size
 * buckets, the four delivery statuses): a bucket at 0 is a fact worth showing.
 */
export function orderedOptions(
	counts: Map<string, number>,
	order: readonly string[],
	labelOf?: (value: string) => string | null,
): FacetOption[] {
	return order.map((value) => ({
		value,
		label: labelOf?.(value) ?? null,
		count: counts.get(value) ?? 0,
	}));
}

/**
 * Narrows untrusted client strings to known members of a finite set (the jobs-action
 * precedent). Returns undefined when nothing survives, so the caller omits the SQL
 * predicate entirely rather than emitting `in ()`.
 */
export function narrowTo<T extends string>(
	values: readonly T[],
	input?: string[],
): T[] | undefined {
	if (!input?.length) return undefined;
	const known = new Set<string>(values);
	const kept = [...new Set(input.filter((v): v is T => known.has(v)))];
	return kept.length ? kept : undefined;
}

/** A non-empty list of the input's distinct values, or undefined. */
export function nonEmpty(input?: string[]): string[] | undefined {
	if (!input?.length) return undefined;
	const kept = [...new Set(input)];
	return kept.length ? kept : undefined;
}

/** A trimmed free-text term, or undefined when it carries no signal. */
export function searchTerm(input?: string): string | undefined {
	const trimmed = input?.trim();
	return trimmed ? trimmed : undefined;
}
