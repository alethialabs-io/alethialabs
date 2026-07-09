// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { HydrationBoundary, dehydrate } from "@tanstack/react-query";
import { notFound } from "next/navigation";
import {
	getProjectAiUsage,
	getProjectResourceCounts,
	getProjectUsage,
} from "@/app/server/actions/project-usage";
import { resolveProjectId } from "@/app/server/actions/resolve";
import { ProjectUsagePanel } from "@/components/settings/usage/project-usage-panel";
import { getQueryClient } from "@/lib/query/client";
import { qk } from "@/lib/query/keys";
import { pageMetadata } from "@/lib/seo/page-metadata";

export const metadata = pageMetadata({
	title: "Usage",
	description: "This project's resource usage.",
});

/**
 * `/{org}/{project}/usage` — the project's real per-project usage report: jobs, managed runner
 * job-minutes, clusters, estimated cloud cost, and AI credits (attributed via ref_id, best-
 * effort). Org-wide meters (seats, plan limits, provisioned-runner hours) link out to the org
 * usage page. Resolves + validates the slug (bad URL → 404), prefetches the period-fixed reads
 * into the shared cache and hands the resolved project id to the client panel (which also drives
 * the range-based over-time chart). `loading.tsx` covers the prefetch window.
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
	await Promise.all([
		queryClient.prefetchQuery({
			queryKey: [...qk.projectUsage(projectId), "report"] as const,
			queryFn: () => getProjectUsage(projectId),
		}),
		queryClient.prefetchQuery({
			queryKey: [...qk.projectUsage(projectId), "counts"] as const,
			queryFn: () => getProjectResourceCounts(projectId),
		}),
		queryClient.prefetchQuery({
			queryKey: [...qk.projectUsage(projectId), "ai"] as const,
			queryFn: () => getProjectAiUsage(projectId),
		}),
	]);

	return (
		<HydrationBoundary state={dehydrate(queryClient)}>
			<ProjectUsagePanel projectId={projectId} />
		</HydrationBoundary>
	);
}
