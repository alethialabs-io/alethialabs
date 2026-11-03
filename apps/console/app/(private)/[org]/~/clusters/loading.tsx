// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { ClustersSkeleton } from "@/components/clusters/clusters-skeleton";

/**
 * Instant skeleton shown while the clusters route prefetches on the server: the region's own pending
 * render (`ClustersSkeleton`), which draws the empty state's frame, the page an organization has
 * until its first deploy succeeds.
 */
export default function ClustersLoading() {
	return <ClustersSkeleton />;
}
