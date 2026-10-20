// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { queryProjects, type ProjectListQuery } from "@/app/server/actions/projects";
import { getConnectedCloudProviders } from "@/app/server/actions/connectors";
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
 * read, not two; the layout already hands it to the client, so this page hydrates nothing itself.
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
	const [{ projects, facets }, allProjects, connectedProviders] = await Promise.all([
		queryProjects({ q: state.q, clouds: state.clouds, repos: state.repos, sort }),
		queryClient.fetchQuery(serverOrpc().workspace.projects.queryOptions()),
		getConnectedCloudProviders(),
	]);

	return (
		<OverviewClient
			orgSlug={org}
			projects={projects}
			facets={facets}
			state={state}
			totalCount={allProjects.length}
			connectedProviders={connectedProviders}
		/>
	);
}
