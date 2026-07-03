// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import {
	useMutation,
	useQuery,
	useQueryClient,
	type UseQueryResult,
} from "@tanstack/react-query";
import { useParams } from "next/navigation";
import {
	cancelJob,
	getJob,
	getJobs,
	rerunJob,
	type JobWithMeta,
} from "@/app/server/actions/jobs";
import type { Job } from "@/lib/db/schema";
import { qk } from "./keys";

/** Job statuses that warrant fast polling (something is still moving). */
const ACTIVE_STATUSES = new Set(["QUEUED", "CLAIMED", "PROCESSING"]);

/**
 * Shared jobs cache. Every consumer (jobs page, command palette, breadcrumbs, overview
 * card, runners page, plan flow) calls this and TanStack Query dedupes them to a single
 * request keyed by org. Polls every 5s only while a job is in-flight, then idles —
 * replacing the old blanket `setInterval` timers.
 */
export function useJobsQuery(): UseQueryResult<JobWithMeta[]> {
	const { org } = useParams<{ org: string }>();
	return useQuery({
		queryKey: qk.jobs(org),
		queryFn: () => getJobs(),
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

/** Re-runs a job, then invalidates the jobs cache so the new row appears. */
export function useRerunJob() {
	const qc = useQueryClient();
	const { org } = useParams<{ org: string }>();
	return useMutation({
		mutationFn: (jobId: string) => rerunJob(jobId),
		onSuccess: () => qc.invalidateQueries({ queryKey: qk.jobs(org) }),
	});
}

/** Cancels a job, then invalidates the jobs cache to reflect the new status. */
export function useCancelJob() {
	const qc = useQueryClient();
	const { org } = useParams<{ org: string }>();
	return useMutation({
		mutationFn: (jobId: string) => cancelJob(jobId),
		onSuccess: () => qc.invalidateQueries({ queryKey: qk.jobs(org) }),
	});
}
