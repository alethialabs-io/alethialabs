// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { HydrationBoundary, type QueryClient, dehydrate } from "@tanstack/react-query";
import { isOverviewPageRead, isRecentJobsKey } from "@/components/overview/overview-reads";
import {
	type OverviewSearchParams,
	overviewProjectsInput,
	toOverviewState,
} from "@/components/overview/overview-state";
import { getQueryClient } from "@/lib/query/client";
import { serverOrpc } from "@/lib/rpc/server";
import { pageMetadata } from "@/lib/seo/page-metadata";
import { OverviewClient } from "./overview-client";

export const metadata = pageMetadata({
	title: "Overview",
	description: "Your organization's projects, usage, alerts, and recent jobs.",
});

/**
 * Join the `[org]` layout's read of the shell's job feed (`workspace.recentJobs`), or start it for
 * both: whichever side asks first, the other joins it in flight on the one per-request client, so it
 * is one read. The options are the layout's own (no `retry` override), so the read behaves the same
 * whichever side starts it. A failure is swallowed (`prefetchQuery`): the card then waits for
 * hydration, as before.
 *
 * It never RE-asks a read the layout already saw fail. The layout dehydrated that failure as an
 * absence; a second answer here would put rows in the page's HTML that the browser's cache, which
 * the shell has already subscribed to that key, would only receive in an effect after hydration —
 * React #418 on the card (#5786).
 */
function joinRecentJobs(queryClient: QueryClient, rpc: ReturnType<typeof serverOrpc>): Promise<void> {
	const options = rpc.workspace.recentJobs.queryOptions();
	if (queryClient.getQueryState(options.queryKey)?.status === "error") return Promise.resolve();
	return queryClient.prefetchQuery(options);
}

/**
 * The grid's first keyset page for `input`, under EXACTLY the infinite key
 * `useKeysetList(orpc.overview.projects.page, input)` asks for: oRPC builds that key from
 * `input(initialPageParam)`, and the initial page param is null on both sides, so the key is the
 * address's query alone. A failure is swallowed (`prefetchInfiniteQuery`) and not dehydrated: the
 * grid then renders its own refusal or error in the browser.
 */
function prefetchFirstProjectsPage(
	queryClient: QueryClient,
	rpc: ReturnType<typeof serverOrpc>,
	input: ReturnType<typeof overviewProjectsInput>,
): Promise<void> {
	return queryClient.prefetchInfiniteQuery(
		rpc.overview.projects.page.infiniteOptions({
			input: (cursor: string | null) => (cursor === null ? input : { ...input, cursor }),
			initialPageParam: null,
			getNextPageParam: (last) => last.nextCursor,
			retry: false,
		}),
	);
}

/**
 * Org root overview. Reads the grid's search, filter, sort and view from the address and prefetches
 * every read the page makes for it; the client reads the same keys.
 *
 * NOTHING HERE IS AWAITED UNCAUGHT. Each read is a `prefetchQuery`, which swallows a failure, so no
 * read can send the page to the organization's error boundary: a read that was refused or failed is
 * simply not handed down, and the region that owns it renders its own refused or failed state in
 * the browser (RUBRIC B5). The project grid used to be awaited here and passed as props, so a viewer
 * without `view` on projects got the error page and a retry that could not work.
 *
 * The reads, all in-process through the read router and with exactly the keys the regions ask for:
 *
 * - `overview.projects.page` — the grid's FIRST keyset page for this address's search, filters and
 *   sort, under exactly the infinite key `useOverviewProjects` asks for (`overviewProjectsInput`: the
 *   browser builds its key from the same function, and the cursor is never part of it). Only the
 *   first page: the rest are read in the browser as the reader scrolls or presses "Load more";
 * - `overview.projects.summary` — the grid's create permission and clouds, and the Usage card's
 *   project count;
 * - `overview.usage` and `overview.alerts` — the cards (#6118, ADR 0005 D1).
 *
 * They are hydrated by this page's own boundary, filtered to those reads (`isOverviewPageRead`):
 * the layout dehydrates when IT renders, which does not wait for this page's prefetches, and it
 * already hands down the shell's reads — this boundary does not serialize them a second time, with
 * ONE exception.
 *
 * The exception is the Recent-jobs card's read, the shell's `workspace.recentJobs` (#6347). The card
 * must draw its rows in the server HTML (RUBRIC B1), and may do that only when the hydrating render
 * is certain to hold the same feed (#5786). The page joins the layout's read (`joinRecentJobs`:
 * the same key on the same per-request client, so one read, not two), hands it down in its OWN boundary when
 * it answered — this boundary sits directly above the card, so the card's hydration cannot run
 * without it — and tells the card so (`jobsPrefetched`), read off the dehydrated state itself so the
 * flag and the payload cannot disagree. It is the shell's newest twenty slim rows, serialized twice.
 */
export default async function OrgOverviewRoute({
	params,
	searchParams,
}: {
	params: Promise<{ org: string }>;
	searchParams: Promise<OverviewSearchParams>;
}) {
	const { org } = await params;
	const state = toOverviewState(await searchParams);

	const queryClient = getQueryClient();
	const rpc = serverOrpc();
	await Promise.all([
		// `retry: false`: the console's default `retry: 1` would hold the first byte ~1 s on a refusal
		// or a transient failure, and each region retries in the browser anyway. Not part of the key.
		prefetchFirstProjectsPage(queryClient, rpc, overviewProjectsInput(state)),
		queryClient.prefetchQuery(rpc.overview.projects.summary.queryOptions({ retry: false })),
		queryClient.prefetchQuery(rpc.overview.usage.queryOptions({ retry: false })),
		queryClient.prefetchQuery(rpc.overview.alerts.queryOptions({ retry: false })),
		joinRecentJobs(queryClient, rpc),
	]);

	const dehydrated = dehydrate(queryClient, { shouldDehydrateQuery: isOverviewPageRead });
	const jobsPrefetched = dehydrated.queries.some((q) => isRecentJobsKey(q.queryKey));

	return (
		<HydrationBoundary state={dehydrated}>
			<OverviewClient orgSlug={org} state={state} jobsPrefetched={jobsPrefetched} />
		</HydrationBoundary>
	);
}
