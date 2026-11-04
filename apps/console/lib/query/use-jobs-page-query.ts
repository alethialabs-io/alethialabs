"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The jobs PAGE query (#578 — the console filter standard): the normalized filter query is the
// key, filtering + facet counts happen server-side, keepPreviousData holds the previous rows
// (dimmed) while a filter change refetches.
//
// #6113 (ADR 0005 D1): the read is the `jobs.page` GET procedure, no longer a server-action POST,
// so it never queues behind other actions; the route prefetches the same key on the server.
//
// #6115: no poll. A job that changes is a `jobs` hint on the org's change stream, which invalidates
// this key (lib/query/topics.ts); while the stream is down the one fallback poll covers it
// (lib/realtime/client/fallback-poll.ts).

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { orpc } from "@/lib/rpc/client";
import type { JobsPageInput } from "@/lib/rpc/inputs/jobs";

/** Filtered rows + unfiltered facet counts + the true total for the jobs page. */
export function useJobsPageQuery(input: JobsPageInput) {
	return useQuery(
		orpc.jobs.page.queryOptions({
			input,
			placeholderData: keepPreviousData,
		}),
	);
}
