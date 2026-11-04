"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The support pages' reads (#6130, ADR 0005 D1): the `support.case` GET procedure (the case view)
// and the keys of every support read, under the same keys the routes prefetch through
// `serverOrpc()`, so the first paint carries the data and the browser asks for nothing on mount.
// ("My cases" keys its `support.cases` read inline in `case-list.tsx`, beside the normalized query
// it is keyed on — the filter standard's F3 reads that provenance in the surface's own module.)
//
// NO POLL. A case that changes — a staff or AI reply, a status move, a change of severity — is a
// `support` hint on the org's change stream (lib/db/programmables.sql → lib/realtime/routing.ts),
// which invalidates every key below (lib/query/topics.ts); while the stream is down the one
// sanctioned fallback poll covers them (lib/realtime/client/fallback-poll.ts).

import { type QueryKey, useQuery } from "@tanstack/react-query";
import { orpc } from "@/lib/rpc/client";

/** One case with its customer-visible thread and attachments. */
export function useCaseQuery(id: string) {
	return useQuery(orpc.support.case.queryOptions({ input: { id } }));
}

/** The key of one case's read — the composer patches it optimistically. */
export function caseKey(id: string): QueryKey {
	return orpc.support.case.queryKey({ input: { id } });
}

/**
 * Every key that shows a case: the case view, every "My cases" bucket and the shell's bell feed.
 * A support write invalidates all of them, so no screen keeps the old status or the old unread dot.
 */
export function supportCaseKeys(): QueryKey[] {
	return [orpc.support.key(), orpc.workspace.supportCases.key()];
}
