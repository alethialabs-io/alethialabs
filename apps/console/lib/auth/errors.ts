// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Typed identity errors, so a caller can tell "who are you?" and "not yours" apart from a failure
// by CLASS rather than by reading a message (#5001).
//
// `[org]/layout.tsx` used to catch everything `resolveOrgScope` threw, compare ONE message against
// the string "Unauthorized", and turn every other throw into `notFound()`. A dropped database
// connection therefore rendered "Organization not found" about the user's own org, and the real
// error was never logged. The layout now asks these classes what happened and rethrows anything
// they do not name.
//
// Both keep the message their untyped predecessors threw. `isExpectedRequestError` (lib/errors.ts)
// still recognises the no-session sentinel by its message, and a client that surfaced
// "Not a member of that organization" keeps surfacing the same words.
//
// NOT in a `"use server"` module on purpose: such a module may export only async functions, so a
// class declared beside `resolveOrgScope` or `setActiveOrganization` would fail the build.

/** There is no authenticated session. The response is sign-in, not an error page. */
export class UnauthorizedError extends Error {
	/** Builds the sentinel with the message `isExpectedRequestError` matches on. */
	constructor() {
		super("Unauthorized");
		this.name = "UnauthorizedError";
	}
}

/**
 * The caller is authenticated but is not a member of the organization it named.
 *
 * A route answers this with the same 404 as an unknown org, so a stranger cannot learn which org
 * slugs exist by reading the difference.
 */
export class NotOrgMemberError extends Error {
	/** Builds the error with the message `setActiveOrganization` has always thrown. */
	constructor() {
		super("Not a member of that organization");
		this.name = "NotOrgMemberError";
	}
}
