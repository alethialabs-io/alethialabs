// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { HydrationBoundary, dehydrate } from "@tanstack/react-query";
import { getProjects } from "@/app/server/actions/projects";
import { getQueryClient } from "@/lib/query/client";
import { pageMetadata } from "@/lib/seo/page-metadata";
import { seedClassificationAssignments } from "@/lib/query/prefetch-classification";
import { qk } from "@/lib/query/keys";
import { OverviewClient } from "./overview-client";

export const metadata = pageMetadata({
	title: "Overview",
	description: "Your organization's projects, usage, alerts, and recent jobs.",
});

/**
 * Org root overview. Prefetches the projects list on the server and hydrates it into the
 * client cache so the grid renders on first paint; `loading.tsx` covers the prefetch.
 */
export default async function OrgOverviewRoute({
	params,
}: {
	params: Promise<{ org: string }>;
}) {
	const { org } = await params;
	const queryClient = getQueryClient();
	const projects = await getProjects();
	queryClient.setQueryData(qk.projects(org), projects);
	// Batch-seed each project card's classification chips (one round-trip, no per-card fetch).
	await seedClassificationAssignments(
		queryClient,
		"project",
		projects.map((p) => p.id),
	);

	return (
		<HydrationBoundary state={dehydrate(queryClient)}>
			<OverviewClient />
		</HydrationBoundary>
	);
}
