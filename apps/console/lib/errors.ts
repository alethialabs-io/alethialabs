// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Cast-free readers for the well-known properties an unknown thrown value MIGHT carry
// (DOMException / AWS-SDK / Next.js errors). Each uses `in`-operator narrowing so the
// property is accessed type-safely instead of asserted with `as` — a caught `unknown`
// stays honestly unknown, and a missing property yields `undefined`, never a crash.

/** True when `e` is a non-null object, so `in` can narrow its properties. */
function isObject(e: unknown): e is object {
	return typeof e === "object" && e !== null;
}

/** The `name` of an unknown error (AWS-SDK / DOMException errors carry it), or undefined. */
export function errorName(e: unknown): string | undefined {
	return isObject(e) && "name" in e && typeof e.name === "string"
		? e.name
		: undefined;
}

/** The `code` of an unknown error, stringified, or undefined. */
export function errorCode(e: unknown): string | undefined {
	return isObject(e) && "code" in e && e.code != null ? String(e.code) : undefined;
}

/** The `stack` of an unknown error, or undefined. */
export function errorStack(e: unknown): string | undefined {
	return isObject(e) && "stack" in e && typeof e.stack === "string"
		? e.stack
		: undefined;
}

/** The Next.js `digest` of an unknown error, or undefined. */
export function errorDigest(e: unknown): string | undefined {
	return isObject(e) && "digest" in e && typeof e.digest === "string"
		? e.digest
		: undefined;
}

/** The message of an unknown thrown value (Error.message, else its string form). */
export function errorMessage(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

/** The AWS-SDK `$metadata.httpStatusCode` of an unknown error, or undefined. */
export function errorHttpStatus(e: unknown): number | undefined {
	if (!isObject(e) || !("$metadata" in e) || !isObject(e.$metadata)) {
		return undefined;
	}
	const meta = e.$metadata;
	return "httpStatusCode" in meta && typeof meta.httpStatusCode === "number"
		? meta.httpStatusCode
		: undefined;
}

/** Coerce an unknown thrown value to an Error, for APIs that require one. */
export function toError(e: unknown): Error {
	return e instanceof Error ? e : new Error(String(e));
}

/**
 * True when a thrown request error is EXPECTED control flow, not a bug: Next.js's redirect()/notFound()
 * signals (carried on `digest`) and the auth "no session" sentinel (`requireOwner()` throws
 * `Unauthorized` for a logged-out/crawler request on an authed route). These aren't actionable and
 * otherwise flood error tracking, so `onRequestError` logs them quietly and does NOT forward them to
 * PostHog/Sentry.
 */
export function isExpectedRequestError(e: unknown): boolean {
	const digest = errorDigest(e) ?? "";
	if (
		digest.startsWith("NEXT_REDIRECT") ||
		digest.startsWith("NEXT_HTTP_ERROR_FALLBACK") ||
		digest === "NEXT_NOT_FOUND"
	) {
		return true;
	}
	return errorMessage(e) === "Unauthorized";
}

/** Longest error text persisted to a `last_error` column; longer text is cut with an ellipsis. */
export const MAX_PERSISTED_ERROR_CHARS = 1000;

/**
 * Makes an error message safe to store in a Postgres `text` column and to show a user: every control
 * character except tab and newline (C0, DEL, C1 — NUL above all, which Postgres rejects outright with
 * `invalid byte sequence for encoding "UTF8": 0x00`) becomes a visible `\xNN` escape, a lone UTF-16
 * surrogate becomes U+FFFD, and the result is capped at `MAX_PERSISTED_ERROR_CHARS`.
 *
 * Without it, a probe error quoting raw bytes turned a connection-test failure into a failed UPDATE
 * and a raw SQL error returned to the CLI (#5087, grid run 36611808450). null passes through.
 */
export function persistableErrorText(message: string | null): string | null {
	if (message === null) return null;
	const escaped = message
		.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, (c) =>
			`\\x${c.charCodeAt(0).toString(16).padStart(2, "0")}`,
		)
		.replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, "�");
	if (escaped.length <= MAX_PERSISTED_ERROR_CHARS) return escaped;
	let cut = escaped.slice(0, MAX_PERSISTED_ERROR_CHARS - 1);
	if (/[\ud800-\udbff]$/.test(cut)) cut = cut.slice(0, -1);
	return `${cut}…`;
}
