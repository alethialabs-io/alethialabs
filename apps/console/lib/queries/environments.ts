// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The Environments list's server half — the console filter standard's steps 5 + 6
// (lib/query/README.md → "Server-side filters").
//
// ── WHY THIS RESOLVES IN MEMORY ─────────────────────────────────────────────────────────────
//
// The list is not read here. `readEnvironmentsPage()` (lib/rpc/procedures/environments.ts) gets a
// project's environments from the canonical environments read (`selectProjectEnvironments`, #7877),
// which is memoised PER REQUEST and shared with the switcher's seed and the overview — so this
// builder narrows a list already in memory rather than putting a `WHERE` on a second select. A
// filtered link's page and the pristine page in one render therefore cost one base read, not two.
//
// ── PAGED IN MEMORY, ON THE SERVER ──────────────────────────────────────────────────────────
//
// The list standard's keyset contract (lib/query/README.md → "Paging"; LST-3 #7485). A SQL keyset
// is impossible over a list that is already in memory, so it is paged here through
// `keysetPageInMemory`: the same order (creation instant truncated to ms, then id, both
// descending) and the same strictly-after cursor as a SQL builder, one page to the browser at a
// time. Not a `bounded` decision: nothing in the product caps how many environments a project
// holds, so there is no server-side bound to name.
//
// The rest of the Environments page — the failure notices, the consistency matrix, the promote
// dialog — needs EVERY environment whatever the bar selects, and keeps reading them whole through
// `environments.overview`. Only the TABLE's rows are paged, from this builder; the page joins each
// row to the overview's record of that environment.
//
// The invariant is the standard's: the SCOPE is the project (the route's, already applied by the
// read), a FILTER (search, stage, status) is applied to the rows pass only, and
// `environmentFacets()` is handed every environment and never the query.
// `tests/lib/queries/environments-page.test.ts` asserts the option set does not shrink as the
// query narrows.

import { type FacetOption, asOptions, orderedOptions, tally } from "@/lib/queries/facets";
import {
	KEYSET_DEFAULT_LIMIT,
	type KeysetListPage,
	type KeysetPageRequest,
	keysetPageInMemory,
} from "@/lib/queries/keyset";

/** The environments list's normalized query (the `normalizeEnvironmentsQuery()` output). */
export interface EnvironmentsQuery {
	/** Contains-match over the environment name. */
	search?: string;
	/** Stages: `development`, `staging`, `production`. */
	stages?: string[];
	/** Lifecycle statuses (`project_environments.status`). */
	statuses?: string[];
}

/** The environment fields every predicate and facet below reads — and one row of a page. */
export interface EnvironmentFacts {
	id: string;
	name: string;
	stage: string;
	status: string;
	/** When the environment was created (ISO) — the list's sort key. */
	created_at: string;
}

/** The stages, in the order a change is promoted through them. */
export const ENVIRONMENT_STAGES = ["development", "staging", "production"] as const;

/** The facet options behind the bar: counts over EVERY environment of the project. */
export interface EnvironmentFacetSet {
	stages: FacetOption[];
	statuses: FacetOption[];
}

/** One keyset page of the environments list (lib/queries/keyset.ts → `KeysetListPage`). */
export type EnvironmentsPage = KeysetListPage<EnvironmentFacts, EnvironmentFacetSet>;

/** The selection as a set, or null when nothing is selected (= no filter). */
function selection(values: string[] | undefined): Set<string> | null {
	return values && values.length > 0 ? new Set(values) : null;
}

/** Does an environment pass `query`? */
export function matchesEnvironmentsQuery(env: EnvironmentFacts, query: EnvironmentsQuery): boolean {
	const stages = selection(query.stages);
	if (stages && !stages.has(env.stage)) return false;

	const statuses = selection(query.statuses);
	if (statuses && !statuses.has(env.status)) return false;

	if (query.search && !env.name.toLowerCase().includes(query.search.toLowerCase())) return false;
	return true;
}

/**
 * Facet counts over EVERY environment handed in. Separate from `matchesEnvironmentsQuery` on
 * purpose: its caller hands it the whole list, so the facet pass cannot see the query.
 */
export function environmentFacets(all: readonly EnvironmentFacts[]): EnvironmentFacetSet {
	const rows = [...all];
	return {
		// The three stages are a fixed row: a stage with no environment is a fact worth showing.
		stages: orderedOptions(tally(rows, (env) => env.stage), ENVIRONMENT_STAGES),
		statuses: asOptions(tally(rows, (env) => env.status)),
	};
}

/**
 * One keyset page of `query` over a project's environments: the matching ones, newest first,
 * strictly after `request.cursor`; and, on the FIRST page only, the facet counts over every one and
 * whether the project has any environment at all (`universeEmpty` — never a count).
 *
 * @param all every environment of the project (the route's scope, already applied by the read)
 * @param query the normalized filter query; `{}` is the pristine view
 * @param request the decoded cursor (absent on page one) and the page size
 */
export function queryEnvironmentsPage(
	all: readonly EnvironmentFacts[],
	query: EnvironmentsQuery = {},
	request: KeysetPageRequest = { limit: KEYSET_DEFAULT_LIMIT },
): EnvironmentsPage {
	const matched = all.filter((env) => matchesEnvironmentsQuery(env, query));
	const page = keysetPageInMemory(matched, request, (env) => ({ at: env.created_at, id: env.id }));
	const first = request.cursor === undefined;
	return {
		rows: page.rows,
		nextCursor: page.nextCursor,
		// The facet pass is handed every environment, never `matched`: it cannot see the filter.
		facets: first ? environmentFacets(all) : null,
		universeEmpty: first ? all.length === 0 : null,
	};
}
