// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { HydrationBoundary, dehydrate } from "@tanstack/react-query";
import { membersQueryFromUrl } from "@/components/settings/members/members-filters";
import { MembersTable } from "@/components/settings/members/members-table";
import { isPeopleRead } from "@/components/settings/members/people-reads";
import { getQueryClient } from "@/lib/query/client";
import { paramReader } from "@/lib/query/filter-url-codec";
import { serverOrpc } from "@/lib/rpc/server";
import { pageMetadata } from "@/lib/seo/page-metadata";

export const metadata = pageMetadata({
	title: "Members · Settings",
	description: "Organization members and pending invitations.",
});

/**
 * Settings · Members route (#6129, the jobs slice's shape). Prefetches EXACTLY the keys the table
 * asks for on first paint — `members.page` for the pristine view and for the link's filters, and
 * `members.gate` (may this org invite / manage, and why not) — in-process through the read router,
 * and hands the dehydrated cache to the client, so the rows and the toolbar's controls are in the
 * server HTML and the browser fetches nothing on mount. `loading.tsx` covers the prefetch window.
 *
 * The pristine key is prefetched as well as the filtered one because the table's hydration render
 * reads the store's defaults before `useFilterUrlSync` has read the link into it (#4999); for a
 * pristine link the two are one key and TanStack dedupes them.
 */
export default async function MembersPage({
	searchParams,
}: {
	params: Promise<{ org: string }>;
	searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
	const filtered = membersQueryFromUrl(paramReader(await searchParams));
	const queryClient = getQueryClient();
	const rpc = serverOrpc();
	await Promise.all([
		queryClient.prefetchQuery(rpc.members.page.queryOptions({ input: {} })),
		queryClient.prefetchQuery(rpc.members.page.queryOptions({ input: filtered })),
		queryClient.prefetchQuery(rpc.members.gate.queryOptions({ input: undefined })),
	]);

	return (
		<HydrationBoundary state={dehydrate(queryClient, { shouldDehydrateQuery: isPeopleRead })}>
			<MembersTable />
		</HydrationBoundary>
	);
}
