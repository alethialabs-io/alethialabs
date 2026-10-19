"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The jobs PAGE query (#578 — the console filter standard): the normalized filter query is the
// key, filtering + facet counts happen server-side, keepPreviousData holds the previous rows
// (dimmed) while a filter change refetches.
//
// #6113 (ADR 0005 D1): the read is the `jobs.page` GET procedure, no longer a server-action POST,
// so it never queues behind other actions; the route prefetches the same key on the server.

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { orpc } from "@/lib/rpc/client";
import type { JobsPageInput } from "@/lib/rpc/inputs/jobs";

/** Statuses that warrant fast polling (mirrors useJobsQuery's cadence). */
const ACTIVE_STATUSES = new Set(["QUEUED", "CLAIMED", "PROCESSING"]);

/** Filtered rows + unfiltered facet counts + the true total for the jobs page. */
export function useJobsPageQuery(input: JobsPageInput) {
	return useQuery(
		orpc.jobs.page.queryOptions({
			input,
			placeholderData: keepPreviousData,
			// Poll fast only while something in view is still moving, then idle. #6115 replaces this
			// with the jobs real-time topic and deletes it.
			refetchInterval: (q) =>
				q.state.data?.rows.some((j) => ACTIVE_STATUSES.has(j.status)) ? 5_000 : 30_000,
		}),
	);
}
