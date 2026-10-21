// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// The runners grid, step 5 of the console filter standard (./README.md → "Server-side
// filters"): the normalized query IS the input, the read is the SERVER's filtered page, and
// previous rows are kept — and visibly dimmed by the caller — while the next answer loads.
//
// #6123 (ADR 0005 D1): the read is the `runners.page` GET procedure, no longer a server-action
// POST, and the route prefetches the same key on the server. No poll: a runner that changes is a
// `runners` hint on the org's change stream, which invalidates this key (lib/query/topics.ts);
// while the stream is down the one fallback poll covers it (lib/realtime/client/fallback-poll.ts).

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import type { RunnersQuery } from "@/lib/queries/runners";
import { orpc } from "@/lib/rpc/client";

/**
 * The org's runners for `query`, filtered SERVER-SIDE, with the cloud, region and version facets
 * counted over every runner the actor can see. `keepPreviousData` holds the grid across a filter
 * change; the caller dims off `isPlaceholderData`.
 *
 * @param query the `normalizeRunnersQuery()` output; `{}` is the pristine view
 */
export function useRunnersPageQuery(query: RunnersQuery = {}) {
	return useQuery(
		orpc.runners.page.queryOptions({
			input: query,
			placeholderData: keepPreviousData,
		}),
	);
}
