// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

"use client";

// The connectors board's read helpers (#6124, ADR 0005 D1); the hook itself is
// lib/query/use-connectors-query.ts, beside the console's other per-resource hooks. Kept live by the `connectors` topic on
// the org's change stream (lib/query/topics.ts) — the 30 s `router.refresh()` loop it replaces
// re-rendered the whole route twice a minute whether anything had changed or not.

import { ORPCError } from "@orpc/client";
import type { QueryKey } from "@tanstack/react-query";
import { orpc } from "@/lib/rpc/client";

/**
 * Every query key that shows what a connector write changes: the board itself, and the setup
 * guide's "connect a cloud" step. A connect, re-verify, rename or disconnect invalidates these.
 */
export function connectorKeys(): QueryKey[] {
	return [orpc.connectors.key(), orpc.workspace.setupGuide.key()];
}

/**
 * The HTTP statuses the read route answers on its own, as plain JSON, before oRPC sees the request:
 * 401 for a request with no session, 403 for an actor the route refuses (`app/(private)/[org]/~/rpc`).
 * They reach the client as NON-defined oRPC errors that carry only the status, so the status is
 * what is read — as `components/providers/viewer-provider.tsx` reads a 401 as "signed out".
 */
const REFUSAL_STATUSES: ReadonlySet<number> = new Set([401, 403]);

/**
 * The board's retry rule: one retry for a failure, none for a typed refusal or a refusal the route
 * answered itself — a FORBIDDEN or a 401 answers the same the second time, so retrying it only
 * delays the refused render.
 */
export function retryUnlessRefused(failureCount: number, error: unknown): boolean {
	if (isRefused(error)) return false;
	return !(error instanceof ORPCError && error.defined) && failureCount < 1;
}

/**
 * Whether the board's read was refused because the viewer may not see it: a typed FORBIDDEN /
 * UNAUTHORIZED from a procedure, or a plain 401/403 the read route answered before any procedure ran.
 */
export function isRefused(error: unknown): boolean {
	if (!(error instanceof ORPCError)) return false;
	if (error.defined) return error.code === "FORBIDDEN" || error.code === "UNAUTHORIZED";
	return REFUSAL_STATUSES.has(error.status);
}
