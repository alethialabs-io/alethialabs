// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { HydrationBoundary, dehydrate } from "@tanstack/react-query";
import { getMembersPage } from "@/app/server/actions/members";
import { membersQueryFromUrl } from "@/components/settings/members/members-filters";
import { MembersTable } from "@/components/settings/members/members-table";
import { getQueryClient } from "@/lib/query/client";
import { paramReader } from "@/lib/query/filter-url-codec";
import { qk } from "@/lib/query/keys";
import { pageMetadata } from "@/lib/seo/page-metadata";

export const metadata = pageMetadata({
	title: "Members · Settings",
	description: "Organization members and pending invitations.",
});

/**
 * Settings · Members route. Prefetches the members page on the server and hydrates it into the
 * client cache, so the table renders on first paint; `loading.tsx` covers the prefetch window.
 *
 * A pasted FILTERED link (`?statuses=pending`) also gets its filtered page prefetched (#4999, the
 * audit's F8 — the class #4980 fixed on `~/runners` and `~/alerts`). The client renders pristine
 * first, because `useFilterUrlSync` reads the URL in a mount effect, and then asks for the
 * filtered key; without this the key arrived empty and `keepPreviousData` held the WHOLE list up
 * under a URL that said otherwise until the server action returned. Both reads go through
 * `getMembersPage`, the same server action `useMembersPageQuery` calls, so the seed is as fresh as
 * a client fetch would have been.
 */
export default async function MembersPage({
	params,
	searchParams,
}: {
	params: Promise<{ org: string }>;
	searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
	const { org } = await params;
	const filtered = membersQueryFromUrl(paramReader(await searchParams));
	const queryClient = getQueryClient();
	await Promise.all([
		// The pristine key — `normalizeMembersQuery()` of the defaults is `{}`, and it is what the
		// server render and the hydration render ask for whatever the link says, because the store
		// still holds its defaults there. It is always handed to `qk.members` as an object:
		// `qk.members(org)` with no query is the unfiltered `getMembers()` read, a different shape.
		queryClient.prefetchQuery({
			queryKey: qk.members(org, {}),
			queryFn: () => getMembersPage({}),
		}),
		// The key the client settles on once it has read the link. `{}` again for a pristine
		// link, where TanStack dedupes it against the prefetch above.
		queryClient.prefetchQuery({
			queryKey: qk.members(org, filtered),
			queryFn: () => getMembersPage(filtered),
		}),
	]);

	return (
		<HydrationBoundary state={dehydrate(queryClient)}>
			<MembersTable />
		</HydrationBoundary>
	);
}
