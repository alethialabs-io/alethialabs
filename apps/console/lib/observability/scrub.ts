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

/**
 * Substring denylist (case-insensitive) identifying secret-bearing KEY names. The first block mirrors
 * the runner's `sensitiveOutputSubstrings`; the rest are the env/credential name shapes.
 */
const SECRET_KEY_SUBSTRINGS = [
	// --- kept in sync with apps/runner/internal/agent/output_scrub.go ---
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

/** Reports whether a key name looks like it holds a credential (case-insensitive substring match). */
export function isSecretKey(key: string): boolean {
	const lower = key.toLowerCase();
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

/**
 * Deep-walks a value IN PLACE: redacts secret-named keys and scrubs secret values out of every
 * string. Cycle-safe via a WeakSet. Mutating in place preserves the caller's concrete type (a Sentry
 * Event / Breadcrumb) rather than degrading it to a plain record.
 */
function scrubInPlace(value: unknown, seen: WeakSet<object>): void {
	if (Array.isArray(value)) {
		for (let i = 0; i < value.length; i++) {
			const el: unknown = value[i];
			if (typeof el === "string") value[i] = scrubString(el);
			else scrubInPlace(el, seen);
		}
		return;
	}
	if (isRecord(value)) {
		if (seen.has(value)) return;
		seen.add(value);
		for (const key of Object.keys(value)) {
			if (isSecretKey(key)) {
				value[key] = REDACTED;
				continue;
			}
			const v: unknown = value[key];
			if (typeof v === "string") value[key] = scrubString(v);
			else scrubInPlace(v, seen);
		}
	}
}

/**
 * Sentry `beforeSend` scrubber: strips secrets from the entire event (message, exception values,
 * tags, extra, request data/headers/cookies, and stack-frame vars) before it leaves the process.
 * Returns the same (mutated) event so the concrete type is preserved.
 */
export function scrubEvent<T>(event: T): T {
	scrubInPlace(event, new WeakSet());
	return event;
}

/** Sentry `beforeBreadcrumb` scrubber — same deep scrub over a breadcrumb. */
export function scrubBreadcrumb<T>(breadcrumb: T): T {
	scrubInPlace(breadcrumb, new WeakSet());
	return breadcrumb;
}
