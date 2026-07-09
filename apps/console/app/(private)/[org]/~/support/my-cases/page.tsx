// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { HydrationBoundary, dehydrate } from "@tanstack/react-query";
import { listMyCases } from "@/app/server/actions/support";
import { getPdp } from "@/lib/authz";
import { currentActor } from "@/lib/authz/guard";
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
	// Whether the caller sees the whole org's cases (owner/admin) vs only their own —
	// drives the "all cases" caption + the per-row requester label.
	const actor = await currentActor();
	const seeAll = (
		await getPdp().can(actor, "manage_support", { type: "support_case" })
	).allowed;

	const queryClient = getQueryClient();
	await queryClient.prefetchQuery({
		queryKey: qk.supportCases("all"),
		queryFn: () => listMyCases({}),
	});

	return (
		<HydrationBoundary state={dehydrate(queryClient)}>
			<CaseList orgSlug={org} seeAll={seeAll} />
		</HydrationBoundary>
	);
}
