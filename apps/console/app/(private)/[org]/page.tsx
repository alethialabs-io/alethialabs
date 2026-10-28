// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { HydrationBoundary, dehydrate } from "@tanstack/react-query";
import { queryProjects, type ProjectListQuery } from "@/app/server/actions/projects";
import { readConnectedCloudProviders } from "@/lib/rpc/procedures/connectors";
import { isOverviewRead } from "@/components/overview/overview-reads";
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
 * and hydrated by this page's own boundary, filtered to those reads (`isOverviewRead`): the layout
 * dehydrates when IT renders, which does not wait for this page's prefetches, and it already hands
 * down the shell's reads — this boundary does not serialize them a second time. The Recent-jobs card reads the shell's `workspace.recentJobs`,
 * which the layout prefetches. A prefetch that fails is not dehydrated: that card alone renders its
 * error (or retries its read in the browser), and the rest of the page is unaffected (RUBRIC B5).
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
	]);

	return (
		<HydrationBoundary state={dehydrate(queryClient, { shouldDehydrateQuery: isOverviewRead })}>
			<OverviewClient
				orgSlug={org}
				projects={projects}
				facets={facets}
				state={state}
				totalCount={allProjects.length}
				connectedProviders={connectedProviders}
			/>
		</HydrationBoundary>
	);
}
