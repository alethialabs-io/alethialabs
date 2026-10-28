// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The people & access pages' shared read helpers (#6129): what a route dehydrates, and how a region
// tells a typed refusal (lib/rpc/base.ts) from a failure. No "use client" and no server imports, so
// both the routes and the client components read them.

import { ORPCError } from "@orpc/client";
import type { Query } from "@tanstack/react-query";

/**
 * Whether a cached query is one of the people & access reads (`members.*`), and settled — the
 * pages' `dehydrate` filter. The server QueryClient is one per request, shared with the `[org]`
 * layout, which already hands its shell reads to the client through its own boundary; without this
 * filter the page would serialize those a second time.
 */
export function isPeopleRead(query: Pick<Query, "queryKey" | "state">): boolean {
	const [path] = query.queryKey;
	return query.state.status === "success" && Array.isArray(path) && path[0] === "members";
}

/** Whether a read failed with one of the read router's typed refusals. */
function isRefusal(error: unknown): error is ORPCError<string, unknown> {
	return error instanceof ORPCError && error.defined;
}

/** Whether a read was refused because the viewer lacks the permission to see it. */
export function isForbiddenRead(error: unknown): boolean {
	return isRefusal(error) && error.code === "FORBIDDEN";
}

/**
 * A query's `retry`: one retry for a failure, none for an expected refusal — a refusal answers the
 * same the second time, so retrying it only delays the region's forbidden render.
 */
export function retryUnlessRefused(failureCount: number, error: unknown): boolean {
	return !isRefusal(error) && failureCount < 1;
}
