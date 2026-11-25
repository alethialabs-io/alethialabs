// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { HydrationBoundary, dehydrate } from "@tanstack/react-query";
import { notFound } from "next/navigation";
import { prefetchClustersList } from "@/components/clusters/clusters-prefetch";
import { isClustersRead } from "@/components/clusters/clusters-reads";
import { resolveProjectOr404 } from "@/lib/projects/resolve-project-or-404";
import { getQueryClient } from "@/lib/query/client";
import { paramReader } from "@/lib/query/filter-url-codec";
import { pageMetadata } from "@/lib/seo/page-metadata";
import { ClustersClient } from "../../~/clusters/clusters-client";

export const metadata = pageMetadata({
	title: "Clusters",
	description: "This project's provisioned infrastructure and access credentials.",
});

/**
 * `/{org}/{project}/clusters` — the project's clusters, one per environment that runs one. The org
 * clusters list, SCOPED to this project: the project id is part of the read's input, so the rows,
 * and the facet options are the project's own, and it is never a filter in the bar or the query
 * string. Prefetches the first keyset page of the pristine list and of the link's filters, as the
 * org route does. `loading.tsx` covers the prefetch window.
 */
export default async function ProjectClustersRoute({
	params,
	searchParams,
}: {
	params: Promise<{ org: string; project: string }>;
	searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
	const { project } = await params;
	// Null is the project 404; a lost session or a real failure never reaches this line.
	const projectId = (await resolveProjectOr404(project)) ?? notFound();

	const queryClient = getQueryClient();
	await prefetchClustersList(queryClient, paramReader(await searchParams), projectId);

	return (
		<HydrationBoundary state={dehydrate(queryClient, { shouldDehydrateQuery: isClustersRead })}>
			<ClustersClient projectId={projectId} />
		</HydrationBoundary>
	);
}
