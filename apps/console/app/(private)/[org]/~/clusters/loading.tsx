// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { ClustersSkeleton } from "@/components/clusters/clusters-skeleton";

/**
 * Instant skeleton shown while the clusters route prefetches on the server: the grid's own pending
 * render (`ClustersSkeleton`), so nothing moves when the cards land.
 */
export default function ClustersLoading() {
	return <ClustersSkeleton />;
}
