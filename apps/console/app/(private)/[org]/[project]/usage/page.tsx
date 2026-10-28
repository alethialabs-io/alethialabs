// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { HydrationBoundary, dehydrate } from "@tanstack/react-query";
import { notFound } from "next/navigation";
import { resolveProjectId } from "@/app/server/actions/resolve";
import { ProjectUsagePanel } from "@/components/settings/usage/project-usage-panel";
import { USAGE_DEFAULT_RANGE } from "@/components/settings/usage/usage-reads";
import { getQueryClient } from "@/lib/query/client";
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
 */
export default async function ProjectUsageRoute({
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
	const rpc = serverOrpc();
	const input = { projectId };
	await Promise.all([
		queryClient.prefetchQuery(rpc.usage.project.queryOptions({ input })),
		queryClient.prefetchQuery(rpc.usage.projectResources.queryOptions({ input })),
		queryClient.prefetchQuery(rpc.usage.projectAi.queryOptions({ input })),
		queryClient.prefetchQuery(
			rpc.usage.projectOverTime.queryOptions({
				input: { projectId, range: USAGE_DEFAULT_RANGE },
			}),
		),
	]);

	return (
		<HydrationBoundary state={dehydrate(queryClient)}>
			<ProjectUsagePanel projectId={projectId} />
		</HydrationBoundary>
	);
}
