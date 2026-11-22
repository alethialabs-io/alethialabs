// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The Clusters list's server half — the console filter standard's steps 5 + 6
// (lib/query/README.md → "Server-side filters"). Both clusters routes read through it: the org
// route with no scope, a project's route with its project as the scope.
//
// ── WHY THIS RESOLVES IN MEMORY ─────────────────────────────────────────────────────────────
//
// A cluster row is not one table's row. `readClusterList()` (lib/rpc/procedures/clusters.ts)
// composes the RLS read of the clusters under management with the PDP's project visibility, the
// service-role drift and probe evidence, a kubeconfig read per cluster and a batched permission
// check — and the STATUS a row is filtered under is derived from all of it
// (components/clusters/cluster-posture.ts), not stored. So the composition stays where it is and
// the narrowing happens here, over the composed universe: the arrangement the runners list has
// (lib/queries/runners.ts) and for the same reason.
//
// What must not differ is the invariant. The SCOPE (a project) is a predicate on BOTH passes; a
// FILTER (search, cloud, status, region) is applied to the rows pass only, and `clusterFacets()` is
// handed the scoped universe and never the query. `tests/lib/queries/clusters-page.test.ts`
// asserts both halves: the option set does not shrink as the query narrows, and it does shrink to
// the project's rows when the scope narrows.

import {
	type ClusterStatusKey,
	CLUSTER_STATUS_KEYS,
	type PostureFacts,
	clusterPosture,
	clusterStatusKey,
} from "@/components/clusters/cluster-posture";
import { type FacetOption, asOptions, orderedOptions, tally } from "@/lib/queries/facets";

/** The clusters list's normalized query (the `normalizeClustersQuery()` output). */
export interface ClustersQuery {
	/** Contains-match over the environment, project and cluster names. */
	search?: string;
	/** Cloud provider slugs. */
	clouds?: string[];
	/** Filter statuses — see `ClusterStatusKey`. */
	statuses?: string[];
	/** Cluster regions. */
	regions?: string[];
}

/** What a list is scoped to by its ROUTE — never by the filter bar. */
export interface ClustersScope {
	/** The project whose clusters the page lists; absent on the org route. */
	projectId?: string;
}

/**
 * The cluster fields every predicate and facet below reads.
 *
 * Spelled out rather than `Pick`ed off `ClusterListItem`, which is declared in
 * `lib/rpc/procedures/clusters.ts` — a module that imports THIS one.
 */
export interface ClusterFacts extends PostureFacts {
	/** The PROJECT's id. */
	id: string;
	project_name: string;
	/** The owning environment's name. */
	environment_stage: string;
	region: string;
	cloud_identities: { provider: string } | null;
	project_cluster: PostureFacts["project_cluster"] & { cluster_name: string | null };
}

/** Rows + the facet options behind the clusters filter bar. */
export interface ClustersPage<Row extends ClusterFacts = ClusterFacts> {
	/** Clusters matching the query, in the universe's order. */
	rows: Row[];
	resultCount: number;
	/** Every cluster in scope that this actor can see — the "no clusters yet" test, not "none match". */
	total: number;
	/** Counts over the scoped, UNFILTERED universe, so an option never disappears once selected. */
	facets: {
		clouds: FacetOption[];
		statuses: FacetOption[];
		regions: FacetOption[];
	};
}

/** The cloud-facet value of a cluster whose cloud account is not known. */
export const UNKNOWN_CLOUD = "unknown";

/** The cloud-facet value a cluster falls under. */
function cloudKey(row: ClusterFacts): string {
	return row.cloud_identities?.provider ?? UNKNOWN_CLOUD;
}

/** The status-facet value a cluster falls under. */
function statusKey(row: ClusterFacts): ClusterStatusKey {
	return clusterStatusKey(clusterPosture(row));
}

/** The selection as a set, or null when nothing is selected (= no filter). */
function selection(values: string[] | undefined): Set<string> | null {
	return values && values.length > 0 ? new Set(values) : null;
}

/** Whether a cluster is inside `scope`. */
function inScope(row: ClusterFacts, scope: ClustersScope): boolean {
	return scope.projectId === undefined || row.id === scope.projectId;
}

/** Does a cluster pass `query`? Every value the bar can send is a key one of the helpers above produces. */
export function matchesClustersQuery(row: ClusterFacts, query: ClustersQuery): boolean {
	const clouds = selection(query.clouds);
	if (clouds && !clouds.has(cloudKey(row))) return false;

	const statuses = selection(query.statuses);
	if (statuses && !statuses.has(statusKey(row))) return false;

	const regions = selection(query.regions);
	if (regions && !regions.has(row.region)) return false;

	if (query.search) {
		const needle = query.search.toLowerCase();
		const haystack = [row.environment_stage, row.project_name, row.project_cluster.cluster_name ?? ""];
		if (!haystack.some((text) => text.toLowerCase().includes(needle))) return false;
	}
	return true;
}

/**
 * Facet counts over the WHOLE universe handed in. Separate from `matchesClustersQuery` on purpose,
 * and its caller hands it the scoped, unfiltered rows: "the facet pass never saw the filter" is
 * then a property of the signature, not a promise in a comment.
 */
export function clusterFacets(all: readonly ClusterFacts[]): ClustersPage["facets"] {
	const rows = [...all];
	return {
		clouds: asOptions(tally(rows, cloudKey)),
		// A fixed row of four: a status at zero is a fact worth showing, and the chips keep their place.
		statuses: orderedOptions(tally(rows, statusKey), CLUSTER_STATUS_KEYS),
		regions: asOptions(tally(rows, (row) => row.region)),
	};
}

/**
 * Resolve `query` against the composed cluster universe: the rows in scope that match, the result
 * count, the size of the scope, and the facet counts over every row in scope.
 *
 * @param all every cluster this actor can see, already composed and ordered
 * @param query the normalized filter query; `{}` is the pristine view
 * @param scope what the ROUTE narrows the list to; `{}` is the organization
 */
export function clustersPage<Row extends ClusterFacts>(
	all: readonly Row[],
	query: ClustersQuery = {},
	scope: ClustersScope = {},
): ClustersPage<Row> {
	const scoped = all.filter((row) => inScope(row, scope));
	const rows = scoped.filter((row) => matchesClustersQuery(row, query));
	return {
		rows,
		resultCount: rows.length,
		total: scoped.length,
		facets: clusterFacets(scoped),
	};
}
