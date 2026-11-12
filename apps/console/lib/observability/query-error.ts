// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// How a failed database query is recognised, and what of it may be written to the logs
// (lib/observability/log.ts) and sent to the error tracker (lib/observability/scrub.ts). One module,
// so the two outputs cannot drift apart.
//
// A failed query carries the values it was run with in two places:
//
//  1. drizzle-orm's `DrizzleQueryError` message, `Failed query: <sql>\nparams: <values>` (#6630,
//     #6633) — see `failedQueryText`.
//  2. The driver's own error, which is that error's `cause`. Postgres quotes the offending input in
//     some messages (`invalid input syntax for type uuid: "<value>"`) and lists the conflicting key
//     in the DETAIL of others (`Key (email)=(<value>) already exists.`) (#6645) — see
//     `redactDriverText`.

const REDACTED = "[REDACTED]";

/** A SQLSTATE: five characters, digits and upper-case letters (`22P02`, `23505`). */
const SQLSTATE = /^[0-9A-Z]{5}$/;

/**
 * The SQL text of a failed database query, when `value` is drizzle-orm's `DrizzleQueryError`, else
 * `undefined`. That error's `message` is `Failed query: <sql>\nparams: <values>`, so it carries the
 * query's bound parameter values (an email, a token) and must not be written as it is.
 *
 * Recognised by shape, an own `query` string and an own `params` array, which drizzle-orm's
 * constructor sets on every instance. Not by `instanceof`: that fails open when a second copy of
 * drizzle-orm is loaded (a peer-dependency or patch variant in the pnpm store, a separately
 * bundled server entry), and `DrizzleQueryError` declares no `entityKind`, so drizzle's own `is()`
 * cannot match across copies either. A missed match writes the parameter values; a shape match on
 * some other error only replaces its message with `Failed query: <its query>`.
 */
export function failedQueryText(value: object): string | undefined {
	if (
		Object.hasOwn(value, "query") &&
		"query" in value &&
		typeof value.query === "string" &&
		Object.hasOwn(value, "params") &&
		"params" in value &&
		Array.isArray(value.params)
	) {
		return value.query;
	}
	return undefined;
}

/** A database driver's error, as `isDriverError` recognises it. */
export interface DriverError {
	code: string;
	message: string;
}

/**
 * Reports whether `value` is a database driver's error: an own string `code` that is a SQLSTATE,
 * and a string `message`. postgres-js's `PostgresError` copies every field of the server's
 * ErrorResponse onto the instance, so its `code` is always own; a connection-level error from the
 * same driver (`CONNECTION_CLOSED`, `ECONNREFUSED`) has a code of another shape and is not matched,
 * which is right — it carries no query value.
 *
 * By shape, not `instanceof`, for the reason `failedQueryText` gives.
 */
export function isDriverError(value: object): value is object & DriverError {
	return (
		Object.hasOwn(value, "code") &&
		"code" in value &&
		typeof value.code === "string" &&
		SQLSTATE.test(value.code) &&
		"message" in value &&
		typeof value.message === "string"
	);
}

/**
 * Replaces a `Key (<columns>)=(<values>)` value list in `s` with `Key (<columns>)=([REDACTED])`.
 * The values are not escaped and may themselves contain `)`, so the list is taken to run to the
 * LAST `)` in `s`; a second list in the same text (an exclusion constraint's `conflicts with existing
 * key (c)=(v)`) is inside that span and goes with it. An unclosed list is cut to the end.
 */
function redactKeyList(s: string): string {
	const key = s.indexOf("Key (");
	if (key === -1) return s;
	const sep = s.indexOf(")=(", key);
	if (sep === -1) return s;
	const open = sep + ")=(".length;
	const close = s.lastIndexOf(")");
	if (close < open) return `${s.slice(0, open)}${REDACTED})`;
	return `${s.slice(0, open)}${REDACTED}${s.slice(close)}`;
}

/**
 * Replaces the double-quoted text in `s` with `"[REDACTED]"`. Postgres does not escape a `"` inside
 * a value it quotes, so pairing quotes one by one would leave the tail of a value that contains one;
 * instead everything from the FIRST `"` to the LAST is replaced as one span. The price is that a
 * quoted identifier in the same message — a constraint, table or type name, which is not user data —
 * is redacted with it (`violates unique constraint "[REDACTED]"`); the SQLSTATE `code` still says
 * what failed. A lone `"` is redacted to the end.
 */
function redactQuoted(s: string): string {
	const first = s.indexOf('"');
	if (first === -1) return s;
	const last = s.lastIndexOf('"');
	const rest = last === first ? "" : s.slice(last + 1);
	return `${s.slice(0, first)}"${REDACTED}"${rest}`;
}

/**
 * A database driver's message or detail text with the values Postgres puts in it removed: the
 * `Key (cols)=(values)` list becomes `Key (cols)=([REDACTED])`, and the quoted text `"[REDACTED]"`.
 * Text with neither is returned unchanged. Apply it only to a driver error's own text (see
 * `isDriverError`) — quoted text in an arbitrary message is not a query value.
 */
export function redactDriverText(s: string): string {
	return redactQuoted(redactKeyList(s));
}
