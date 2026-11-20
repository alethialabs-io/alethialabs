// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The sign-out sequence (#6924), with its effects recorded in the order they run.
//
// Signing out is one sequence: the session is ended on the server; then, and only if that
// worked, the sign-in form's memory of the account and the tab's wizard drafts are cleared; then
// the page is left with a full document load. The auth client answers a failure as `{ error }`
// rather than throwing, and both forms of failure leave the person signed in with nothing cleared.

import { describe, expect, it } from "vitest";
import { SIGNED_OUT_HREF, signOutOfConsole, type SignOutEffects } from "@/components/shell/sign-out";

/** Effects that record their calls in order; `endSession` behaves as given. */
function recorded(endSession: SignOutEffects["endSession"]): { calls: string[]; effects: SignOutEffects } {
	const calls: string[] = [];
	return {
		calls,
		effects: {
			endSession: () => {
				calls.push("endSession");
				return endSession();
			},
			forgetAccount: () => calls.push("forgetAccount"),
			clearWizardDrafts: () => calls.push("clearWizardDrafts"),
			leave: (href) => calls.push(`leave ${href}`),
		},
	};
}

describe("signOutOfConsole", () => {
	it("ends the session, then forgets the account and the wizard drafts, then leaves with a document load", async () => {
		const { calls, effects } = recorded(async () => ({ error: null }));
		await expect(signOutOfConsole(effects)).resolves.toBe("signed-out");
		expect(calls).toEqual([
			"endSession",
			"forgetAccount",
			"clearWizardDrafts",
			`leave ${SIGNED_OUT_HREF}`,
		]);
		expect(SIGNED_OUT_HREF).toBe("/");
	});

	it("treats an answer with no error field, and no answer at all, as signed out", async () => {
		for (const answer of [{}, null, undefined]) {
			const { calls, effects } = recorded(async () => answer);
			await expect(signOutOfConsole(effects)).resolves.toBe("signed-out");
			expect(calls).toContain("clearWizardDrafts");
		}
	});

	it("an ANSWERED failure is a failure: nothing in the browser is cleared and the page is not left", async () => {
		const { calls, effects } = recorded(async () => ({ error: { status: 500, message: "no" } }));
		await expect(signOutOfConsole(effects)).resolves.toBe("failed");
		expect(calls).toEqual(["endSession"]);
	});

	it("a THROWN failure is a failure too, and is not rethrown", async () => {
		const { calls, effects } = recorded(async () => {
			throw new TypeError("Failed to fetch");
		});
		await expect(signOutOfConsole(effects)).resolves.toBe("failed");
		expect(calls).toEqual(["endSession"]);
	});
});
