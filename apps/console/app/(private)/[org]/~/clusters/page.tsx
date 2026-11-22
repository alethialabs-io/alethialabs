// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { HydrationBoundary, dehydrate } from "@tanstack/react-query";
import { clustersQueryFromUrl } from "@/components/clusters/clusters-query";
import { isClustersRead } from "@/components/clusters/clusters-reads";
import { getQueryClient } from "@/lib/query/client";
import { paramReader } from "@/lib/query/filter-url-codec";
import { serverOrpc } from "@/lib/rpc/server";
import { pageMetadata } from "@/lib/seo/page-metadata";
import { ClustersClient } from "./clusters-client";

export const metadata = pageMetadata({
	title: "Clusters",
	description: "Provisioned infrastructure and access credentials.",
});

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/**
 * Clusters route (#6122, ADR 0005 D1). Prefetches EXACTLY the keys the list reads — `clusters.page`,
 * in-process through the read router, for the actor the request's address resolves — and hydrates
 * them, so the first paint is the list, not a skeleton and a second request:
 *
 * - the pristine page (`{}`), which the client renders before its filter store has read the link;
 * - the page for the link's filters, the key it settles on once it has — the same key twice for a
 *   pristine link, which TanStack dedupes.
 *
 * The boundary carries only the clusters reads: the per-request QueryClient is shared with the
 * `[org]` layout, which hands its own shell reads down itself. A prefetch that fails is not
 * dehydrated; the list then renders its own refusal or error. `loading.tsx` covers the prefetch
 * window.
 */
export default async function ClustersRoute({ searchParams }: { searchParams: SearchParams }) {
	const filtered = clustersQueryFromUrl(paramReader(await searchParams));
	const queryClient = getQueryClient();
	const rpc = serverOrpc();
	await Promise.all([
		queryClient.prefetchQuery(rpc.clusters.page.queryOptions({ input: {}, retry: false })),
		queryClient.prefetchQuery(rpc.clusters.page.queryOptions({ input: filtered, retry: false })),
	]);

	return (
		<HydrationBoundary state={dehydrate(queryClient, { shouldDehydrateQuery: isClustersRead })}>
			<ClustersClient />
		</HydrationBoundary>
	);
}
