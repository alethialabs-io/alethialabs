// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Settings · Members' two non-list reads: the page's gate and the invite dialog's context. The list
// itself pages through `useKeysetList(orpc.members.page, …)` in the table (lib/query/README.md →
// "Paging"; LST-8 #7490), which is where the filter standard's list wiring lives.
//
// #6129 (ADR 0005 D1): both are GET procedures; the route prefetches the gate. Live: a `members`
// hint (a member, invitation or team changed) invalidates every `members.*` read
// (lib/query/topics.ts) — there is no poll.

import { useQuery } from "@tanstack/react-query";
import { orpc } from "@/lib/rpc/client";

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
