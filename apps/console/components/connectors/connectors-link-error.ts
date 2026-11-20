// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// What a failed git-provider connection says, in one place.
//
// Two screens start the same OAuth link (`authClient.linkSocial`): the connectors board and the
// repository selector. They used to report its failure differently — one printed the status, the
// code and the library's message in a toast, the other an inline line with the provider's slug in
// it and advice to sign out — and they did not agree on the verb either ("Connect" on the board,
// "Link" in the selector). Both now read the sentence, and the verb, from here.
//
// The sentence is chosen from the failure's `code` and `status` and never contains either: a
// code is for the error report (`captureException` keeps the whole object), not for the person.
//
// No React and no imports, so both callers and a test can load it as it stands.

/** The verb for connecting a git provider, as a button's first word. */
export const GIT_CONNECT_VERB = "Connect";

/** The parts of a failure this module reads. Anything else about it is ignored. */
interface LinkFailureParts {
	status: number | null;
	code: string | null;
}

/** Reads `status` and `code` off whatever the link call returned or threw. */
function partsOf(failure: unknown): LinkFailureParts {
	if (typeof failure !== "object" || failure === null) return { status: null, code: null };
	const status = "status" in failure && typeof failure.status === "number" ? failure.status : null;
	const code = "code" in failure && typeof failure.code === "string" ? failure.code : null;
	return { status, code };
}

/** The codes that mean the provider account already belongs to someone else's sign-in. */
const ALREADY_LINKED_CODES: ReadonlySet<string> = new Set([
	"SOCIAL_ACCOUNT_ALREADY_LINKED",
	"LINKED_ACCOUNT_ALREADY_EXISTS",
	"ACCOUNT_ALREADY_LINKED_TO_DIFFERENT_USER",
]);

/** The codes that mean this instance has no OAuth application for the provider. */
const NOT_ENABLED_CODES: ReadonlySet<string> = new Set(["PROVIDER_NOT_FOUND", "PROVIDER_NOT_CONFIGURED"]);

/** The codes that mean there is no signed-in session to attach the provider to. */
const SIGNED_OUT_CODES: ReadonlySet<string> = new Set(["UNAUTHORIZED", "SESSION_EXPIRED", "SESSION_NOT_FOUND"]);

/**
 * The sentence for a git-provider connection that did not start, in terms of `provider` (its
 * display name: "GitHub"). One sentence per cause the link call can report, and a last one for a
 * cause it cannot name. Every sentence says what to do next.
 *
 * @param provider The provider's display name.
 * @param failure The `error` the link call returned, or whatever it threw.
 */
export function gitLinkFailureMessage(provider: string, failure: unknown): string {
	const { status, code } = partsOf(failure);
	if (code !== null && ALREADY_LINKED_CODES.has(code)) {
		return `That ${provider} account is already connected to a different Alethia user. Sign in to ${provider} with another account, then try again.`;
	}
	if (code !== null && NOT_ENABLED_CODES.has(code)) {
		return `${provider} is not enabled on this instance. Ask the person who runs it to register a ${provider} OAuth application.`;
	}
	if ((code !== null && SIGNED_OUT_CODES.has(code)) || status === 401) {
		return `Your session has ended. Sign in again, then connect ${provider}.`;
	}
	if (status === 429) {
		return `Too many attempts. Wait a minute, then connect ${provider} again.`;
	}
	if (status === 404) {
		return `${provider} is not enabled on this instance. Ask the person who runs it to register a ${provider} OAuth application.`;
	}
	if (status === null && failure instanceof TypeError) {
		return `Alethia could not be reached, so ${provider} was not connected. Check your connection and try again.`;
	}
	return `${provider} could not be connected. Try again; if it keeps happening, contact support.`;
}
