// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The overview cards' refusal helpers: how a card tells a typed refusal (lib/rpc/base.ts) from a
// failure. No "use client" and no server imports.

import { ORPCError } from "@orpc/client";
import type { Query } from "@tanstack/react-query";

/**
 * Whether a cached query is one of the overview page's own reads (`overview.*`), and settled — the
 * page's `dehydrate` filter. The server QueryClient is one per request (`cache()`), shared with the
 * `[org]` layout, which already hands its shell reads (`workspace.*`) to the client through its own
 * boundary (`isShellRead`, app/(private)/[org]/layout.tsx); without this filter the page would
 * serialize those reads into its HTML a second time.
 */
export function isOverviewRead(query: Pick<Query, "queryKey" | "state">): boolean {
	const [path] = query.queryKey;
	return query.state.status === "success" && Array.isArray(path) && path[0] === "overview";
}

/**
 * The cards' `retry`: one retry for a failure, none for an expected refusal. A typed refusal
 * (FORBIDDEN, NOT_FOUND, …) answers the same the second time, so retrying it only delays the
 * card's forbidden render.
 */
export function retryUnlessRefused(failureCount: number, error: unknown): boolean {
	return !isRefusal(error) && failureCount < 1;
}

/** Whether a read failed with one of the read router's typed refusals (lib/rpc/base.ts). */
function isRefusal(error: unknown): boolean {
	return error instanceof ORPCError && error.defined;
}

/** Whether a read was refused because the viewer lacks the permission to see it. */
export function isForbidden(error: unknown): boolean {
	return isRefusal(error) && error instanceof ORPCError && error.code === "FORBIDDEN";
}
