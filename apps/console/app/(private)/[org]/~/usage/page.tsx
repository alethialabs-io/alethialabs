// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { HydrationBoundary, dehydrate } from "@tanstack/react-query";
import { UsagePanel } from "@/components/settings/usage/usage-panel";
import { USAGE_DEFAULT_RANGE } from "@/components/settings/usage/usage-reads";
import { getQueryClient } from "@/lib/query/client";
import { serverOrpc } from "@/lib/rpc/server";
import { pageMetadata } from "@/lib/seo/page-metadata";

export const metadata = pageMetadata({
	title: "Usage",
	description:
		"Seats, runner-minutes and projects consumed by your organization this period.",
});

/**
 * Usage: seats, runner-minutes, projects consumed this period, and AI (#6127, ADR 0005 D1).
 *
 * Prefetches EXACTLY the keys the panel reads on first paint, in-process through the read router,
 * and hands the dehydrated cache to the client — so the first paint carries the numbers and the
 * browser fetches nothing on mount. It used to render `<UsagePanel />` bare, and the panel fetched
 * all four reads in `useEffect` behind a two-box skeleton.
 *
 * The summary goes first because it decides what the page IS: a self-managed instance and a person
 * with no organization render one card each and read nothing else, so nothing else is prefetched
 * for them. A failed prefetch is not dehydrated; the panel then reads in the browser and renders
 * that read's error or refusal, section by section. `loading.tsx` covers the prefetch window.
 */
export default async function UsagePage() {
	const queryClient = getQueryClient();
	const rpc = serverOrpc();
	const summary = await queryClient
		.fetchQuery(rpc.billing.summary.queryOptions())
		.catch(() => null);
	if (summary?.hosted && summary.hasOrg) {
		await Promise.all([
			queryClient.prefetchQuery(rpc.usage.org.queryOptions()),
			queryClient.prefetchQuery(rpc.usage.resources.queryOptions()),
			queryClient.prefetchQuery(
				rpc.usage.overTime.queryOptions({ input: { range: USAGE_DEFAULT_RANGE } }),
			),
			queryClient.prefetchQuery(rpc.usage.ai.queryOptions()),
			queryClient.prefetchQuery(rpc.billing.liveAiPrices.queryOptions()),
		]);
	}

	return (
		<HydrationBoundary state={dehydrate(queryClient)}>
			<UsagePanel />
		</HydrationBoundary>
	);
}
