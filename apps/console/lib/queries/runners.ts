// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The Runners grid's server half — the console filter standard's steps 5 + 6
// (lib/query/README.md → "Server-side filters"). This was the one filter surface in the
// console with NO server half at all (#4890): the page fetched the org's whole runner
// universe under `qk.runners(org)` and narrowed it in the component, so every filtered
// view shared one cache entry and `matchesRunnerFilters` lived in a filter BAR.
//
// ── WHY THIS RESOLVES IN MEMORY AND THE OTHER BUILDERS RESOLVE IN SQL ───────────────────
//
// A runner row is not one table's row. `getRunnersPage()` composes the org's own runners
// (the RLS path, `withActorScope`) with the platform's managed fleet runners (the service
// path, and `[]` on the hosted SaaS so a tenant never sees our fleet) — two reads under two
// different authorization models, which is exactly why they are two reads. Pushing the
// predicates into SQL means writing that union as one statement, and the cost of getting a
// tenant-isolation boundary subtly wrong there is not worth a `WHERE` clause over a list
// that is bounded per org.
//
// So the composition stays where it is and the narrowing happens here, over the composed
// universe — the same arrangement `queryProjects` (the org overview) already has, and it is
// declared as such in `scripts/check-filter-standard.mjs`'s `F7_UNDRIVEN`. What must NOT
// differ is the invariant: `facetsOf()` below sees every row, always, and never the
// filtered ones. `tests/lib/queries/runners-page.test.ts` is the assertion, and it is the
// one that fits this mechanism — the facet set must not shrink as the query narrows.

import type { FacetOption } from "@/lib/queries/facets";

/** The runners grid's normalized query (the `normalizeRunnersQuery()` output). */
export interface RunnersQuery {
	/** Contains-match over the runner name. */
	search?: string;
	/** Supported-provider slugs, or `any` for a runner that names none. */
	clouds?: string[];
	/** `ONLINE` / `OFFLINE` / `DRAINING`; a null status reads as OFFLINE. */
	statuses?: string[];
	/** `managed`, or the self-operated provisioning mode (`deployed` / `registered`). */
	operators?: string[];
	/** Runner locations. */
	regions?: string[];
	/** Pinned release versions, falling back to the runner's own `version`. */
	versions?: string[];
}

/**
 * Rows + the facet options behind the runners toolbar.
 *
 * Generic over the row so this module owns the PREDICATE and the FACETS and nothing about
 * the payload: the action hands it whole `RunnerWithRelease`s (release info, provisioned
 * hours, everything a card renders) and gets the same objects back.
 */
export interface RunnersPage<Row extends RunnerFacts = RunnerFacts> {
	/** Runners matching the query, in the universe's order (default first). */
	rows: Row[];
	resultCount: number;
	/** Every runner visible to this actor — the "no runners yet" test, not "none match". */
	total: number;
	/**
	 * Counts over the UNFILTERED universe, so an option never disappears the moment it is
	 * selected. Only the three open-ended dimensions are counted: status and operator are
	 * fixed chip rows with no count to show.
	 */
	facets: {
		clouds: FacetOption[];
		regions: FacetOption[];
		versions: FacetOption[];
	};
}

/**
 * The runner fields every predicate and facet below reads.
 *
 * Spelled out rather than `Pick`ed off `RunnerWithRelease`, which is declared in
 * `lib/query/resource-fetchers.ts` — a module that imports the action module that imports
 * THIS one. The eight fields are the whole of what filtering a runner depends on.
 */
export interface RunnerFacts {
	name: string;
	status: string | null;
	operator: string;
	provisioning: string | null;
	supported_providers: string[] | null;
	location: string | null;
	version: string | null;
	runner_releases: { version: string } | null;
}

/** The cloud-facet value of a runner naming no supported provider. */
export const ANY_CLOUD = "any";

/** The status a runner with no reported status reads as. */
const IMPLICIT_STATUS = "OFFLINE";

/** The cloud-facet values a runner falls under — one per supported provider, or `any`. */
function cloudKeys(r: RunnerFacts): string[] {
	const providers = r.supported_providers;
	return !providers || providers.length === 0 ? [ANY_CLOUD] : providers;
}

/** The operator-facet value a runner falls under. */
function operatorKey(r: RunnerFacts): string {
	return r.operator === "managed" ? "managed" : (r.provisioning ?? "registered");
}

/** The version a runner reports: its pinned release, else its own recorded version. */
function versionKey(r: RunnerFacts): string | null {
	return r.runner_releases?.version ?? r.version ?? null;
}

/** Sorted, deduped selection, or null when nothing is selected (= no filter). */
function selection(values: string[] | undefined): Set<string> | null {
	return values && values.length > 0 ? new Set(values) : null;
}

/**
 * Does a runner pass `query`?
 *
 * Exported so the toolbar's chip semantics and this predicate cannot drift: every value the
 * bar can send is a key produced by one of the `*Key` helpers above.
 */
export function matchesRunnersQuery(r: RunnerFacts, query: RunnersQuery): boolean {
	const statuses = selection(query.statuses);
	if (statuses && !statuses.has(r.status ?? IMPLICIT_STATUS)) return false;

	const operators = selection(query.operators);
	if (operators && !operators.has(operatorKey(r))) return false;

	const clouds = selection(query.clouds);
	if (clouds && !cloudKeys(r).some((c) => clouds.has(c))) return false;

	const regions = selection(query.regions);
	if (regions && !(r.location && regions.has(r.location))) return false;

	const versions = selection(query.versions);
	if (versions) {
		const v = versionKey(r);
		if (!v || !versions.has(v)) return false;
	}

	if (query.search && !r.name.toLowerCase().includes(query.search.toLowerCase())) {
		return false;
	}
	return true;
}

/** A tally as the sorted `FacetOption[]` the toolbar renders. Labels are the client's. */
function options(
	counts: Map<string, number>,
	compare: (a: string, b: string) => number,
): FacetOption[] {
	return [...counts.entries()]
		.sort(([a], [b]) => compare(a, b))
		.map(([value, count]) => ({ value, label: null, count }));
}

/**
 * Facet counts over the WHOLE universe handed in.
 *
 * Separate from `matchesRunnersQuery` on purpose, and its caller hands it the UNFILTERED
 * rows: this is the two-pass shape the SQL builders get from a second query, and keeping the
 * two functions apart is what makes "the facet pass never saw the filter" a property of the
 * types rather than a promise in a comment.
 */
export function runnerFacets(all: RunnerFacts[]): RunnersPage["facets"] {
	const clouds = new Map<string, number>();
	const regions = new Map<string, number>();
	const versions = new Map<string, number>();
	const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);

	for (const r of all) {
		for (const c of cloudKeys(r)) bump(clouds, c);
		if (r.location) bump(regions, r.location);
		const v = versionKey(r);
		if (v) bump(versions, v);
	}

	const ascending = (a: string, b: string) => a.localeCompare(b);
	return {
		clouds: options(clouds, ascending),
		regions: options(regions, ascending),
		// Newest first, which is the order the Version popover has always presented.
		versions: options(versions, (a, b) => b.localeCompare(a)),
	};
}

/**
 * Resolve `query` against the composed runner universe: the matching rows, the result count,
 * the universe size, and the facet counts over EVERY row.
 *
 * THE TWO PASSES ARE HERE, not in the action, and that is what makes them testable. The rows
 * pass sees `query`; the facet pass is handed `all` and cannot see it — the same division the
 * SQL builders get from issuing two queries. `getRunnersPage()` composes the universe and
 * delegates; an assertion about this function is therefore an assertion about what that action
 * returns, which is the only arrangement in which the test is not re-deriving its own answer.
 *
 * @param all every runner this actor can see, already composed and ordered
 * @param query the normalized filter query; `{}` is the pristine view
 */
export function runnersPage<Row extends RunnerFacts>(
	all: Row[],
	query: RunnersQuery = {},
): RunnersPage<Row> {
	const rows = all.filter((r) => matchesRunnersQuery(r, query));
	return {
		rows,
		resultCount: rows.length,
		total: all.length,
		facets: runnerFacets(all),
	};
}
