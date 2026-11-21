// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The sign-up controls' public vocabulary (beta unit REL-L10, #6911): the error codes a refused
// sign-up answers with, the copy the person reads for each, and the challenge's action name.
//
// CLIENT-SAFE ON PURPOSE. This file has no imports, so the sign-in form (a client component,
// components/auth/auth-form.tsx) and the server guard (./guard.ts) read ONE definition of each
// code and its message. Before this file the sign-in form matched a server literal it could not
// import; here neither side can drift from the other.

/** A new account was refused because its address belongs to a temporary-inbox service. */
export const SIGNUP_DISPOSABLE_EMAIL = "SIGNUP_DISPOSABLE_EMAIL";

/** A new account was refused because its network reached the day's sign-up ceiling. */
export const SIGNUP_NETWORK_LIMIT = "SIGNUP_NETWORK_LIMIT";

/** Every code a refused sign-up can answer with. */
export type SignupRefusalCode = typeof SIGNUP_DISPOSABLE_EMAIL | typeof SIGNUP_NETWORK_LIMIT;

/**
 * What the person reads for each refusal. It says what to do next and nothing about how the check
 * works. The network message names the one route around the ceiling that is intended — an
 * invitation — because an invited address is not counted (see ./guard.ts).
 */
export const SIGNUP_REFUSAL_MESSAGES: Readonly<Record<SignupRefusalCode, string>> = {
	[SIGNUP_DISPOSABLE_EMAIL]:
		"Use a permanent email address to create an account. Temporary inbox services aren’t accepted.",
	[SIGNUP_NETWORK_LIMIT]:
		"Too many accounts were created from your network today. Try again tomorrow, or ask a teammate to invite you.",
};

/** Narrows an arbitrary error code to a sign-up refusal code. */
export function isSignupRefusalCode(code: unknown): code is SignupRefusalCode {
	return code === SIGNUP_DISPOSABLE_EMAIL || code === SIGNUP_NETWORK_LIMIT;
}

/**
 * The Turnstile `action` the sign-in form mints its token for, and the only action the server
 * accepts on code issuance. Binding the two means a token minted for some other widget on the same
 * site key is refused.
 */
export const SIGNUP_CHALLENGE_ACTION = "sign-in-code";

/**
 * The error codes Better Auth's captcha plugin answers with (better-auth/plugins/captcha,
 * error-codes). The form maps them to its own copy rather than showing the plugin's message.
 */
export const CHALLENGE_REFUSAL_CODES: readonly string[] = ["MISSING_RESPONSE", "VERIFICATION_FAILED"];

/** Shown when the challenge token was missing or did not verify. */
export const CHALLENGE_REFUSED_MESSAGE = "Complete the security check, then try again.";
