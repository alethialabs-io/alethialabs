// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { useParams } from "next/navigation";
import { getJob, type JobWithMeta } from "@/app/server/actions/jobs";
import type { Job } from "@/lib/db/schema";
import { orpc } from "@/lib/rpc/client";
import { qk } from "./keys";

/** Job statuses that warrant fast polling (something is still moving). */
const ACTIVE_STATUSES = new Set(["QUEUED", "CLAIMED", "PROCESSING"]);

/**
 * The shell's job feed, over the read router's `workspace.jobs` (GET). Every consumer (the job
 * toasts, the bell, breadcrumbs, command palette, overview card, runners page) shares this one
 * cache entry; the `[org]` layout prefetches it, so first paint issues no request. The org is the
 * browser cache's partition (`lib/query/client.ts`), so the key needs none of its own.
 *
 * Still polls every 5s while a job is in flight, then idles: the real-time client (#6115 PR B) is
 * not on dev yet. The `jobs` topic already maps this key (`lib/query/topics.ts`), so when the bus
 * lands this `refetchInterval` is deleted, not replaced.
 */
export function useJobsQuery(): UseQueryResult<JobWithMeta[]> {
	return useQuery({
		...orpc.workspace.jobs.queryOptions(),
		refetchInterval: (query) => {
			const data = query.state.data;
			return data?.some((j) => ACTIVE_STATUSES.has(j.status)) ? 5_000 : false;
		},
	});
}

/**
 * A single job by id, for the detail page. Polls every 3s while the job is in-flight,
 * then idles once it reaches a terminal status — replacing the manual status `setInterval`.
 */
export function useJobQuery(jobId: string): UseQueryResult<Job | null> {
	const { org } = useParams<{ org: string }>();
	return useQuery({
		queryKey: qk.job(org, jobId),
		queryFn: () => getJob(jobId),
		enabled: !!jobId,
		refetchInterval: (query) => {
			const status = query.state.data?.status;
			return status === "QUEUED" ||
				status === "CLAIMED" ||
				status === "PROCESSING"
				? 3_000
				: false;
		},
	});
}
