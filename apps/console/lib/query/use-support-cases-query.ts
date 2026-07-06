// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { listMyCases } from "@/app/server/actions/support";
import type { CaseListItem } from "@/lib/queries/support";
import { qk } from "./keys";

/**
 * Shared support-cases cache. The notifications bell and the live toaster both call this and
 * TanStack Query dedupes them (plus the "My cases" list's `qk.supportCases("all")` query) to a
 * single request. Cases are owner-scoped server-side, so — unlike jobs — the key isn't org
 * scoped; it reuses the same `"all"` key the "My cases" page prefetches. Polls every 30s so a
 * staff/AI reply surfaces in the bell and fires a toast without a manual refresh.
 */
export function useSupportCasesQuery(): UseQueryResult<CaseListItem[]> {
	return useQuery({
		queryKey: qk.supportCases("all"),
		queryFn: () => listMyCases({}),
		refetchInterval: 30_000,
	});
}
