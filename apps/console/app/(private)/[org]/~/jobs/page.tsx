// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { HydrationBoundary, dehydrate } from "@tanstack/react-query";
import { DEFAULT_JOBS_FILTERS, normalizeJobsQuery } from "@/components/jobs/jobs-query";
import { getQueryClient } from "@/lib/query/client";
import { filterStateFromUrl, paramReader } from "@/lib/query/filter-url-codec";
import { JOBS_DEFAULT_PRESET, jobsPageInputFrom } from "@/lib/rpc/inputs/jobs";
import { serverOrpc } from "@/lib/rpc/server";
import { pageMetadata } from "@/lib/seo/page-metadata";
import { JobsClient } from "./jobs-client";

export const metadata = pageMetadata({
	title: "Jobs",
	description: "Provision job history and execution logs.",
});

/**
 * Jobs route (#6113, the ADR 0005 slice). Prefetches EXACTLY the key the client asks for on first
 * paint — the `jobs.page` read for the URL's filters and the default preset — in-process through
 * the read router, and hands the dehydrated cache to the client. Before this the route prefetched
 * `qk.jobs` while the client read `qk.jobsPage`, so every first paint showed "No results." while a
 * second request ran (F004). `loading.tsx` covers the prefetch window.
 */
export default async function JobsRoute({
	searchParams,
}: {
	params: Promise<{ org: string }>;
	searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
	const filters = filterStateFromUrl(paramReader(await searchParams), DEFAULT_JOBS_FILTERS);
	const input = jobsPageInputFrom(
		normalizeJobsQuery(filters, { from: "", to: "" }),
		{ preset: JOBS_DEFAULT_PRESET },
	);
	const queryClient = getQueryClient();
	await queryClient.prefetchQuery(serverOrpc().jobs.page.queryOptions({ input }));

	return (
		<HydrationBoundary state={dehydrate(queryClient)}>
			<JobsClient />
		</HydrationBoundary>
	);
}
