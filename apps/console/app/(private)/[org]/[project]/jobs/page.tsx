// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { HydrationBoundary, dehydrate } from "@tanstack/react-query";
import { notFound } from "next/navigation";
import { DEFAULT_JOBS_FILTERS, normalizeJobsQuery } from "@/components/jobs/jobs-query";
import { resolveProjectOr404 } from "@/lib/projects/resolve-project-or-404";
import { getQueryClient } from "@/lib/query/client";
import { filterStateFromUrl, paramReader } from "@/lib/query/filter-url-codec";
import { serverOrpc } from "@/lib/rpc/server";
import { pageMetadata } from "@/lib/seo/page-metadata";
import { JobsClient } from "../../~/jobs/jobs-client";

export const metadata = pageMetadata({
	title: "Jobs",
	description: "This project's provision job history and execution logs.",
});

/**
 * `/{org}/{project}/jobs` — the project's jobs: the jobs table scoped to this project, so its
 * facet counts, its total and its first-run state are the project's own.
 *
 * Prefetches EXACTLY the key `JobsClient` reads on first paint — the `jobs.page` read for the URL's
 * filters (the date range among them) and this project (#6121) — exactly as
 * `~/jobs/(list)/page.tsx` does. It used
 * to prefetch the unfiltered `qk.jobs` list while the client read the page key, so the first paint
 * showed "No results." while a second request ran (F022). `loading.tsx` covers the prefetch window.
 */
export default async function ProjectJobsRoute({
	params,
	searchParams,
}: {
	params: Promise<{ org: string; project: string }>;
	searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
	const { project } = await params;
	// Null is the project 404; a lost session or a real failure never reaches this line.
	const projectId = (await resolveProjectOr404(project)) ?? notFound();

	const filters = filterStateFromUrl(paramReader(await searchParams), DEFAULT_JOBS_FILTERS);
	// The project is the list's scope: it reaches the read as its own field, never as a filter.
	const input = normalizeJobsQuery(filters, projectId);
	const queryClient = getQueryClient();
	await queryClient.prefetchQuery(serverOrpc().jobs.page.queryOptions({ input }));

	return (
		<HydrationBoundary state={dehydrate(queryClient)}>
			<JobsClient projectId={projectId} />
		</HydrationBoundary>
	);
}
