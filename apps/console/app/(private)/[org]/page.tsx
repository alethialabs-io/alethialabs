// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { HydrationBoundary, dehydrate } from "@tanstack/react-query";
import {
	getProjects,
	queryProjects,
	type ProjectListQuery,
} from "@/app/server/actions/projects";
import { getQueryClient } from "@/lib/query/client";
import { pageMetadata } from "@/lib/seo/page-metadata";
import { seedClassificationAssignments } from "@/lib/query/prefetch-classification";
import { qk } from "@/lib/query/keys";
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
 * the client. Also keeps the shared unfiltered projects cache (`qk.projects`) warm for the project
 * switcher / command palette / breadcrumbs, and seeds classification chips for the visible rows.
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
	const [{ projects, facets }, allProjects] = await Promise.all([
		queryProjects({ q: state.q, clouds: state.clouds, repos: state.repos, sort }),
		getProjects(),
	]);
	// Keep the shared (unfiltered) projects cache warm for the switcher / palette / breadcrumbs.
	queryClient.setQueryData(qk.projects(org), allProjects);
	// Batch-seed each visible card's classification chips (one round-trip, no per-card fetch).
	await seedClassificationAssignments(
		queryClient,
		"project",
		projects.map((p) => p.id),
	);

	return (
		<HydrationBoundary state={dehydrate(queryClient)}>
			<OverviewClient
				orgSlug={org}
				projects={projects}
				facets={facets}
				state={state}
				totalCount={allProjects.length}
			/>
		</HydrationBoundary>
	);
}
