// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The Environments list's server half — the console filter standard's steps 5 + 6
// (lib/query/README.md → "Server-side filters").
//
// ── WHY THIS RESOLVES IN MEMORY ─────────────────────────────────────────────────────────────
//
// The list is not read here. `readEnvironmentsOverview()` (lib/rpc/procedures/environments.ts)
// gets a project's environments from `getProjectEnvironments`, an in-process call into the projects
// unit's module, and composes each row with its BYO admission state; the same answer also feeds the
// consistency matrix, the promote dialog and the promotions history, which need EVERY environment
// whatever the bar selects. So the read stays one read and the narrowing happens here, over the
// composed list — the arrangement the runners and clusters lists have. A project's environments are
// a handful, bounded by the plan.
//
// The invariant is the standard's: the SCOPE is the project (the route's, already applied by the
// read), a FILTER (search, stage, status) is applied to the rows pass only, and
// `environmentFacets()` is handed every environment and never the query.
// `tests/lib/queries/environments-page.test.ts` asserts the option set does not shrink as the
// query narrows.

import { type FacetOption, asOptions, orderedOptions, tally } from "@/lib/queries/facets";

/** The environments list's normalized query (the `normalizeEnvironmentsQuery()` output). */
export interface EnvironmentsQuery {
	/** Contains-match over the environment name. */
	search?: string;
	/** Stages: `development`, `staging`, `production`. */
	stages?: string[];
	/** Lifecycle statuses (`project_environments.status`). */
	statuses?: string[];
}

/** The environment fields every predicate and facet below reads. */
export interface EnvironmentFacts {
	id: string;
	name: string;
	stage: string;
	status: string;
}

/** The stages, in the order a change is promoted through them. */
export const ENVIRONMENT_STAGES = ["development", "staging", "production"] as const;

/** Which environments match, and the facet options behind the bar. */
export interface EnvironmentsPage {
	/** The ids of the environments matching the query, in the list's order. */
	rowIds: string[];
	resultCount: number;
	/** Every environment of the project — the "no environments yet" test, not "none match". */
	total: number;
	/** Counts over EVERY environment of the project, so an option never disappears once selected. */
	facets: {
		stages: FacetOption[];
		statuses: FacetOption[];
	};
}

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
export function environmentFacets(all: readonly EnvironmentFacts[]): EnvironmentsPage["facets"] {
	const rows = [...all];
	return {
		// The three stages are a fixed row: a stage with no environment is a fact worth showing.
		stages: orderedOptions(tally(rows, (env) => env.stage), ENVIRONMENT_STAGES),
		statuses: asOptions(tally(rows, (env) => env.status)),
	};
}

/**
 * Resolve `query` against a project's environments: which match, how many, how many there are at
 * all, and the facet counts over every one.
 *
 * @param all every environment of the project, in the list's order
 * @param query the normalized filter query; `{}` is the pristine view
 */
export function environmentsPage(all: readonly EnvironmentFacts[], query: EnvironmentsQuery = {}): EnvironmentsPage {
	const rows = all.filter((env) => matchesEnvironmentsQuery(env, query));
	return {
		rowIds: rows.map((env) => env.id),
		resultCount: rows.length,
		total: all.length,
		facets: environmentFacets(all),
	};
}
