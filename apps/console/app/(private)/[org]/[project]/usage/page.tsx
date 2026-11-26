// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { HydrationBoundary, dehydrate } from "@tanstack/react-query";
import { notFound } from "next/navigation";
import { ProjectUsagePanel } from "@/components/settings/usage/project-usage-panel";
import { isUsageRead, usageRangeSpec } from "@/components/settings/usage/usage-reads";
import { resolveProjectOr404 } from "@/lib/projects/resolve-project-or-404";
import { getQueryClient } from "@/lib/query/client";
import { paramReader } from "@/lib/query/filter-url-codec";
import { rangeFromUrl } from "@/lib/query/view-url-params";
import { serverOrpc } from "@/lib/rpc/server";
import { pageMetadata } from "@/lib/seo/page-metadata";

export const metadata = pageMetadata({
	title: "Usage",
	description: "This project's resource usage.",
});

/**
 * `/{org}/{project}/usage` — the project's real per-project usage report: jobs, managed runner
 * job-minutes, clusters, estimated cloud cost, and AI credits (attributed via ref_id, best-
 * effort). Org-wide meters (seats, plan limits, provisioned-runner hours) link out to the org
 * usage page. Resolves + validates the slug (bad URL → 404), then prefetches EVERY read the panel
 * makes on first paint — the period-fixed reads AND the opening window of the over-time chart,
 * keyed by its preset — through the read router, in-process (#6127, ADR 0005 D1). The chart's
 * window used to be fetched in the browser on mount. `loading.tsx` covers the prefetch window.
 * The window is the link's (`?range=`, R6 C-32); only this page's reads are dehydrated (R6 C-34).
 */
export default async function ProjectUsageRoute({
	params,
	searchParams,
}: {
	params: Promise<{ org: string; project: string }>;
	searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
	const { project } = await params;
	const range = usageRangeSpec(rangeFromUrl(paramReader(await searchParams)));
	// Null is the project 404; a lost session or a real failure never reaches this line.
	const projectId = (await resolveProjectOr404(project)) ?? notFound();

	const queryClient = getQueryClient();
	const rpc = serverOrpc();
	const input = { projectId };
	await Promise.all([
		queryClient.prefetchQuery(rpc.usage.project.queryOptions({ input })),
		queryClient.prefetchQuery(rpc.usage.projectResources.queryOptions({ input })),
		queryClient.prefetchQuery(rpc.usage.projectAi.queryOptions({ input })),
		queryClient.prefetchQuery(
			rpc.usage.projectOverTime.queryOptions({
				input: { projectId, range },
			}),
		),
	]);

	return (
		<HydrationBoundary state={dehydrate(queryClient, { shouldDehydrateQuery: isUsageRead })}>
			<ProjectUsagePanel projectId={projectId} />
		</HydrationBoundary>
	);
}
