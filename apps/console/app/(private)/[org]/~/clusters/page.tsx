// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { HydrationBoundary, dehydrate } from "@tanstack/react-query";
import { getClusters } from "@/app/server/actions/clusters";
import { getQueryClient } from "@/lib/query/client";
import { pageMetadata } from "@/lib/seo/page-metadata";
import { qk } from "@/lib/query/keys";
import { ClustersClient } from "./clusters-client";

export const metadata = pageMetadata({
	title: "Clusters",
	description: "Provisioned infrastructure and access credentials.",
});

/**
 * Clusters route. Prefetches the cluster list on the server and hydrates it into the
 * client cache so the grid renders on first paint; `loading.tsx` covers the prefetch.
 */
export default async function ClustersRoute({
	params,
}: {
	params: Promise<{ org: string }>;
}) {
	const { org } = await params;
	const queryClient = getQueryClient();
	await queryClient.prefetchQuery({
		queryKey: qk.clusters(org),
		queryFn: () => getClusters(),
	});

	return (
		<HydrationBoundary state={dehydrate(queryClient)}>
			<ClustersClient />
		</HydrationBoundary>
	);
}
