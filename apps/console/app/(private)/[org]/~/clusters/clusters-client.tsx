"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The clusters list — the console filter standard: a filter store mirrored into the URL,
// server-side filtering and facet counts (`clusters.page`), the normalized query as the TanStack
// key, and the previous rows kept and dimmed while the next answer loads. One row per cluster under
// management (lib/queries/usage-counts.ts — the definition the Usage page counts), pending and
// failed ones included, each shown as such. A row opens its record in a drawer, and the open row is
// in the URL (`?selected=`), so a link to one cluster is a link.

import { Button } from "@repo/ui/button";
import { EmptyState } from "@repo/ui/empty";
import { PageToolbar } from "@repo/ui/page-toolbar";
import { cn } from "@repo/ui/utils";
import { SearchX, Server } from "lucide-react";
import Link from "next/link";
import { useParams, usePathname, useRouter, useSearchParams } from "next/navigation";
import { useMemo } from "react";
import {
	buildClusterColumns,
	ClusterOpenContext,
	type ClusterRow,
	clusterRows,
} from "@/components/clusters/cluster-columns";
import { ClusterDetailSheet } from "@/components/clusters/cluster-detail";
import { ClustersFilterBar } from "@/components/clusters/clusters-filter-bar";
import { DEFAULT_CLUSTER_FILTERS, normalizeClustersQuery } from "@/components/clusters/clusters-query";
import { CLUSTERS_REGION, ClustersSkeleton } from "@/components/clusters/clusters-skeleton";
import { DataTable } from "@/components/data-table";
import { RegionError } from "@/components/errors/region-error";
import { RegionRefusal } from "@/components/errors/region-refusal";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { useFilterUrlSync } from "@/hooks/use-filter-url-sync";
import { ARCHITECTURE, sentenceStart, PROJECT } from "@/lib/copy/vocabulary";
import { useClustersPageQuery } from "@/lib/query/use-clusters-page-query";
import {
	FILTER_DEPENDENT_PARAMS,
	hrefWithParamPatch,
	pageFromUrl,
	pagePatch,
	selectionFromUrl,
	selectionPatch,
} from "@/lib/query/view-url-params";
import { readRefusalOf } from "@/lib/rpc/refusal";
import { useClustersFilters } from "@/lib/stores/use-clusters-filters";
import { useActiveOrgSlug } from "@/lib/stores/use-workspace-store";

/** Rows per page. A page number is in the URL (`?page=`), and a filter change returns to the first. */
export const CLUSTERS_PAGE_SIZE = 20;

/**
 * The clusters list for the organization, or — given `projectId` — for one project. The project is
 * the route's SCOPE: it is in the read's input (so the facets and the count are the project's own),
 * never in the filter store or the query string, and the Project column is dropped.
 *
 * Six distinct renders, so nothing reads as something it is not (RUBRIC B3/B4): pending is the
 * skeleton, a refusal says the viewer lacks access, a failure says it failed and offers a retry, no
 * clusters in scope is the empty state with its next action, clusters the filters exclude is "no
 * match" with a way back, and clusters are the table. A refresh that fails after data arrived keeps
 * the rows under the table's own notice.
 */
export function ClustersClient({ projectId }: { projectId?: string }) {
	const orgSlug = useActiveOrgSlug();
	const params = useParams<{ project?: string }>();
	const router = useRouter();
	const pathname = usePathname();
	const searchParams = useSearchParams();

	const filters = useClustersFilters((s) => s.filters);
	const set = useClustersFilters((s) => s.set);
	const reset = useClustersFilters((s) => s.reset);
	const urlRead = useFilterUrlSync(useClustersFilters, DEFAULT_CLUSTER_FILTERS, undefined, {
		resetParams: FILTER_DEPENDENT_PARAMS,
	});
	// Only TYPING waits: a search the link carried lands in the key at once (`urlRead`).
	const debouncedSearch = useDebouncedValue(filters.search, 250, { urlRead });
	const query = useMemo(
		() => normalizeClustersQuery(filters, debouncedSearch, projectId),
		[filters, debouncedSearch, projectId],
	);
	const page = useClustersPageQuery(query);

	const rows = useMemo(() => clusterRows(page.data?.rows ?? []), [page.data]);
	const selectedId = selectionFromUrl(searchParams);
	const selected = rows.find((row) => row.id === selectedId) ?? null;

	/** Writes one view param into the URL, leaving the filters and every other param as they are. */
	const patchUrl = (patch: Record<string, string | null>) => {
		router.replace(hrefWithParamPatch(pathname, searchParams.toString(), patch), { scroll: false });
	};
	const open = (row: ClusterRow) => patchUrl(selectionPatch(row.id));
	// Built once per route: the handler a cell calls reaches it through `ClusterOpenContext`, so the
	// columns do not change with the URL and a cell keeps its identity (and its focus).
	const columns = useMemo(() => buildClusterColumns({ showProject: !projectId, orgSlug }), [projectId, orgSlug]);

	if (page.data === undefined) {
		const refusal = page.isError ? readRefusalOf(page.error) : null;
		if (refusal) {
			// An expected refusal, not a failure: retrying will not change it, so there is no button.
			return <RegionRefusal refusal={refusal} subject="clusters" className={CLUSTERS_REGION} />;
		}
		if (page.isError) {
			return (
				<RegionError
					className={CLUSTERS_REGION}
					title="Couldn't load clusters"
					description="Something went wrong fetching your clusters. Check your connection and try again."
					onRetry={() => void page.refetch()}
				/>
			);
		}
		return <ClustersSkeleton showProject={!projectId} />;
	}

	const { total, facets } = page.data;
	if (total === 0) {
		// Nothing in scope at all — onboarding, never "no match". Each scope names its own next step:
		// a project's clusters come from deploying it, so its action stays IN the project.
		const architecture = params.project ? `/${orgSlug}/${params.project}/architecture` : null;
		return (
			<EmptyState
				className={CLUSTERS_REGION}
				icon={<Server />}
				title={projectId ? `This ${PROJECT.one} has no clusters yet` : "No clusters under management"}
				description={
					projectId
						? `A cluster appears here once an environment's first deploy succeeds. Design the ${PROJECT.one} and deploy it from ${ARCHITECTURE}.`
						: `A cluster appears here once an environment's first deploy succeeds, and stays until it is destroyed. Create a ${PROJECT.one} to deploy one.`
				}
				action={
					projectId && architecture ? (
						<Button variant="outline" size="sm" nativeButton={false} render={<Link href={architecture} />}>
							Open {ARCHITECTURE}
						</Button>
					) : (
						<Button variant="outline" size="sm" nativeButton={false} render={<Link href={`/${orgSlug}/~/new`} />}>
							{sentenceStart(`create a ${PROJECT.one}`)}
						</Button>
					)
				}
			/>
		);
	}

	// BUSY while what the table shows may not answer the URL and the bar: before the link has been
	// read into the store, while the rows are the previous query's, and while a typed search is still
	// inside its debounce.
	const busy = !urlRead || page.isPlaceholderData || filters.search !== debouncedSearch;

	return (
		<div className="space-y-6" aria-busy={busy}>
			<PageToolbar
				count={rows.length}
				description={
					projectId
						? "The cluster each of this project's environments runs on."
						: "Every cluster this organization's environments run on."
				}
			/>
			<ClustersFilterBar filters={filters} onFilter={set} onReset={reset} facets={facets} />
			{rows.length === 0 ? (
				<EmptyState
					className="min-h-[40vh]"
					icon={<SearchX />}
					title="No clusters match these filters"
					description="Every cluster is excluded by the current search, cloud, status or region selection."
					action={
						<Button variant="outline" size="sm" onClick={reset}>
							Clear filters
						</Button>
					}
				/>
			) : (
				<div className={cn("transition-opacity", page.isPlaceholderData && "opacity-60")}>
					<ClusterOpenContext.Provider value={open}>
						<DataTable
							columns={columns}
							data={rows}
							query={page}
							onRowClick={open}
							selectedRowId={selected?.id}
							pageSize={CLUSTERS_PAGE_SIZE}
							pageIndex={pageFromUrl(searchParams) - 1}
							onPageIndexChange={(index) => patchUrl(pagePatch(index + 1))}
						/>
					</ClusterOpenContext.Provider>
				</div>
			)}
			<ClusterDetailSheet
				cluster={selected?.cluster ?? null}
				posture={selected?.posture ?? null}
				orgSlug={orgSlug}
				onClose={() => patchUrl(selectionPatch(null))}
			/>
		</div>
	);
}
