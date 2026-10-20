// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { useParams } from "next/navigation";
import { getJob, type JobWithMeta } from "@/app/server/actions/jobs";
import type { Job } from "@/lib/db/schema";
import { rpcClient } from "@/lib/rpc/client";
import { qk } from "./keys";

/** Job statuses that warrant fast polling (something is still moving). */
const ACTIVE_STATUSES = new Set(["QUEUED", "CLAIMED", "PROCESSING"]);

/**
 * The shell's job feed, read over the read router's `workspace.jobs` (GET). Every consumer (the job
 * toasts, the bell, breadcrumbs, command palette, overview card, runners page) shares this one
 * cache entry; the `[org]` layout prefetches it, so first paint issues no request.
 *
 * THE KEY STAYS `qk.jobs(org)`, NOT THE oRPC KEY, and the poll stays, until the real-time client
 * (#6178) is on dev: the jobs pages follow THIS entry's poll for their live updates (#6121's
 * `useFollowJobsPoll`), so moving the key or deleting the poll first would silently stop them.
 * The `jobs` topic already reaches this key (`lib/query/topics.ts`); when the bus lands the
 * `refetchInterval` is deleted. Polls every 5s only while a job is in flight, then idles.
 */
export function useJobsQuery(): UseQueryResult<JobWithMeta[]> {
	const { org } = useParams<{ org: string }>();
	return useQuery({
		queryKey: qk.jobs(org),
		queryFn: () => rpcClient.workspace.jobs(),
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
