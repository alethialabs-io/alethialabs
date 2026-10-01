// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { unstable_rethrow } from "next/navigation";
import { NotOrgMemberError, UnauthorizedError } from "./errors";

/** What `[org]/layout.tsx` answers a failed org resolution with. */
export type OrgScopeFailure = "sign-in" | "not-found";

/**
 * Classifies what `resolveOrgScope` threw. Returns only for the two failures that have a page of
 * their own, and RETHROWS everything else.
 *
 * - `UnauthorizedError`: there is no session → `"sign-in"`.
 * - `NotOrgMemberError`: the session write found no membership → `"not-found"`. This covers a
 *   membership removed between `resolveOrgScope`'s lookup and its write.
 * - Next's own control flow is rethrown untouched by `unstable_rethrow`. That includes the
 *   `notFound()` `resolveOrgScope` throws for a slug that names no org the user is in, so that case
 *   still lands on the same 404. It also includes a redirect or a dynamic-rendering bailout, which
 *   the old catch-all also turned into a 404.
 * - Anything else — a dropped connection, a failed query, a bug — is rethrown as it is. It reaches
 *   the error boundary, and `onRequestError` (instrumentation.ts) logs it as an uncaught request
 *   error.
 *
 * The last branch is the change (#5001). The layout used to compare one message against
 * "Unauthorized" and `notFound()` every other throw. So a transient failure told a user their own
 * org "doesn't exist, or you don't have access to it", and the real error was not logged. That
 * copy is now used only when it is true, and the cases are told apart by class, not by message.
 *
 * The layout keeps its own `redirect()` and `notFound()` calls instead of having this module throw
 * them: `scripts/check-route-states.mjs` finds a layout's `notFound()` by reading the layout's
 * source, and would stop seeing this one if it moved here.
 */
export function classifyOrgScopeFailure(e: unknown): OrgScopeFailure {
	if (e instanceof UnauthorizedError) return "sign-in";
	if (e instanceof NotOrgMemberError) return "not-found";
	unstable_rethrow(e);
	throw e;
}
