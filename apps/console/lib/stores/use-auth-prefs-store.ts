// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// What the sign-in form remembers between visits: which method you used last, and the
// address you used with it. Both exist to save a returning user from re-deciding
// something they already decided — the form shows a "Last used" mark on the right tile
// and pre-fills the email field.
//
// Browser-local and first-party. Nothing here is sent anywhere, and nothing here is an
// authentication factor: it decorates the form, it never selects an account or skips a
// step. Anyone can clear it from the browser, and signing out clears it here.

import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

/** A sign-in method the form can mark as last used. Mirrors AuthProvider plus the email path. */
export type AuthMethod = "github" | "google" | "gitlab" | "bitbucket" | "email";

interface AuthPrefsStore {
	/** The method that last carried a sign-in through, or null on a fresh browser. */
	lastMethod: AuthMethod | null;
	/**
	 * The address last VERIFIED on the email path — never merely typed.
	 *
	 * Recorded after verification rather than on submit for two reasons: a typo'd address
	 * would otherwise be pre-filled back at the user forever, and an address that never
	 * completed a sign-in is not something worth keeping on the machine.
	 */
	lastEmail: string | null;
	/** Records a completed sign-in. Pass the email only on the email path. */
	remember: (method: AuthMethod, email?: string) => void;
	/** Forgets everything. Called on sign-out. */
	forget: () => void;
}

export const useAuthPrefsStore = create<AuthPrefsStore>()(
	persist(
		(set) => ({
			lastMethod: null,
			lastEmail: null,
			remember: (method, email) =>
				set(
					method === "email" && email
						? { lastMethod: method, lastEmail: email }
						: { lastMethod: method },
				),
			forget: () => set({ lastMethod: null, lastEmail: null }),
		}),
		{
			name: "alethia-auth-prefs",
			storage: createJSONStorage(() => localStorage),
			version: 1,
			// Only the data. The mutators are re-created on load, and persisting them
			// would write two functions into localStorage as `null`.
			partialize: (s) => ({ lastMethod: s.lastMethod, lastEmail: s.lastEmail }),
		},
	),
);
