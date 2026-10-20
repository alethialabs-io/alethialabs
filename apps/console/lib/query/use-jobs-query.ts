// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { useParams } from "next/navigation";
import { getJob, type JobWithMeta } from "@/app/server/actions/jobs";
import type { Job } from "@/lib/db/schema";
import { rpcClient } from "@/lib/rpc/client";
import { qk } from "./keys";

/**
 * The shell's job feed, read over the read router's `workspace.jobs` (GET). Every consumer (the job
 * toasts, the bell, breadcrumbs, command palette, overview card, runners page) shares this one
 * cache entry; the `[org]` layout prefetches it, so first paint issues no request.
 *
 * Live through the real-time bus, not a poll (ADR 0005 §7 Q3): the `jobs` topic invalidates every
 * `qk.jobs*` key by its `["jobs"]` prefix (`lib/query/topics.ts`), so a job changing anywhere in the
 * org refetches this feed. The key stays `qk.jobs(org)` because the jobs pages share its entry.
 */
export function useJobsQuery(): UseQueryResult<JobWithMeta[]> {
	const { org } = useParams<{ org: string }>();
	return useQuery({
		queryKey: qk.jobs(org),
		queryFn: () => rpcClient.workspace.jobs(),
	});
}

/**
 * A single job by id, for the detail page. Live through the `jobs` topic, whose `["jobs"]` prefix
 * reaches `qk.job` — the 3 s in-flight poll it used to run is gone (#6114).
 */
export function useJobQuery(jobId: string): UseQueryResult<Job | null> {
	const { org } = useParams<{ org: string }>();
	return useQuery({
		queryKey: qk.job(org, jobId),
		queryFn: () => getJob(jobId),
		enabled: !!jobId,
	});
}
