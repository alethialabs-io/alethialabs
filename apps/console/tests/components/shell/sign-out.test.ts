// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The sign-out sequence (#6924), with its effects recorded in the order they run.
//
// The sign-out handler used to ignore the auth client's answer (it answers a failure as
// `{ error }`, it does not throw), then push the router to "/". A push keeps the tab's memory, and
// that memory holds a query client per organization with the previous person's rows. And wizard
// drafts, which live in the tab's storage, had a `clearAllWizardDrafts()` that nothing called.

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
