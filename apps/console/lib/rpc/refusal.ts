// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The browser's reading of the read router's typed refusals (ADR 0005 §10 R11, RUBRIC B4). A failed
// read is one of two different things, and a page must not render them alike:
//   · an EXPECTED refusal — FORBIDDEN, NOT_FOUND, ENTITLEMENT_REQUIRED, declared in `lib/rpc/base.ts`
//     and sent with its code — which answers the same every time, so it gets its own calm render
//     and no retry;
//   · a real failure, which gets `RegionError` and a retry.
// Here, inside `lib/rpc/`, because `@orpc/*` imports stay confined to it (ADR 0005 §10 D1).

import { ORPCError } from "@orpc/client";

/** The expected refusals a read can answer with. */
export type ReadRefusal = "forbidden" | "not-found" | "plan";

/** The read router's typed refusal behind a failed read, or null for a real failure. */
export function readRefusalOf(error: unknown): ReadRefusal | null {
	if (!(error instanceof ORPCError) || !error.defined) return null;
	if (error.code === "FORBIDDEN") return "forbidden";
	if (error.code === "NOT_FOUND") return "not-found";
	if (error.code === "ENTITLEMENT_REQUIRED") return "plan";
	return null;
}

/**
 * A query's `retry` that retries a real failure once and an expected refusal never: a refusal
 * answers the same the second time, so retrying it only delays the refused render.
 */
export function retryUnlessRefused(failureCount: number, error: unknown): boolean {
	return readRefusalOf(error) === null && failureCount < 1;
}
