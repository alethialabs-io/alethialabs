// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// What signing out of the console does, in order, as one function with its effects passed in — so
// the order and the failure path are unit tested without a browser or an auth server
// (`tests/components/shell/sign-out.test.ts`).
//
// The order is the point:
//
//   1. The session is ended on the server. The auth client ANSWERS a failure (`{ error }`) rather
//      than throwing it, and a dropped connection throws; both are a sign-out that did not happen,
//      and then nothing else here runs. The person is still signed in and is told so.
//   2. What this browser remembers about the person is removed: the sign-in form's memory of the
//      account, and every wizard draft kept in the tab's storage.
//   3. The page is left with a full document load, not a router push, so the next page starts
//      with new query clients and new stores.

/** What {@link signOutOfConsole} came to. */
export type SignOutOutcome = "signed-out" | "failed";

/** The effects of a sign-out. The component passes the real ones; a test passes its own. */
export interface SignOutEffects {
	/** Ends the session on the server. May answer `{ error }` or throw. */
	endSession: () => Promise<{ error?: unknown } | null | undefined>;
	/** Forgets the account the sign-in form remembered. */
	forgetAccount: () => void;
	/** Removes every wizard draft kept in this tab. */
	clearWizardDrafts: () => void;
	/** Leaves for `href` with a full document load. */
	leave: (href: string) => void;
}

/** Where a signed-out visitor lands: the console root, which sends them on to sign-in. */
export const SIGNED_OUT_HREF = "/";

/**
 * Signs the person out of the console. Answers `"failed"`, having changed nothing in this
 * browser, when the session could not be ended; otherwise clears what the browser remembers of
 * them, leaves the page and answers `"signed-out"`.
 */
export async function signOutOfConsole(effects: SignOutEffects): Promise<SignOutOutcome> {
	try {
		const result = await effects.endSession();
		if (result?.error != null) return "failed";
	} catch {
		return "failed";
	}
	effects.forgetAccount();
	effects.clearWizardDrafts();
	effects.leave(SIGNED_OUT_HREF);
	return "signed-out";
}
