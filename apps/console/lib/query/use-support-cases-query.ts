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
 * Live through the real-time bus (ADR 0005 §7 Q3): the `support` topic invalidates this key
 * (`lib/query/topics.ts`), so a staff/AI reply surfaces in the bell and fires a toast with no poll.
 */
export function useSupportCasesQuery(): UseQueryResult<CaseListItem[]> {
	return useQuery(orpc.workspace.supportCases.queryOptions());
}
