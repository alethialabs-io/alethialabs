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
//     into an error message or breadcrumb can never reach the wire. An object KEY whose text carries
//     one is renamed the same way in the copy (#6678), so a map keyed by a token does not send it as
//     a property name.
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
 * It walks all of `process.env`, so a scrub reads it ONCE per event or breadcrumb (`scrubTopLevel`)
 * and hands the list down, rather than once per string (#6668): a breadcrumb is not normalized
 * before `beforeBreadcrumb`, so a large `console.*` call put tens of thousands of strings through
 * it. Not cached across calls, so a value set in `process.env` after start-up is still redacted.
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

/**
 * Replaces every known secret env value found in `s` with [REDACTED]. `secrets` is the list
 * `secretEnvValues` returns; a walk passes the one it read for the whole scrub.
 */
export function scrubString(s: string, secrets: readonly string[] = secretEnvValues()): string {
	let out = s;
	for (const secret of secrets) {
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
 * What the walk has already produced for each object it reached: the object itself when scrubbing
 * left it as it was, or the copy that replaces it. An object is entered here BEFORE its children are
 * walked, as its (still empty) copy, so a cycle back to it resolves to the copy and a shared object
 * is scrubbed once. A consequence: every object on a cycle is copied, even a clean one, because the
 * back-reference already points at a copy. That costs memory, not correctness.
 */
type ScrubMemo = Map<object, unknown>;

/** What one scrub reads once and every value it walks uses. */
interface ScrubContext {
	/** The exact failed-query rewrites for the thrown value (`queryRewrites`). */
	rewrites: readonly QueryRewrite[];
	/** The secret env values, read once for the whole scrub (`secretEnvValues`). */
	secrets: readonly string[];
}

/**
 * Returns `value` with secret-named keys redacted, failed-query parameter values stripped (see
 * `stripQueryParams`) and secret values scrubbed out of every string. COPY-ON-WRITE (#6662): an
 * object or array is returned as it is when nothing in it changes, and as a fresh copy when anything
 * does; the object reached is never written to. That matters because a breadcrumb from the console
 * integration holds the logged arguments themselves, so writing through it once changed a logged
 * error's own `params` for the code that still held it. Cycle-safe via `memo`.
 */
function scrubValue(value: unknown, memo: ScrubMemo, ctx: ScrubContext): unknown {
	if (typeof value === "string") {
		return scrubString(stripQueryParams(value, ctx.rewrites), ctx.secrets);
	}
	if (typeof value !== "object" || value === null) return value;
	if (memo.has(value)) return memo.get(value);
	if (Array.isArray(value)) return scrubArray(value, memo, ctx);
	if (isRecord(value)) return scrubRecord(value, memo, ctx);
	return value;
}

/** `scrubValue` for an array: the array itself when no element changes, else a new array. */
function scrubArray(
	value: readonly unknown[],
	memo: ScrubMemo,
	ctx: ScrubContext,
): unknown {
	const copy: unknown[] = [];
	memo.set(value, copy);
	let changed = false;
	for (let i = 0; i < value.length; i++) {
		const el: unknown = value[i];
		const out = scrubValue(el, memo, ctx);
		copy.push(out);
		if (!Object.is(out, el)) changed = true;
	}
	if (changed) return copy;
	memo.set(value, value);
	return value;
}

/** What `changedEntries` read from an object: every own enumerable value, and the ones that change. */
interface RecordScan {
	/** The value each own enumerable key returned, read ONCE (a getter is never read twice). */
	read: Map<string, unknown>;
	/** The scrubbed value of each key that scrubbing changes; empty means no copy is needed. */
	changes: Map<string, unknown>;
	/**
	 * Each key whose NAME carries a secret value, and the name it has in the copy (`renamedKeys`).
	 * Empty, with `changes` empty, means no copy is needed.
	 */
	renames: Map<string, string>;
}

/** Joins a redacted key name and a collision number: the second `[REDACTED]` key is `[REDACTED]#2`. */
const COLLISION_SEPARATOR = "#";

/**
 * The name each key of `value` gets in the copy when its own text contains a known secret value
 * (#6678): the key passed through `scrubString`, so `tok-<secret>` becomes `tok-[REDACTED]`. A key
 * is data as much as a value is (a map keyed by token, a header object keyed by a credential), and
 * judging it only by `isSecretKey` let the secret through as the property name.
 *
 * Two keys can come out with the same name (two different secrets, or a renamed key and a key
 * already called `[REDACTED]`). Neither is dropped: the first renamed key, in `Object.keys` order,
 * takes the plain name, and each later one takes the first free `<name>#2`, `<name>#3`, …. A name is
 * free when no own property of `value` that keeps its name has it (non-enumerable ones included, so
 * a copied error's `message` is never overwritten) and no earlier rename took it. Deterministic for
 * a given object and secret list.
 */
function renamedKeys(
	value: Record<string, unknown>,
	keys: readonly string[],
	secrets: readonly string[],
): Map<string, string> {
	const renames = new Map<string, string>();
	for (const key of keys) {
		const scrubbed = scrubString(key, secrets);
		if (scrubbed !== key) renames.set(key, scrubbed);
	}
	if (renames.size === 0) return renames;
	const taken = new Set<string>();
	for (const name of Object.getOwnPropertyNames(value)) {
		if (!renames.has(name)) taken.add(name);
	}
	for (const [key, scrubbed] of renames) {
		let name = scrubbed;
		for (let n = 2; taken.has(name); n++) name = `${scrubbed}${COLLISION_SEPARATOR}${n}`;
		taken.add(name);
		renames.set(key, name);
	}
	return renames;
}

/**
 * Reads each of `value`'s own enumerable keys once, and scrubs it; `changes` holds the keys whose
 * scrubbed value differs (empty means `value` needs no copy). A key whose read throws (a getter that
 * fails) is redacted rather than letting the scrub throw: a throwing `beforeSend` makes Sentry send
 * its own internal error report, which skips this scrub. A secret-named key is redacted whole, and a failed query copied into
 * the event as an object (a serialized thrown value, extra error data, a logged error) has its own
 * `params` array redacted too, because it carries the values there and not only in its message. A
 * key whose own text carries a secret value is listed in `renames` (`renamedKeys`).
 */
function changedEntries(
	value: Record<string, unknown>,
	memo: ScrubMemo,
	ctx: ScrubContext,
): RecordScan {
	const read = new Map<string, unknown>();
	const changes = new Map<string, unknown>();
	if (failedQueryText(value) !== undefined) changes.set("params", REDACTED);
	const keys = Object.keys(value);
	for (const key of keys) {
		let original: unknown;
		try {
			original = value[key];
		} catch {
			changes.set(key, REDACTED);
			continue;
		}
		read.set(key, original);
		const out = isSecretKey(key) ? REDACTED : scrubValue(original, memo, ctx);
		if (!Object.is(out, original)) changes.set(key, out);
	}
	return { read, changes, renames: renamedKeys(value, keys, ctx.secrets) };
}

/**
 * The value a key ends up with: its scrubbed value when scrubbing changed it, else the value read.
 */
function finalValue(scan: RecordScan, key: string): unknown {
	return scan.changes.has(key) ? scan.changes.get(key) : scan.read.get(key);
}

/**
 * `scrubValue` for a non-array object: the object itself when nothing in it changes, else a copy
 * with the same prototype and the same own properties, the changed ones replaced. The prototype is
 * kept so a copied `Error` is still one to Sentry's serializer, which then reads its `message` and
 * `stack` as it would have read the original's. An own accessor (V8 defines an error's `stack` as
 * one, and its getter reads an internal slot the copy does not have) is copied as the value it
 * returns on the original. A key listed in `renames` is moved to its new name in the copy, at the
 * end of the key order; the original object keeps the old name.
 */
function scrubRecord(
	value: Record<string, unknown>,
	memo: ScrubMemo,
	ctx: ScrubContext,
): unknown {
	const copy: object = Object.create(Object.getPrototypeOf(value));
	memo.set(value, copy);
	const scan = changedEntries(value, memo, ctx);
	const { read, changes, renames } = scan;
	if (changes.size === 0 && renames.size === 0) {
		memo.set(value, value);
		return value;
	}
	const descriptors = Object.getOwnPropertyDescriptors(value);
	for (const key of Object.keys(descriptors)) {
		const d = descriptors[key];
		if (d !== undefined && (d.get !== undefined || d.set !== undefined)) {
			// An enumerable accessor was read once above, and that read is what was scrubbed; a
			// non-enumerable one (an error's `stack`) is read here, and left out if its getter throws.
			let current: unknown;
			if (read.has(key)) current = read.get(key);
			else {
				try {
					current = Reflect.get(value, key);
				} catch {
					delete descriptors[key];
					continue;
				}
			}
			descriptors[key] = {
				value: current,
				writable: true,
				enumerable: d.enumerable ?? false,
				configurable: true,
			};
		}
	}
	for (const [key, out] of changes) {
		descriptors[key] = { value: out, writable: true, enumerable: true, configurable: true };
	}
	// Every old name is removed before any new one is set, so a rename can never land on a name
	// that a later rename then deletes.
	for (const key of renames.keys()) delete descriptors[key];
	for (const [key, name] of renames) {
		descriptors[name] = {
			value: finalValue(scan, key),
			writable: true,
			enumerable: true,
			configurable: true,
		};
	}
	Object.defineProperties(copy, descriptors);
	return copy;
}

/**
 * Scrubs the top-level event or breadcrumb Sentry hands a hook, keeping its concrete type: each key
 * whose value scrubbing changes is pointed at the scrubbed copy (`scrubValue`), so nothing below the
 * top level is written to. The top-level object itself is Sentry's own, not the caller's: Sentry
 * builds a fresh breadcrumb (`{ timestamp, ...breadcrumb }`) before `beforeBreadcrumb` and a fresh
 * event (`{ ...event, event_id, ... }`) before `beforeSend`, so writing its keys reaches no
 * application object.
 */
function scrubTopLevel<T>(root: T, rewrites: readonly QueryRewrite[]): T {
	// Widened to `unknown` so the narrowing yields a plain record whose keys can be written.
	const record: unknown = root;
	if (!isRecord(record)) return root;
	const memo: ScrubMemo = new Map();
	memo.set(record, record);
	const ctx: ScrubContext = { rewrites, secrets: secretEnvValues() };
	const scan = changedEntries(record, memo, ctx);
	for (const [key, out] of scan.changes) record[key] = out;
	const moved = [...scan.renames].map(([key, name]) => ({ name, out: finalValue(scan, key) }));
	for (const key of scan.renames.keys()) delete record[key];
	for (const { name, out } of moved) record[name] = out;
	return root;
}

/**
 * Sentry `beforeSend` scrubber: strips secrets and failed-query parameter values from the entire
 * event (message, exception values, breadcrumbs, tags, extra, request data/headers/cookies, and
 * stack-frame vars) before it leaves the process. `hint.originalException` is the thrown value;
 * when it or an error on its `cause` chain is a failed database query, its exact message is
 * rewritten to `Failed query: <sql>` wherever it appears, and the driver error under it has its
 * message and detail rewritten without the values Postgres quotes in them (see `queryRewrites`).
 * Returns the same event object, with every changed part below it replaced by a scrubbed copy, so
 * the concrete type is preserved and no object the event refers to is changed (`scrubTopLevel`).
 */
export function scrubEvent<T>(event: T, hint?: { originalException?: unknown }): T {
	return scrubTopLevel(event, queryRewrites(hint?.originalException));
}

/** Sentry `beforeBreadcrumb` scrubber — same deep, copy-on-write scrub over a breadcrumb. */
export function scrubBreadcrumb<T>(breadcrumb: T): T {
	return scrubTopLevel(breadcrumb, []);
}
