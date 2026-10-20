// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import type { CaseListItem } from "@/lib/queries/support";
import { orpc } from "@/lib/rpc/client";

/**
 * The shell's support-case feed, over the read router's `workspace.supportCases` (GET). The
 * notifications bell and the live toaster share this one entry, and the `[org]` layout prefetches
 * it. The read is scoped to the ADDRESS's org (the actor the read router resolves), and the browser
 * keeps one cache per org (`lib/query/client.ts`), so org A's cases are never rendered under B.
 *
 * STILL POLLS every 30 s, so a staff/AI reply reaches the bell and fires a toast. The `support` topic
 * maps this key (`lib/query/topics.ts`), but nothing PRODUCES that topic yet: the server routes no
 * change to it until #6130 adds the support trigger. Delete the `refetchInterval` with that PR.
 */
export function useSupportCasesQuery(): UseQueryResult<CaseListItem[]> {
	return useQuery({
		...orpc.workspace.supportCases.queryOptions(),
		refetchInterval: 30_000,
	});
}
