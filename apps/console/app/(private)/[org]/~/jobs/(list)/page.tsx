// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { HydrationBoundary, dehydrate } from "@tanstack/react-query";
import { prefetchJobsList } from "@/components/jobs/jobs-prefetch";
import { getQueryClient } from "@/lib/query/client";
import { paramReader } from "@/lib/query/filter-url-codec";
import { pageMetadata } from "@/lib/seo/page-metadata";
import { JobsClient } from "../jobs-client";

export const metadata = pageMetadata({
	title: "Jobs",
	description: "Provision job history and execution logs.",
});

/**
 * Jobs route (#6113, the ADR 0005 slice). Prefetches EXACTLY the key the client asks for on first
 * paint — the first keyset page of `jobs.page` for the URL's filters, the date range among them
 * (`prefetchJobsList`, #7483) — in-process through the read router, and hands the dehydrated cache
 * to the client. Before this the route prefetched
 * `qk.jobs` while the client read `qk.jobsPage`, so every first paint showed "No results." while a
 * second request ran (F004). `loading.tsx` covers the prefetch window.
 *
 * WHY THIS FILE IS IN A `(list)` ROUTE GROUP (#6350). A `loading.tsx` wraps its segment's whole
 * children slot, not only the segment's page, so while the list and its skeleton sat directly in
 * `~/jobs/` the LIST skeleton was the first loading boundary on the way to `~/jobs/[id]` as well: a
 * navigation to one job painted a filter bar over a table, then swapped to a log view (B2 scored
 * 0.049 on release-gate run 40822681524). A group is a segment of its own that adds nothing to the
 * URL, so this skeleton now wraps this page alone and `[id]` paints its own `loading.tsx`.
 */
export default async function JobsRoute({
	searchParams,
}: {
	params: Promise<{ org: string }>;
	searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
	const queryClient = getQueryClient();
	await prefetchJobsList(queryClient, paramReader(await searchParams));

	return (
		<HydrationBoundary state={dehydrate(queryClient)}>
			<JobsClient />
		</HydrationBoundary>
	);
}
