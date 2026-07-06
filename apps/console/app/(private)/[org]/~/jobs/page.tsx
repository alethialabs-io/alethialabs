// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { HydrationBoundary, dehydrate } from "@tanstack/react-query";
import { getJobs } from "@/app/server/actions/jobs";
import { getQueryClient } from "@/lib/query/client";
import { pageMetadata } from "@/lib/seo/page-metadata";
import { qk } from "@/lib/query/keys";
import { JobsClient } from "./jobs-client";

export const metadata = pageMetadata({
	title: "Jobs",
	description: "Provision job history and execution logs.",
});

/**
 * Jobs route. Prefetches the jobs list on the server and hands the dehydrated cache to
 * the client so the table renders with data on first paint (no post-hydration fetch
 * waterfall); `loading.tsx` covers the prefetch window.
 */
export default async function JobsRoute({
	params,
}: {
	params: Promise<{ org: string }>;
}) {
	const { org } = await params;
	const queryClient = getQueryClient();
	await queryClient.prefetchQuery({
		queryKey: qk.jobs(org),
		queryFn: () => getJobs(),
	});

	return (
		<HydrationBoundary state={dehydrate(queryClient)}>
			<JobsClient />
		</HydrationBoundary>
	);
}
