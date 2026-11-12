// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { readRefusalOf } from "@/lib/rpc/refusal";

/**
 * Where a read stands, as the surface rendering it must tell the cases apart (#6114, RUBRIC B4):
 *
 * - `pending`: no answer yet;
 * - `ready`: an answer, which may be an EMPTY list — a fact about the data;
 * - `error`: the read failed and asking again may help (render `RegionError` with a retry);
 * - `forbidden`: the read router REFUSED it with a typed refusal (FORBIDDEN, NOT_FOUND,
 *   ENTITLEMENT_REQUIRED), which answers the same every time, so it gets a calm note and no retry.
 *
 * The shell's switchers and bell used to read `data ?? []`, which folded all four into one: a failed
 * or refused read rendered as "No projects yet." or "You're all caught up!".
 */
export type ReadStatus = "pending" | "ready" | "error" | "forbidden";

/** The parts of a TanStack query result that decide its {@link ReadStatus}. */
export interface StatusQuery {
	data: unknown;
	isError?: boolean;
	error?: unknown;
}

/**
 * The status of `query`. Data wins: a background refetch that failed keeps its last answer on
 * screen as `ready`, because what is shown is still true as of its fetch. Only a query with nothing
 * to show is `error` or `forbidden`.
 */
export function readStatusOf(query: StatusQuery): ReadStatus {
	if (query.data !== undefined) return "ready";
	if (query.isError) return readRefusalOf(query.error) === null ? "error" : "forbidden";
	return "pending";
}
