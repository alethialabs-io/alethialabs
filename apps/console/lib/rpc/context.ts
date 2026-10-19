// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { Actor } from "@/lib/authz/types";

/**
 * What every read procedure receives (ADR 0005 D1). The actor is resolved ONCE, from the request's
 * address, before the procedure runs — by the `/{org}/~/rpc` route handler for browser reads and by
 * the server caller for RSC prefetch — and is also bound with `runWithActor`, so `authorize()` /
 * `currentActor()` inside an existing read reuse it instead of re-reading the session.
 */
export interface RpcContext {
	actor: Actor;
}
