// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { ProjectClustersSkeleton } from "@/components/clusters/project-clusters-skeleton";
import { readClusterShapes } from "@/components/clusters/read-cluster-shapes";

/**
 * Skeleton for the project clusters route (#6349). It reads the org's cluster list on the server, as
 * the org route's skeleton does, and `ProjectClustersSkeleton` keeps this project's cards: a
 * `loading.tsx` receives no params, so the project is resolved from the address in the browser.
 */
export default async function ProjectClustersLoading() {
	return <ProjectClustersSkeleton shapes={await readClusterShapes()} />;
}
