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
// A runner row is not one table's row. `readRunnersPage()` (lib/rpc/procedures/runners.ts)
// composes the org's own runners
// (the RLS path, `withActorScope`) with the platform's managed fleet runners (the service
// path, and `[]` on the hosted SaaS so a tenant never sees our fleet) — two reads under two
// different authorization models, which is exactly why they are two reads. Pushing the
// predicates into SQL means writing that union as one statement, and the cost of getting a
// tenant-isolation boundary subtly wrong there is not worth a `WHERE` clause over a list
// that is bounded per org.
//
// So the composition stays where it is and the narrowing happens here, over the composed
// universe — the same arrangement `queryProjects` (the org overview) already has. What must NOT
// differ is the invariant: `runnerFacets()` below sees every row, always, and never the
// filtered ones. `tests/lib/queries/runners-page.test.ts` is the assertion, and it is the one
// that fits this mechanism — the facet set must not shrink as the query narrows.
//
// ── PAGING: A COMPOSED UNIVERSE, PAGED ON THE SERVER (#7484) ─────────────────────────────────
//
// The list standard's paging contract (lib/query/README.md → "Paging") names runners as one of
// the composed universes that page IN MEMORY on the server, through the same keyset contract as
// the SQL builders: `queryRunnersPage` filters the composed universe, cuts one page with
// `keysetPageInMemory` (newest first by `created_at` truncated to the millisecond, the id
// breaking ties) and hands back `{ rows, nextCursor, facets, universeEmpty }`. The browser gets
// one page at a time; the fleet never leaves the server whole. Before this the grid received
// every runner and offset-paged it 9 at a time with `.slice` under `?page=`.
//
// Its signature is not `(tx, scope, query, page)` because there is no single transaction: the
// universe is two reads under two authorization models (above), so the caller composes it and
// hands it in, with the sort key — `created_at` is read on the server for the order only and is
// not part of the view the browser receives.

import type { FacetOption } from "@/lib/queries/facets";
import {
	type KeysetKey,
	type KeysetListPage,
	type KeysetPageRequest,
	keysetPageInMemory,
} from "@/lib/queries/keyset";

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
 * The facet options behind the runners toolbar, counted over the UNFILTERED universe so an option
 * never disappears the moment it is selected. Only the three open-ended dimensions are counted:
 * status and operator are fixed chip rows with no count to show.
 */
export interface RunnersFacets {
	clouds: FacetOption[];
	regions: FacetOption[];
	versions: FacetOption[];
}

/**
 * One page of the runners grid — the list standard's {@link KeysetListPage}: no result count and
 * no total (lib/query/README.md → "Counts"); `universeEmpty` is what tells "no runners yet" apart
 * from "none match these filters".
 *
 * Generic over the row so this module owns the PREDICATE, the FACETS and the PAGING and nothing
 * about the payload: the `runners.page` read hands it whole `RunnerView`s (release info,
 * provisioned hours, the job in flight — everything a card renders) and gets the same objects back.
 */
export type RunnersListPage<Row extends RunnerFacts = RunnerFacts> = KeysetListPage<Row, RunnersFacets>;

/**
 * The runner fields every predicate and facet below reads.
 *
 * Spelled out rather than `Pick`ed off `RunnerView`, which is declared in
 * `lib/rpc/procedures/runners.ts` — a module that imports THIS one. The id is the keyset
 * tiebreaker; the other eight fields are the whole of what filtering a runner depends on.
 */
export interface RunnerFacts {
	id: string;
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
export function runnerFacets(all: readonly RunnerFacts[]): RunnersFacets {
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
 * One keyset page of the composed runner universe: the rows matching `query` after the request's
 * cursor, the cursor for the page after them, and — on the first page only — the facet counts over
 * EVERY row and whether there are any runners at all.
 *
 * THE TWO PASSES ARE HERE, not in the read, and that is what makes them testable. The rows pass
 * sees `query` (and the cursor); the facet pass is handed `all` and cannot see either — the same
 * division the SQL builders get from issuing two queries. `readRunnersPage()` composes the universe
 * and delegates; an assertion about this function is therefore an assertion about what that read
 * returns, which is the only arrangement in which the test is not re-deriving its own answer.
 *
 * THE DEFAULT RUNNER IS PINNED, outside the walk. The org's default is the runner a job runs on
 * when nothing else is chosen, and the grid has always shown it first. A keyset walk is one total
 * order on (sort key, id), and "default first" is not that order, so the default is taken OUT of
 * the walked universe — always, whether or not it matches — and put at the top of page one only
 * when it matches the query. It can therefore never appear twice: no later page can reach it,
 * and page one draws it at most once. Page one carries it IN ADDITION to `limit` walked rows; the
 * cursor is always the last WALKED row's, so the pin never shifts a page boundary.
 *
 * @param all every runner this actor can see, already composed (any order: the page imposes its own)
 * @param query the normalized filter query; `{}` is the pristine view
 * @param request the decoded cursor (absent on page one) and the page size
 * @param keyOf a row's keyset position: its `created_at` and its id
 * @param isPinned true for the org's default runner (at most one row); omit to pin nothing
 */
export function queryRunnersPage<Row extends RunnerFacts>(
	all: readonly Row[],
	query: RunnersQuery,
	request: KeysetPageRequest,
	keyOf: (row: Row) => KeysetKey,
	isPinned: (row: Row) => boolean = () => false,
): RunnersListPage<Row> {
	const pinned = all.find(isPinned);
	const walked = all.filter((r) => r !== pinned && matchesRunnersQuery(r, query));
	const page = keysetPageInMemory(walked, request, keyOf, "uuid");
	const first = request.cursor === undefined;
	const pin = first && pinned !== undefined && matchesRunnersQuery(pinned, query) ? [pinned] : [];
	return {
		rows: [...pin, ...page.rows],
		nextCursor: page.nextCursor,
		facets: first ? runnerFacets(all) : null,
		universeEmpty: first ? all.length === 0 : null,
	};
}
