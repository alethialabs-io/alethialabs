// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Secret scrubber for the Sentry `beforeSend` / `beforeBreadcrumb` hooks. There is no pre-existing
// console log-scrubber to reuse, so this mirrors the RUNNER's audited denylist (output_scrub.go's
// `sensitiveOutputSubstrings`) — the same kubeconfig / client-key / client-secret shapes — extended
// with the env-var NAME shapes that carry credentials. It works two ways, belt-and-braces:
//
//  1. KEY redaction — any object key (a tag, extra, request header/cookie, or a captured local in a
//     stack frame's `vars`) whose name matches the denylist has its value replaced with [REDACTED].
//  2. VALUE redaction — the process's secret env VALUES (BETTER_AUTH_SECRET, ALETHIA_CRED_ENCRYPTION_KEY,
//     STRIPE_SECRET_KEY, DATABASE_URL, …) are stripped verbatim from every string, so a secret echoed
//     into an error message or breadcrumb can never reach the wire.
//
// Both are keyed off ONE denylist (`SECRET_KEY_SUBSTRINGS`) so there is a single source of truth for
// "what is secret" — nothing hand-rolled per call site. Kept in sync with the runner denylist.
//
// Separately, a failed database query is sent without its bound parameter values (#6633), by the
// rule the log serializer applies (lib/observability/log.ts, #6630): drizzle-orm's
// `DrizzleQueryError` message is `Failed query: <sql>\nparams: <values>`, and Sentry sends an error's
// `message` as the exception value, so every string in the event has that message rewritten to
// `Failed query: <sql>`. See `stripQueryParams`. The driver error under it has the values Postgres
// quotes in its message and detail removed the same way (#6645, lib/observability/query-error.ts).

import {
	failedQueryText,
	isDriverError,
	redactDriverText,
} from "@/lib/observability/query-error";

/**
 * Substring denylist (case-insensitive) identifying secret-bearing KEY names. The first block mirrors
 * the runner's `sensitiveOutputSubstrings`; the rest are the env/credential name shapes.
 *
 * This is a deliberate SUPERSET of the runner list (apps/runner/internal/agent/output_scrub.go): the
 * console handles secret shapes the runner never sees (encryption_key, database_url,
 * connection_string, authorization, cookie, signing, passwd). The overlap is the true shared set; the
 * extra entries are console-only and intentional — do NOT assume byte-for-byte parity with the runner.
 */
const SECRET_KEY_SUBSTRINGS = [
	// --- overlaps apps/runner/internal/agent/output_scrub.go (the shared set) ---
	"kubeconfig",
	"kube_config",
	"talosconfig",
	"client_key",
	"client_certificate",
	"private_key",
	"client_secret",
	// --- credential / secret name shapes ---
	"secret",
	"token",
	"password",
	"passwd",
	"passphrase",
	"credential",
	"api_key",
	"apikey",
	"access_key",
	"secret_key",
	"encryption_key",
	"signing",
	"authorization",
	"cookie",
	"session",
	"dsn",
	"connection_string",
	"database_url",
] as const;

const REDACTED = "[REDACTED]";

/**
 * Reports whether a key name looks like it holds a credential (case-insensitive substring match).
 * Hyphens are normalized to underscores so a header like `x-api-key` / `x-auth-token` matches the
 * underscore-shaped denylist entries (`api_key`, `token`, …) — HTTP header names use hyphens.
 */
export function isSecretKey(key: string): boolean {
	const lower = key.toLowerCase().replace(/-/g, "_");
	return SECRET_KEY_SUBSTRINGS.some((s) => lower.includes(s));
}

/**
 * Collects the process's secret env VALUES — those whose key matches the denylist and are long
 * enough (≥ 6 chars) to be a real secret rather than a generic token that would over-redact.
 * Recomputed per call: scrubbing only runs on captured errors (rare), so cost is irrelevant.
 */
function secretEnvValues(): string[] {
	const out: string[] = [];
	for (const [key, val] of Object.entries(process.env)) {
		if (typeof val === "string" && val.length >= 6 && isSecretKey(key)) {
			out.push(val);
		}
	}
	return out;
}

/** Replaces every known secret env value found in `s` with [REDACTED]. */
export function scrubString(s: string): string {
	let out = s;
	for (const secret of secretEnvValues()) {
		if (secret) out = out.split(secret).join(REDACTED);
	}
	return out;
}

/** Narrows to a plain (non-array) object so keys can be walked + reassigned without a cast. */
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** One error's text as the error carries it, and the text it is rewritten to. */
interface QueryRewrite {
	message: string;
	replacement: string;
}

/**
 * The exact rewrites for a thrown value and its `cause` chain. For each failed query on the chain:
 * its exact `message` (which carries the parameter values) and `Failed query: <sql>`. For each
 * database driver's error on the chain (usually a failed query's cause, as drizzle-orm wraps it):
 * its `message` and `detail` with the values Postgres quotes in them removed (`redactDriverText`).
 * Cycle-safe. Sentry sends each error in the chain as its own exception value, which is why the whole
 * chain is read, and why the driver's message is rewritten wherever it appears rather than only on
 * the thrown value.
 *
 * A driver error is rewritten wherever it is on the chain, not only under a failed query: a COMMIT
 * that fails a deferred constraint is raised by the driver directly, with no `DrizzleQueryError`
 * around it, and the log serializer redacts it there too. A `Failing row contains (...)` DETAIL is
 * covered by `redactDriverText`.
 */
function queryRewrites(thrown: unknown): QueryRewrite[] {
	const out: QueryRewrite[] = [];
	const seen = new Set<object>();
	let current: unknown = thrown;
	while (typeof current === "object" && current !== null && !seen.has(current)) {
		seen.add(current);
		const query = failedQueryText(current);
		if (query !== undefined) {
			if ("message" in current && typeof current.message === "string") {
				pushRewrite(out, current.message, `Failed query: ${query}`);
			}
		} else if (isDriverError(current)) {
			pushRewrite(out, current.message, redactDriverText(current.message));
			if ("detail" in current && typeof current.detail === "string") {
				pushRewrite(out, current.detail, redactDriverText(current.detail));
			}
		}
		current = "cause" in current ? current.cause : undefined;
	}
	return out;
}

/** Adds `message` → `replacement` to `out` unless the two are the same text. */
function pushRewrite(out: QueryRewrite[], message: string, replacement: string): void {
	if (message !== "" && message !== replacement) out.push({ message, replacement });
}

/** The separators that end a failed query's SQL: raw, and as it reads once JSON-escaped. */
const PARAMS_MARKERS = ["\nparams: ", "\\nparams: "] as const;

/**
 * Cuts a failed query's parameter values out of `s` by the message's shape: everything from the
 * first `\nparams: ` (raw or JSON-escaped) that follows a `Failed query: ` is dropped, to the END of
 * the string. The values are not escaped, so no later marker can be trusted to end them (a value can
 * forge a stack-frame line); the trailing text this also drops is the price of that. Two `indexOf`
 * scans, so its cost is linear in the length of `s`.
 */
function cutParamsByShape(s: string): string {
	const head = s.indexOf("Failed query: ");
	if (head === -1) return s;
	let cut = -1;
	for (const marker of PARAMS_MARKERS) {
		const at = s.indexOf(marker, head);
		if (at !== -1 && (cut === -1 || at < cut)) cut = at;
	}
	return cut === -1 ? s : s.slice(0, cut);
}

/**
 * Removes the bound parameter values from every failed-query message in `s`: first each exact
 * message in `rewrites` (taken from the original exception), which keeps any text after it, then
 * any remaining text of the `Failed query: <sql>\nparams: <values>` shape (`cutParamsByShape`) —
 * which also covers a breadcrumb that quotes a message from another error.
 */
function stripQueryParams(s: string, rewrites: readonly QueryRewrite[] = []): string {
	let out = s;
	for (const { message, replacement } of rewrites) {
		out = out.split(message).join(replacement);
	}
	return cutParamsByShape(out);
}

/**
 * Deep-walks a value IN PLACE: redacts secret-named keys, strips failed-query parameter values (see
 * `stripQueryParams`) and scrubs secret values out of every string. Cycle-safe via a WeakSet.
 * Mutating in place preserves the caller's concrete type (a Sentry Event / Breadcrumb) rather than
 * degrading it to a plain record.
 */
function scrubInPlace(
	value: unknown,
	seen: WeakSet<object>,
	rewrites: readonly QueryRewrite[],
): void {
	if (Array.isArray(value)) {
		for (let i = 0; i < value.length; i++) {
			const el: unknown = value[i];
			if (typeof el === "string") value[i] = scrubString(stripQueryParams(el, rewrites));
			else scrubInPlace(el, seen, rewrites);
		}
		return;
	}
	if (isRecord(value)) {
		if (seen.has(value)) return;
		seen.add(value);
		// A failed query copied into the event as an object (a serialized thrown value, extra error
		// data, a logged error) carries its values in its own `params` array, not only in its message.
		if (failedQueryText(value) !== undefined) value.params = REDACTED;
		for (const key of Object.keys(value)) {
			if (isSecretKey(key)) {
				value[key] = REDACTED;
				continue;
			}
			const v: unknown = value[key];
			if (typeof v === "string") value[key] = scrubString(stripQueryParams(v, rewrites));
			else scrubInPlace(v, seen, rewrites);
		}
	}
}

/**
 * Sentry `beforeSend` scrubber: strips secrets and failed-query parameter values from the entire
 * event (message, exception values, breadcrumbs, tags, extra, request data/headers/cookies, and
 * stack-frame vars) before it leaves the process. `hint.originalException` is the thrown value;
 * when it or an error on its `cause` chain is a failed database query, its exact message is
 * rewritten to `Failed query: <sql>` wherever it appears, and the driver error under it has its
 * message and detail rewritten without the values Postgres quotes in them (see `queryRewrites`).
 * Returns the same (mutated) event so the concrete type is preserved.
 */
export function scrubEvent<T>(event: T, hint?: { originalException?: unknown }): T {
	scrubInPlace(event, new WeakSet(), queryRewrites(hint?.originalException));
	return event;
}

/** Sentry `beforeBreadcrumb` scrubber — same deep scrub over a breadcrumb. */
export function scrubBreadcrumb<T>(breadcrumb: T): T {
	scrubInPlace(breadcrumb, new WeakSet(), []);
	return breadcrumb;
}
