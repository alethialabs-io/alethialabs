// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { HydrationBoundary, dehydrate } from "@tanstack/react-query";
import { notFound } from "next/navigation";
import { getJobs } from "@/app/server/actions/jobs";
import { resolveProjectId } from "@/app/server/actions/resolve";
import { getQueryClient } from "@/lib/query/client";
import { qk } from "@/lib/query/keys";
import { pageMetadata } from "@/lib/seo/page-metadata";
import { JobsClient } from "../../~/jobs/jobs-client";

export const metadata = pageMetadata({
	title: "Jobs",
	description: "This project's provision job history and execution logs.",
});

/**
 * `/{org}/{project}/jobs` — the project's jobs. Reuses the org jobs table scoped to this
 * project: prefetches the shared org jobs list (the same `qk.jobs(org)` cache the shell already
 * warms) and hands `JobsClient` the resolved project id, which filters to it and drops the
 * Project facet. `loading.tsx` covers the prefetch window.
 */
export default async function ProjectJobsRoute({
	params,
}: {
	params: Promise<{ org: string; project: string }>;
}) {
	const { org, project } = await params;
	let projectId: string;
	try {
		projectId = await resolveProjectId(project);
	} catch {
		notFound();
	}

	const queryClient = getQueryClient();
	await queryClient.prefetchQuery({
		queryKey: qk.jobs(org),
		queryFn: () => getJobs(),
	});

	return (
		<HydrationBoundary state={dehydrate(queryClient)}>
			<JobsClient projectId={projectId} />
		</HydrationBoundary>
	);
}
