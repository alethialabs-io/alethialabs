// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { type ClusterCardShape, clusterCardShape } from "@/components/clusters/cluster-card-shape";
import { getQueryClient } from "@/lib/query/client";
import { serverOrpc } from "@/lib/rpc/server";

/**
 * The cluster list's answer, read on the server before the clusters skeleton draws (#6349, the
 * #6335/#6351 pattern), as one `ClusterCardShape` per card the page will draw. With no clusters the
 * page is a centred empty state; with clusters it is a grid of cards whose heights depend on what
 * each cluster has. A skeleton that guessed was wrong for one of the two kinds of organization.
 *
 * The read goes through the request's query client with the SAME options the clusters pages
 * prefetch, so the page's prefetch in the same request is answered from it, not read twice. A failed
 * read is `undefined`, which draws the card grid — what the page has once it has clusters.
 */
export async function readClusterShapes(): Promise<ClusterCardShape[] | undefined> {
	const queryClient = getQueryClient();
	const options = serverOrpc().clusters.list.queryOptions({ retry: false });
	await queryClient.prefetchQuery(options);
	return queryClient.getQueryData(options.queryKey)?.map(clusterCardShape);
}
