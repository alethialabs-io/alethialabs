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
 * Still polls every 30s so a staff/AI reply surfaces in the bell and fires a toast: the real-time
 * client (#6115 PR B) is not on dev yet. The `support` topic already maps this key
 * (`lib/query/topics.ts`); when the bus lands the `refetchInterval` is deleted.
 */
export function useSupportCasesQuery(): UseQueryResult<CaseListItem[]> {
	return useQuery({
		...orpc.workspace.supportCases.queryOptions(),
		refetchInterval: 30_000,
	});
}
