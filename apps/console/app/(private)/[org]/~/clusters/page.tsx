// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { HydrationBoundary, dehydrate } from "@tanstack/react-query";
import { isClustersRead } from "@/components/clusters/clusters-reads";
import { getQueryClient } from "@/lib/query/client";
import { serverOrpc } from "@/lib/rpc/server";
import { pageMetadata } from "@/lib/seo/page-metadata";
import { ClustersClient } from "./clusters-client";

export const metadata = pageMetadata({
	title: "Clusters",
	description: "Provisioned infrastructure and access credentials.",
});

/**
 * Clusters route (#6122, ADR 0005 D1). Prefetches EXACTLY the key the grid reads — `clusters.list`,
 * in-process through the read router, for the actor the request's address resolves — and hydrates it,
 * so the first paint is the grid, not a skeleton and a second request. The boundary carries only the
 * clusters read: the per-request QueryClient is shared with the `[org]` layout, which hands its own
 * shell reads down itself. A prefetch that fails is not dehydrated; the grid then renders its own
 * refusal or error. `loading.tsx` covers the prefetch window.
 */
export default async function ClustersRoute() {
	const queryClient = getQueryClient();
	await queryClient.prefetchQuery(serverOrpc().clusters.list.queryOptions({ retry: false }));

	return (
		<HydrationBoundary state={dehydrate(queryClient, { shouldDehydrateQuery: isClustersRead })}>
			<ClustersClient />
		</HydrationBoundary>
	);
}
