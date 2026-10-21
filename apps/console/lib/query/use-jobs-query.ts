// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { useParams } from "next/navigation";
import type { JobWithMeta } from "@/app/server/actions/jobs";
import { orpc, rpcClient } from "@/lib/rpc/client";
import type { ShellJob } from "@/lib/rpc/procedures/workspace";
import { qk } from "./keys";

/**
 * The shell's job feed: the org's newest jobs, capped and slim (`workspace.recentJobs`). The bell,
 * the job toasts, the breadcrumbs, the command palette and the overview's recent-jobs card read it;
 * the `[org]` layout prefetches it, so first paint issues no request. Live through the `jobs` topic
 * (`lib/query/topics.ts`), with no poll.
 */
export function useRecentJobsQuery(): UseQueryResult<ShellJob[]> {
	return useQuery(orpc.workspace.recentJobs.queryOptions());
}

/**
 * The org's FULL job list (`workspace.jobs`), for the pages that need all of it — runners (active
 * jobs with their config) and the plan flow. Not prefetched by the layout: it grows with the org's
 * history. Live through the `jobs` topic, whose `["jobs"]` prefix reaches this `qk.jobs(org)` key.
 */
export function useJobsQuery(): UseQueryResult<JobWithMeta[]> {
	const { org } = useParams<{ org: string }>();
	return useQuery({
		queryKey: qk.jobs(org),
		queryFn: () => rpcClient.workspace.jobs(),
	});
}
