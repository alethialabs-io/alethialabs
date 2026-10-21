// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { HydrationBoundary, dehydrate } from "@tanstack/react-query";
import { notFound } from "next/navigation";
import { resolveProjectId } from "@/app/server/actions/resolve";
import { DEFAULT_JOBS_FILTERS, normalizeJobsQuery } from "@/components/jobs/jobs-query";
import { getQueryClient } from "@/lib/query/client";
import { filterStateFromUrl, paramReader } from "@/lib/query/filter-url-codec";
import { JOBS_DEFAULT_PRESET, jobsPageInputFrom } from "@/lib/rpc/inputs/jobs";
import { serverOrpc } from "@/lib/rpc/server";
import { pageMetadata } from "@/lib/seo/page-metadata";
import { JobsClient } from "../../~/jobs/jobs-client";

export const metadata = pageMetadata({
	title: "Jobs",
	description: "This project's provision job history and execution logs.",
});

/**
 * `/{org}/{project}/jobs` — the project's jobs: the org jobs table pinned to this project.
 *
 * Prefetches EXACTLY the key `JobsClient` reads on first paint — the `jobs.page` read for the URL's
 * filters, the default preset and this project (#6121) — exactly as `~/jobs/page.tsx` does. It used
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
	let projectId: string;
	try {
		projectId = await resolveProjectId(project);
	} catch {
		notFound();
	}

	const filters = filterStateFromUrl(paramReader(await searchParams), DEFAULT_JOBS_FILTERS);
	const input = jobsPageInputFrom(
		normalizeJobsQuery(filters, { from: "", to: "" }, projectId),
		{ preset: JOBS_DEFAULT_PRESET },
	);
	const queryClient = getQueryClient();
	await queryClient.prefetchQuery(serverOrpc().jobs.page.queryOptions({ input }));

	return (
		<HydrationBoundary state={dehydrate(queryClient)}>
			<JobsClient projectId={projectId} />
		</HydrationBoundary>
	);
}
