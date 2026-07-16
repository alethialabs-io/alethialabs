"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The jobs PAGE query (#578 — the console filter standard): the normalized filter query
// is the key, filtering + facet counts happen server-side (getJobsPage), keepPreviousData
// holds the previous rows (dimmed) while a filter change refetches. The shared unfiltered
// `useJobsQuery` cache (palette, breadcrumbs, overview, runners, plan flow) is untouched.

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useParams } from "next/navigation";
import { getJobsPage, type JobsQuery } from "@/app/server/actions/jobs";
import { qk } from "@/lib/query/keys";

/** Statuses that warrant fast polling (mirrors useJobsQuery's cadence). */
const ACTIVE_STATUSES = new Set(["QUEUED", "CLAIMED", "PROCESSING"]);

/** Filtered rows + unfiltered facet counts + the true total for the jobs page. */
export function useJobsPageQuery(query: JobsQuery) {
	const { org } = useParams<{ org: string }>();
	return useQuery({
		queryKey: qk.jobsPage(org, query),
		queryFn: () => getJobsPage(query),
		placeholderData: keepPreviousData,
		// Poll fast only while something in view is still moving, then idle (the shared
		// jobs cache's rule, applied to the filtered page).
		refetchInterval: (q) =>
			q.state.data?.rows.some((j) => ACTIVE_STATUSES.has(j.status)) ? 5_000 : 30_000,
	});
}
