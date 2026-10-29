// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { HydrationBoundary, type QueryClient, dehydrate } from "@tanstack/react-query";
import { queryProjects, type ProjectListQuery } from "@/app/server/actions/projects";
import { readConnectedCloudProviders } from "@/lib/rpc/procedures/connectors";
import { isOverviewPageRead, isRecentJobsKey } from "@/components/overview/overview-reads";
import { getQueryClient } from "@/lib/query/client";
import { serverOrpc } from "@/lib/rpc/server";
import { pageMetadata } from "@/lib/seo/page-metadata";
import type { ViewMode } from "@repo/ui/view-toggle";
import { OverviewClient, type OverviewState } from "./overview-client";

export const metadata = pageMetadata({
	title: "Overview",
	description: "Your organization's projects, usage, alerts, and recent jobs.",
});

/** Raw search params owning the grid's search/filter/sort/view state (all optional). */
type OverviewSearchParams = {
	q?: string;
	cloud?: string;
	repo?: string;
	sort?: string;
	view?: string;
};

/** Splits a comma-separated URL param into a trimmed, non-empty list. */
function toList(value: string | undefined): string[] {
	return (value ?? "")
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
}

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
 * Org root overview. Reads the grid's search/filter/sort state from the URL, resolves the matching
 * projects (searched/filtered/sorted server-side) plus the full facet universe, and passes them to
 * the client.
 *
 * The unfiltered project list (for the total count) is the SAME `workspace.projects` read the
 * `[org]` layout prefetches for the shell, asked of the same per-request QueryClient, so it is one
 * read, not two; the layout already hands it to the client.
 *
 * The overview cards' reads are prefetched here (#6118, ADR 0005 D1) — `overview.usage` and
 * `overview.alerts` — in-process through the read router, with exactly the keys the cards ask for,
 * and hydrated by this page's own boundary, filtered to those reads (`isOverviewPageRead`): the
 * layout dehydrates when IT renders, which does not wait for this page's prefetches, and it already
 * hands down the shell's reads — this boundary does not serialize them a second time, with ONE
 * exception. A prefetch that fails is not dehydrated: that card alone renders its error (or retries
 * its read in the browser), and the rest of the page is unaffected (RUBRIC B5).
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
	const sp = await searchParams;

	const sort: ProjectListQuery["sort"] = sp.sort === "name" ? "name" : "activity";
	const view: ViewMode = sp.view === "table" ? "table" : "card";
	const state: OverviewState = {
		q: sp.q ?? "",
		clouds: toList(sp.cloud),
		repos: toList(sp.repo),
		sort,
		view,
	};

	const queryClient = getQueryClient();
	const rpc = serverOrpc();
	const [{ projects, facets }, allProjects, connectedProviders] = await Promise.all([
		queryProjects({ q: state.q, clouds: state.clouds, repos: state.repos, sort }),
		queryClient.fetchQuery(rpc.workspace.projects.queryOptions()),
		readConnectedCloudProviders(),
		// `retry: false`: the console's default `retry: 1` would hold the first byte ~1 s on a refusal
		// or a transient failure, and the card retries in the browser anyway. Not part of the key.
		queryClient.prefetchQuery(rpc.overview.usage.queryOptions({ retry: false })),
		queryClient.prefetchQuery(rpc.overview.alerts.queryOptions({ retry: false })),
		joinRecentJobs(queryClient, rpc),
	]);

	const dehydrated = dehydrate(queryClient, { shouldDehydrateQuery: isOverviewPageRead });
	const jobsPrefetched = dehydrated.queries.some((q) => isRecentJobsKey(q.queryKey));

	return (
		<HydrationBoundary state={dehydrated}>
			<OverviewClient
				orgSlug={org}
				projects={projects}
				facets={facets}
				state={state}
				totalCount={allProjects.length}
				connectedProviders={connectedProviders}
				jobsPrefetched={jobsPrefetched}
			/>
		</HydrationBoundary>
	);
}
