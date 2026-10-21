// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

"use client";

// The connectors board's read (#6124, ADR 0005 D1): one `connectors.board` GET, prefetched by the
// route and hydrated, so the first paint carries the catalog. Kept live by the `connectors` topic on
// the org's change stream (lib/query/topics.ts) — the 30 s `router.refresh()` loop it replaces
// re-rendered the whole route twice a minute whether anything had changed or not.

import { ORPCError } from "@orpc/client";
import { type QueryKey, useQuery } from "@tanstack/react-query";
import { orpc } from "@/lib/rpc/client";

/**
 * Every query key that shows what a connector write changes: the board itself, and the setup
 * guide's "connect a cloud" step. A connect, re-verify, rename or disconnect invalidates these.
 */
export function connectorKeys(): QueryKey[] {
	return [orpc.connectors.key(), orpc.workspace.setupGuide.key()];
}

/**
 * The board's retry rule: one retry for a failure, none for a typed refusal — a FORBIDDEN answers
 * the same the second time, so retrying it only delays the forbidden render.
 */
function retryUnlessRefused(failureCount: number, error: unknown): boolean {
	return !(error instanceof ORPCError && error.defined) && failureCount < 1;
}

/** Whether the board's read was refused because the viewer may not see it. */
export function isRefused(error: unknown): boolean {
	return (
		error instanceof ORPCError &&
		error.defined &&
		(error.code === "FORBIDDEN" || error.code === "UNAUTHORIZED")
	);
}

/**
 * The board read. `staleTime` is minutes, not the console's 30 s default: a change the viewer did
 * not make arrives as a `connectors` hint, and the viewer's own writes invalidate it directly.
 */
export function useConnectorsBoard() {
	return useQuery(
		orpc.connectors.board.queryOptions({
			staleTime: 5 * 60_000,
			retry: retryUnlessRefused,
		}),
	);
}
