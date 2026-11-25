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
//
// ── WHY IT PAGES IN MEMORY ──────────────────────────────────────────────────────────────────
//
// The list standard's keyset contract (lib/query/README.md → "Paging"; LST-3 #7485). A SQL keyset
// is impossible here for the reason above: the status a row is filtered under is derived, not a
// column, so no `WHERE` can apply the filter before the cursor. The universe is composed on the
// server and paged there through `keysetPageInMemory` — the same order (the cluster's creation
// instant truncated to ms, then its id, both descending) and the same strictly-after cursor as a
// SQL builder. The browser receives one page at a time; the universe never leaves the server.

import {
	type ClusterStatusKey,
	CLUSTER_STATUS_KEYS,
	type PostureFacts,
	clusterPosture,
	clusterStatusKey,
} from "@/components/clusters/cluster-posture";
import { type FacetOption, asOptions, orderedOptions, tally } from "@/lib/queries/facets";
// Type-only, so erased at build: the procedure module imports THIS one at runtime, never the reverse.
import type { ClusterListItem } from "@/lib/rpc/procedures/clusters";
import {
	KEYSET_DEFAULT_LIMIT,
	type KeysetListPage,
	type KeysetPageRequest,
	keysetPageInMemory,
} from "@/lib/queries/keyset";

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
	project_cluster: PostureFacts["project_cluster"] & {
		/** The cluster's own id — the row's identity and the keyset tiebreaker. */
		id: string;
		/** When the cluster row was created (ISO) — the list's sort key. */
		created_at: string;
		cluster_name: string | null;
	};
}

/** The facet options behind the clusters filter bar: counts over the scoped, UNFILTERED universe. */
export interface ClusterFacetSet {
	clouds: FacetOption[];
	statuses: FacetOption[];
	regions: FacetOption[];
}

/**
 * One row of a clusters page. The cluster is wrapped because its own `id` is its PROJECT's (the
 * project drilldown filters on it), and a project with a cluster per environment would then hand
 * the client two rows with one id — which the page join (`useKeysetList`) keeps once. The row's
 * `id` is the cluster's own (`project_cluster.id`).
 */
interface ClusterPageRow<Row extends ClusterFacts = ClusterFacts> {
	id: string;
	cluster: Row;
}

/** One keyset page of the clusters list (lib/queries/keyset.ts → `KeysetListPage`). */
export type ClustersPage<Row extends ClusterFacts = ClusterFacts> = KeysetListPage<ClusterPageRow<Row>, ClusterFacetSet>;

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
export function clusterFacets(all: readonly ClusterFacts[]): ClusterFacetSet {
	const rows = [...all];
	return {
		clouds: asOptions(tally(rows, cloudKey)),
		// A fixed row of four: a status at zero is a fact worth showing, and the chips keep their place.
		statuses: orderedOptions(tally(rows, statusKey), CLUSTER_STATUS_KEYS),
		regions: asOptions(tally(rows, (row) => row.region)),
	};
}

/**
 * One keyset page of `query` over the composed cluster universe: the rows in scope that match,
 * newest cluster first, strictly after `request.cursor`; and, on the FIRST page only, the facet
 * counts over every row in scope and whether the scope holds any cluster at all (`universeEmpty`,
 * the first-run test — never a count). Paged in memory because the universe is composed (see the
 * header); the order and the cursor are the SQL contract's (`keysetPageInMemory`).
 *
 * @param all every cluster this actor can see, already composed
 * @param query the normalized filter query; `{}` is the pristine view
 * @param scope what the ROUTE narrows the list to; `{}` is the organization
 * @param request the decoded cursor (absent on page one) and the page size
 */
export function queryClustersPage(
	all: readonly ClusterListItem[],
	query: ClustersQuery = {},
	scope: ClustersScope = {},
	request: KeysetPageRequest = { limit: KEYSET_DEFAULT_LIMIT },
): ClustersPage<ClusterListItem> {
	const scoped = all.filter((row) => inScope(row, scope));
	const matched = scoped.filter((row) => matchesClustersQuery(row, query));
	const page = keysetPageInMemory(matched, request, (row) => ({
		at: row.project_cluster.created_at,
		id: row.project_cluster.id,
	}));
	const first = request.cursor === undefined;
	return {
		rows: page.rows.map((cluster) => ({ id: cluster.project_cluster.id, cluster })),
		nextCursor: page.nextCursor,
		// The facet pass is handed the scoped universe, never `matched`: it cannot see the filter.
		facets: first ? clusterFacets(scoped) : null,
		universeEmpty: first ? scoped.length === 0 : null,
	};
}
