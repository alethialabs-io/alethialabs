// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Settings · Members, step 5 of the console filter standard (./README.md → "Server-side
// filters"): the normalized query IS the input (and so the key), the fetch is the SERVER's
// filtered read, and previous rows are kept — and visibly dimmed by the caller — while the next
// answer loads.
//
// #6129 (ADR 0005 D1): the read is the `members.page` GET procedure, no longer a server-action
// POST; the route prefetches the same key in-process, so the first paint carries the rows.
// Live: a `members` hint (a member, invitation or team changed) invalidates every `members.*`
// read (lib/query/topics.ts) — there is no poll.
//
// ONE call returns BOTH record kinds on purpose: the table is one list of members and
// invitations, a `statuses: ["pending"]` selection is an invitations-only answer, and a team
// filter excludes invitations entirely (an invitation has no teams).

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import type { MembersQuery } from "@/lib/queries/members";
import { orpc } from "@/lib/rpc/client";

/**
 * The org's members and pending invitations, filtered SERVER-SIDE, with the status, role and team
 * facets counted over every member and invitation in the org.
 *
 * @param query the normalized filter query; `{}` is the pristine view
 */
export function useMembersPageQuery(query: MembersQuery = {}) {
	return useQuery(
		orpc.members.page.queryOptions({ input: query, placeholderData: keepPreviousData }),
	);
}

/**
 * The Members page's gate — whether this org may invite and manage, with the reason inviting is
 * closed — resolved on the server and prefetched by the route, so the toolbar's first paint is
 * already right (F017).
 */
export function useMembersGateQuery() {
	return useQuery(orpc.members.gate.queryOptions({ input: undefined }));
}

/** The invite dialog's context (seat figures, taken emails); read only while the dialog is open. */
export function useInviteContextQuery(enabled: boolean) {
	return useQuery(orpc.members.inviteContext.queryOptions({ input: undefined, enabled }));
}
