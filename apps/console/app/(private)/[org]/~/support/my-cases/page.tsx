// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { HydrationBoundary, dehydrate } from "@tanstack/react-query";
import { listMyCases } from "@/app/server/actions/support";
import { getQueryClient } from "@/lib/query/client";
import { qk } from "@/lib/query/keys";
import { pageMetadata } from "@/lib/seo/page-metadata";
import { CaseList } from "@/components/support/cases/case-list";

export const metadata = pageMetadata({
	title: "My cases",
	description: "Your support cases and their conversation threads.",
});

/**
 * "My cases" route. Prefetches the unfiltered case list on the server and hands the
 * dehydrated cache to the client so the list renders on first paint; `loading.tsx` covers
 * the prefetch window.
 */
export default async function MyCasesRoute({
	params,
}: {
	params: Promise<{ org: string }>;
}) {
	const { org } = await params;
	const queryClient = getQueryClient();
	await queryClient.prefetchQuery({
		queryKey: qk.supportCases("all"),
		queryFn: () => listMyCases({}),
	});

	return (
		<HydrationBoundary state={dehydrate(queryClient)}>
			<CaseList orgSlug={org} />
		</HydrationBoundary>
	);
}
