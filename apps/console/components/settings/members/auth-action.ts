// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

"use client";

// The organization plugin's own writes — invite, change a member's role, remove a member, cancel
// an invitation, create/delete a team, add/remove a team member — stay where they are: the browser
// calls Better Auth's `/api/auth/organization/*` endpoints, so every guard on that route and every
// plugin hook (`beforeCreateInvitation`, `beforeCreateTeam`, the PDP gate in the auth handler)
// runs exactly as before (#6129). What changes is how the page HEARS the answer: Better Auth
// resolves `{ data, error }` rather than throwing, and the members page used to discard `error`
// for three of its controls, so a refused role change looked like a successful one. This adapter
// turns that answer into the console's `ActionResult`, so these writes go through
// `useActionMutation` like every other one — pending state, one toast policy, invalidation.

import type { ActionError, ActionResult } from "@/lib/actions/result";

/** The part of a Better Auth client error this adapter reads. */
interface AuthCallError {
	status: number;
	message?: string;
}

/** What every Better Auth client call resolves to, as far as this adapter is concerned. */
interface AuthCallResult {
	error: AuthCallError | null | undefined;
}

/**
 * Maps a refused Better Auth call onto the console's error kinds. The plugin's messages are
 * written for people ("User is already a member of this organization"), so a 4xx carries its
 * message; a 5xx does not — it becomes `unexpected`, whose toast never shows server text.
 */
export function authActionError(error: AuthCallError): ActionError {
	const message = error.message?.trim() || "That change was refused.";
	// Status 0 is the fetch client's report of a request that got no HTTP answer at all.
	if (error.status === 0) return { kind: "network", sent: true };
	if (error.status === 401) return { kind: "unauthenticated" };
	if (error.status === 403) return { kind: "forbidden", message };
	if (error.status === 404) return { kind: "not-found", message };
	if (error.status >= 400 && error.status < 500) return { kind: "conflict", message };
	return { kind: "unexpected", ref: `auth-${error.status}` };
}

/**
 * Runs one Better Auth client call and answers in the console's `ActionResult` shape. A call that
 * throws got no server answer — the connection dropped, or a proxy answered instead of the app — so
 * it is `network` with `sent: true`: the request may have left the browser, and whether it took
 * effect is unknown. The mutation contract tells the person exactly that, and refetches what the
 * page shows so it matches what the server holds. It is never a success, and never "something went
 * wrong on our side" with a reference that names no server event (R6 E-07).
 */
export async function viaAuth(call: () => Promise<AuthCallResult>): Promise<ActionResult<null>> {
	try {
		const { error } = await call();
		if (error) return { ok: false, error: authActionError(error) };
		return { ok: true, data: null };
	} catch {
		return { ok: false, error: { kind: "network", sent: true } };
	}
}
