// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { Actor } from "@/lib/authz/types";

/**
 * What every read procedure receives (ADR 0005 D1). The actor is resolved from the request's
 * address before the procedure runs — by the `/{org}/~/rpc` route handler for browser reads and by
 * the server caller (`lib/rpc/server.ts`) for RSC prefetch. The route handler also binds it with
 * `runWithActor`, so a reader's own `authorize()` reuses it; the server caller does not bind, and a
 * reader there resolves the same actor again from the same page request (same address, same user).
 */
export interface RpcContext {
	actor: Actor;
}
