// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { ClustersSkeleton } from "@/components/clusters/clusters-skeleton";
import { readClusterShapes } from "@/components/clusters/read-cluster-shapes";

/**
 * Skeleton for the org clusters route, in the shape of the page it is about to be (#6349). It reads
 * the cluster list BEFORE it draws, through the request's query client (the page's prefetch of the
 * same key is answered from it): no clusters draws the empty state's frame, clusters draw the card
 * grid with a placeholder per card, and a failed read draws the card grid.
 */
export default async function ClustersLoading() {
	return <ClustersSkeleton shapes={await readClusterShapes()} />;
}
