// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Which sign-in method goes where on the provider step. Kept apart from the form so the
// ordering is a pure function with its own test, rather than a branch buried in JSX.

import type { AuthMethod } from "@/lib/stores/use-auth-prefs-store";

/** An OAuth provider the sign-in form offers. */
export type AuthProvider = Exclude<AuthMethod, "email">;

/** Leads the grid at full width on a fresh browser — for a Kubernetes control plane it is GitHub. */
export const PRIMARY_PROVIDER = "github" satisfies AuthProvider;
/** The rest, three-up beneath it. */
export const SECONDARY_PROVIDERS: readonly AuthProvider[] = ["google", "gitlab", "bitbucket"];
/** Every provider, in the order the form presents them. Also what `?provider=` may name. */
export const OAUTH_PROVIDERS: readonly AuthProvider[] = [PRIMARY_PROVIDER, ...SECONDARY_PROVIDERS];

/** Where each method sits on the provider step. */
export interface SignInLayout {
	/**
	 * The remembered method, rendered first as the full-width primary button with a
	 * "Last used" badge. Null on a browser with nothing remembered.
	 */
	lead: AuthMethod | null;
	/** The provider on the full-width outline row beneath the lead, or null when there is none. */
	wide: AuthProvider | null;
	/** The providers sharing the three-up row. */
	grid: AuthProvider[];
	/** Whether the outline "Continue with email" button renders below the providers. */
	emailBelow: boolean;
}

/**
 * Arranges the provider step around the last-used method.
 *
 * Nothing remembered: today's layout — GitHub full width, the other three in a row, email
 * below. A remembered provider leads, and the remaining three providers share the row (so the
 * row is always three-up). Remembered email leads, and the providers keep today's layout
 * beneath it; the email button below is then dropped, so there is only ever one.
 */
export function arrangeSignInMethods(lastMethod: AuthMethod | null): SignInLayout {
	if (lastMethod === null) {
		return { lead: null, wide: PRIMARY_PROVIDER, grid: [...SECONDARY_PROVIDERS], emailBelow: true };
	}
	if (lastMethod === "email") {
		return { lead: "email", wide: PRIMARY_PROVIDER, grid: [...SECONDARY_PROVIDERS], emailBelow: false };
	}
	return {
		lead: lastMethod,
		wide: null,
		grid: OAUTH_PROVIDERS.filter((p) => p !== lastMethod),
		emailBelow: true,
	};
}
