// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import "server-only";

import type { QueryClient } from "@tanstack/react-query";
import { DEFAULT_JOBS_FILTERS, normalizeJobsQuery } from "@/components/jobs/jobs-query";
import { filterStateFromUrl, type ParamReader } from "@/lib/query/filter-url-codec";
import { retryUnlessRefused } from "@/lib/rpc/refusal";
import { serverOrpc } from "@/lib/rpc/server";

/**
 * Both jobs routes' prefetch, shared so the two cannot drift apart: the FIRST page of `jobs.page`
 * for the link's filters (and, on a project's route, the project as the scope), under EXACTLY the
 * infinite key `useKeysetList(orpc.jobs.page, normalizeJobsQuery(…))` asks for on first paint. oRPC
 * builds that key from `input(initialPageParam)`, and the initial page param is null on both sides,
 * so the key is the normalized query alone — the cursor is never in it (lib/query/README.md →
 * "Paging": a route that prefetches the first page uses `prefetchInfiniteQuery` with the same
 * `infiniteOptions`).
 */
export async function prefetchJobsList(queryClient: QueryClient, params: ParamReader, projectId?: string) {
	const query = normalizeJobsQuery(filterStateFromUrl(params, DEFAULT_JOBS_FILTERS), projectId);
	await queryClient.prefetchInfiniteQuery(
		serverOrpc().jobs.page.infiniteOptions({
			input: (cursor: string | null) => (cursor === null ? query : { ...query, cursor }),
			initialPageParam: null,
			getNextPageParam: (last) => last.nextCursor,
			retry: retryUnlessRefused,
		}),
	);
}
