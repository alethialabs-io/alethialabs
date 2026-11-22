// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { ClustersSkeleton } from "@/components/clusters/clusters-skeleton";

/**
 * Skeleton for a project's clusters route: the org list's skeleton without the Project column.
 * Synchronous — it reads nothing, so nothing paints before it.
 */
export default function ProjectClustersLoading() {
	return <ClustersSkeleton showProject={false} />;
}
