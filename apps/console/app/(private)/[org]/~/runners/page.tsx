// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { HydrationBoundary, dehydrate } from "@tanstack/react-query";
import { getQueryClient } from "@/lib/query/client";
import { pageMetadata } from "@/lib/seo/page-metadata";
import { qk } from "@/lib/query/keys";
import { getRunnersPage } from "@/app/server/actions/runners";
import { runnersQueryFromUrl } from "@/components/runners/runners-query";
import { paramReader } from "@/lib/query/filter-url-codec";
import { fetchFleetData, fetchRunnersData } from "@/lib/query/resource-fetchers";
import { RunnersClient } from "./runners-client";

export const metadata = pageMetadata({
	title: "Runners",
	description: "Warm pools and the runners that execute your provisioning jobs.",
});

/**
 * Runners route. Prefetches the runner GRID's pristine page + the fleet pools on the server
 * and hydrates them into the client cache so both render on first paint; `loading.tsx` covers
 * the prefetch window. The query hooks then poll on the reconcile cadence.
 *
 * A pasted FILTERED link (`?versions=1.4.0`) also gets its filtered page prefetched (#4980, the
 * audit's F8). The client renders pristine first — `useFilterUrlSync` reads the URL in a mount
 * effect — and then asks for the filtered key; without this the key arrived empty and
 * `keepPreviousData` held the WHOLE grid up under a URL that said otherwise until the server
 * action returned. Unlike `~/connectors` (#4968), whose seed is a client-side selection over the
 * RSC's catalog and is therefore marked stale, this is the server's own filtered read through the
 * same builder the query hook calls — it is as fresh as the pristine page beside it, and the
 * grid's 10s poll refreshes both.
 */
export default async function RunnersRoute({
	params,
	searchParams,
}: {
	params: Promise<{ org: string }>;
	searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
	const { org } = await params;
	const filtered = runnersQueryFromUrl(paramReader(await searchParams));
	const queryClient = getQueryClient();
	await Promise.all([
		// The GRID's key, pristine — `normalizeRunnersQuery()` of the default filters is `{}`,
		// and the key the client builds on first render has to be this one or hydration misses
		// and the page fetches anyway (#4890). It is prefetched for a filtered link too: the
		// server render and the hydration render both hold the store's defaults.
		queryClient.prefetchQuery({
			queryKey: qk.runnersPage(org, {}),
			queryFn: () => getRunnersPage({}),
		}),
		// The key the client settles on once it has read the link. `{}` again for a pristine
		// link, where TanStack dedupes it against the prefetch above.
		queryClient.prefetchQuery({
			queryKey: qk.runnersPage(org, filtered),
			queryFn: () => getRunnersPage(filtered),
		}),
		// The UNFILTERED universe, which is a different read for different consumers and not a
		// leftover: the Versions changelog compares every runner against the latest release, and
		// each card's action menu needs to know whether ITS runner is the org default — neither
		// question is answerable from a filtered page. Dropping this prefetch does not break
		// them, it just makes them both fetch after hydration, on a page that had them on first
		// paint.
		queryClient.prefetchQuery({
			queryKey: qk.runners(org),
			queryFn: fetchRunnersData,
		}),
		queryClient.prefetchQuery({
			queryKey: qk.fleet(org),
			queryFn: fetchFleetData,
		}),
	]);

	return (
		<HydrationBoundary state={dehydrate(queryClient)}>
			<RunnersClient />
		</HydrationBoundary>
	);
}
