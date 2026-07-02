// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { HydrationBoundary, dehydrate } from "@tanstack/react-query";
import { notFound } from "next/navigation";
import { getClusters } from "@/app/server/actions/clusters";
import { resolveProjectId } from "@/app/server/actions/resolve";
import { getQueryClient } from "@/lib/query/client";
import { qk } from "@/lib/query/keys";
import { pageMetadata } from "@/lib/seo/page-metadata";
import { ClustersClient } from "../../~/clusters/clusters-client";

export const metadata = pageMetadata({
	title: "Clusters",
	description: "This project's provisioned infrastructure and access credentials.",
});

/**
 * `/{org}/{project}/clusters` — the project's cluster(s). Reuses the org clusters grid scoped to
 * this project: prefetches the shared org cluster list (`qk.clusters(org)`) and hands
 * `ClustersClient` the resolved project id, which filters the grid to it. `loading.tsx` covers
 * the prefetch window.
 */
export default async function ProjectClustersRoute({
	params,
}: {
	params: Promise<{ org: string; project: string }>;
}) {
	const { org, project } = await params;
	let projectId: string;
	try {
		projectId = await resolveProjectId(project);
	} catch {
		notFound();
	}

	const queryClient = getQueryClient();
	await queryClient.prefetchQuery({
		queryKey: qk.clusters(org),
		queryFn: () => getClusters(),
	});

	return (
		<HydrationBoundary state={dehydrate(queryClient)}>
			<ClustersClient projectId={projectId} />
		</HydrationBoundary>
	);
}
