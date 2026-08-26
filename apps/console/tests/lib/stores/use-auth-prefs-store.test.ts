// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The sign-in form's memory: which method carried the last sign-in, and the address that
// went with it. jsdom supplies a real localStorage, so nothing here is stubbed — but the
// zustand store is a module-level singleton, so every test resets BOTH the storage and the
// store state. Clearing only one leaves the other populated and the next test passes for
// the wrong reason.

import { beforeEach, describe, expect, it } from "vitest";
import { useAuthPrefsStore } from "@/lib/stores/use-auth-prefs-store";

const KEY = "alethia-auth-prefs";

/** The persisted payload zustand wrote, or null when it wrote nothing. */
function persisted(): { lastMethod: string | null; lastEmail: string | null } | null {
	const raw = localStorage.getItem(KEY);
	if (!raw) return null;
	return JSON.parse(raw).state;
}

beforeEach(() => {
	localStorage.clear();
	useAuthPrefsStore.setState({ lastMethod: null, lastEmail: null });
});

describe("useAuthPrefsStore", () => {
	it("starts empty, so a fresh browser marks nothing", () => {
		expect(useAuthPrefsStore.getState().lastMethod).toBeNull();
		expect(useAuthPrefsStore.getState().lastEmail).toBeNull();
	});

	it("remembers an OAuth provider without inventing an email", () => {
		useAuthPrefsStore.getState().remember("github");

		expect(useAuthPrefsStore.getState().lastMethod).toBe("github");
		expect(useAuthPrefsStore.getState().lastEmail).toBeNull();
		expect(persisted()).toEqual({ lastMethod: "github", lastEmail: null });
	});

	it("remembers a verified email address alongside the method", () => {
		useAuthPrefsStore.getState().remember("email", "bob@x.com");

		expect(persisted()).toEqual({ lastMethod: "email", lastEmail: "bob@x.com" });
	});

	it("keeps the last address when a later sign-in used a provider", () => {
		// Switching to GitHub should not erase the address — the email path is still
		// offered, and pre-filling it is exactly as useful as it was before.
		useAuthPrefsStore.getState().remember("email", "bob@x.com");
		useAuthPrefsStore.getState().remember("github");

		expect(persisted()).toEqual({ lastMethod: "github", lastEmail: "bob@x.com" });
	});

	it("does not clobber a remembered address when email is passed without one", () => {
		useAuthPrefsStore.getState().remember("email", "bob@x.com");
		useAuthPrefsStore.getState().remember("email");

		expect(useAuthPrefsStore.getState().lastEmail).toBe("bob@x.com");
	});

	it("forget() clears both, so sign-out leaves nothing on the machine", () => {
		useAuthPrefsStore.getState().remember("email", "bob@x.com");
		useAuthPrefsStore.getState().forget();

		expect(useAuthPrefsStore.getState().lastMethod).toBeNull();
		expect(useAuthPrefsStore.getState().lastEmail).toBeNull();
		// And the cleared state must reach disk — a store that only forgets in memory
		// would hand the address straight back on the next page load.
		expect(persisted()).toEqual({ lastMethod: null, lastEmail: null });
	});

	it("persists only data, never the mutators", () => {
		useAuthPrefsStore.getState().remember("gitlab");
		const state = persisted();

		expect(Object.keys(state ?? {}).sort()).toEqual(["lastEmail", "lastMethod"]);
	});
});
