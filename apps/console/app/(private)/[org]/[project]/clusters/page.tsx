// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { HydrationBoundary, dehydrate } from "@tanstack/react-query";
import { notFound } from "next/navigation";
import { resolveProjectId } from "@/app/server/actions/resolve";
import { isClustersRead } from "@/components/clusters/clusters-reads";
import { getQueryClient } from "@/lib/query/client";
import { serverOrpc } from "@/lib/rpc/server";
import { pageMetadata } from "@/lib/seo/page-metadata";
import { ClustersClient } from "../../~/clusters/clusters-client";

export const metadata = pageMetadata({
	title: "Clusters",
	description: "This project's provisioned infrastructure and access credentials.",
});

/**
 * `/{org}/{project}/clusters` — the project's clusters, one per environment that runs one. Reuses the
 * org clusters grid scoped to this project: prefetches the same `clusters.list` read the org page
 * does (one cache entry serves both) and hands `ClustersClient` the resolved project id, which
 * filters the grid to it. `loading.tsx` covers the prefetch window.
 */
export default async function ProjectClustersRoute({
	params,
}: {
	params: Promise<{ org: string; project: string }>;
}) {
	const { project } = await params;
	let projectId: string;
	try {
		projectId = await resolveProjectId(project);
	} catch {
		notFound();
	}

	const queryClient = getQueryClient();
	await queryClient.prefetchQuery(serverOrpc().clusters.list.queryOptions({ retry: false }));

	return (
		<HydrationBoundary state={dehydrate(queryClient, { shouldDehydrateQuery: isClustersRead })}>
			<ClustersClient projectId={projectId} />
		</HydrationBoundary>
	);
}
