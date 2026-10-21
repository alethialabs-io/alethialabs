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
 * NO POLL (#6130). A staff or AI reply moves the case row, which the `support_cases` trigger turns
 * into a `support` hint on the change stream for the people who can see that case (the requester,
 * and the org's `manage_support` holders — lib/realtime/routing.ts); the hint invalidates this key
 * (`lib/query/topics.ts`), so the bell and the toaster update within about a second. While the
 * stream is down the one sanctioned fallback poll covers it (lib/realtime/client/fallback-poll.ts).
 */
export function useSupportCasesQuery(): UseQueryResult<CaseListItem[]> {
	return useQuery(orpc.workspace.supportCases.queryOptions());
}
