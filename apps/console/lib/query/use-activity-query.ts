"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The member list the Activity feed names its actors from (and the jobs list its authors, and the
// team dialog its picker). The feed's own rows are no longer read here: since LST-10 (#7492) the
// Activity log reads `activity.page` through the shared `useKeysetList` (lib/query/use-keyset-list.ts)
// directly in `components/settings/activity/activity-log.tsx`, like every other keyset list.

import { useQuery } from "@tanstack/react-query";
import { orpc } from "@/lib/rpc/client";

/**
 * Org members — filter facets + the humanizer's name resolution, and the jobs list's authors.
 * The `members.list` GET procedure (#6129, ADR 0005 D1), cached once per org; a `members` hint
 * invalidates it (lib/query/topics.ts).
 */
export function useMembersQuery() {
	return useQuery(orpc.members.list.queryOptions({ input: undefined, staleTime: 60_000 }));
}
