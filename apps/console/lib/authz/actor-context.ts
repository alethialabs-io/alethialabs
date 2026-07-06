// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { AsyncLocalStorage } from "node:async_hooks";
import type { Actor } from "./types";

/**
 * The actor seam (B7). Identity normally comes from the Better Auth session
 * (cookies/headers), which only exists inside a Next.js request. Out-of-session
 * consumers — the MCP server's tool calls (authenticated by an OAuth access token,
 * not a cookie) — resolve their actor themselves and bind it here, so the *same*
 * server-action surface that the dashboard uses runs unchanged under their identity.
 *
 * This adds NO new authority: the bound actor still came from getActiveScope() and
 * every action it reaches still enforces its PDP verb. It only swaps where the
 * already-resolved actor comes from.
 */
const actorStore = new AsyncLocalStorage<Actor>();

/**
 * Runs `fn` with `actor` bound to the async context. currentActor()/requireOwner()
 * inside `fn` (and anything it awaits) return this actor instead of reading the
 * session. Used by the MCP route after it resolves the actor from the access token.
 */
export function runWithActor<T>(actor: Actor, fn: () => Promise<T>): Promise<T> {
	return actorStore.run(actor, fn);
}

/** The actor bound to the current async context, or undefined (→ session resolution). */
export function getInjectedActor(): Actor | undefined {
	return actorStore.getStore();
}
