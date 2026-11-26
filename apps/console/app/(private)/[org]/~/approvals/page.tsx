// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { HydrationBoundary, dehydrate } from "@tanstack/react-query";
import { prefetchApprovalsRoute } from "@/components/approvals/approvals-prefetch";
import { ApprovalsList } from "@/components/approvals/approvals-list";
import { getQueryClient } from "@/lib/query/client";
import { paramReader } from "@/lib/query/filter-url-codec";
import { pageMetadata } from "@/lib/seo/page-metadata";

export const metadata = pageMetadata({
	title: "Approvals",
	description: "Requests to deploy or destroy that wait for a person to decide.",
});

/**
 * The approvals route (AGT-L2 spec §1): the list of requests, and the decision sheet over it when the
 * URL names one (`?selected=<id>`). There is no separate approval page (maintainer ruling 1). The
 * server prefetches exactly the keys the first paint reads — the list's first keyset page for the
 * pristine view and for the link's filters, and the named approval's sheet — so a link an agent
 * printed opens straight onto the decision. `loading.tsx` covers the prefetch window.
 */
export default async function ApprovalsRoute({
	searchParams,
}: {
	params: Promise<{ org: string }>;
	searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
	const queryClient = getQueryClient();
	await prefetchApprovalsRoute(queryClient, paramReader(await searchParams));
	return (
		<HydrationBoundary state={dehydrate(queryClient)}>
			<ApprovalsList />
		</HydrationBoundary>
	);
}
