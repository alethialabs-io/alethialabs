// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { ClustersSkeleton } from "@/components/clusters/clusters-skeleton";

/**
 * Skeleton for the org clusters route, in the shape of the list it is about to be: the toolbar, the
 * filter bar and the table. Synchronous — it reads nothing, so nothing paints before it.
 */
export default function ClustersLoading() {
	return <ClustersSkeleton />;
}
