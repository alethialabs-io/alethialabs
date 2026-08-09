// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Decision logic for the CLI device-code flow (RFC 8628). It lives in `lib/**` rather
 * than inside the route handlers on purpose: `lib/**` is inside the Vitest coverage
 * scope and the mutation-testing globs, `app/api/**` is in neither. The two routes
 * (`/api/auth/cli/generate` and `/api/auth/cli/exchange`) stay thin transports over
 * the predicates below.
 *
 * Deliberately dependency-free: the /cli/login page is a client component and reuses
 * the validators, so this module must not drag server-side state (the in-memory
 * lib/rate-limit store) into the browser bundle. The routes own that call; this module
 * owns the decision of WHICH key to bucket on.
 */

/**
 * How long an approved device code stays redeemable. The CLI polls every 2s while the
 * user completes the browser half, so ten minutes is generous for a human and short
 * enough that an approved-but-never-collected code does not sit redeemable forever.
 */
export const DEVICE_CODE_TTL_MS = 10 * 60_000;

/**
 * The `user_code` shape the CLI mints (`apps/cli/cmd/auth_utils.go` · `newUserCode`):
 * two groups of four from an unambiguous upper-case consonant alphabet — no 0/O, no
 * 1/I/L. The console validates the shape so a mangled or hand-crafted link cannot put
 * an unreadable string in front of the user as "the code to compare".
 */
const USER_CODE_PATTERN = /^[BCDFGHJKMNPQRSTVWXZ]{4}-[BCDFGHJKMNPQRSTVWXZ]{4}$/;

/** RFC 4122 textual UUID — the shape `alethia login` mints its device_code in. */
const DEVICE_CODE_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Rate-limit budget for the unauthenticated CLI device-code routes.
 *
 * Sized against the real client: `alethia login` polls the exchange every 2 seconds, so
 * ONE honest login is already ~30 requests/minute. 240/60s leaves room for roughly eight
 * concurrent logins behind a single NAT before anyone is throttled.
 *
 * Be honest about what this buys: a cap on how many unauthenticated DB round-trips one
 * IP can force, nothing more. It is NOT brute-force protection — the device_code is a
 * 122-bit UUID and no request budget is what makes guessing it infeasible. And because
 * lib/rate-limit.ts is in-memory and per-process, a second replica or a restart resets
 * the counter: this is a damper, not a control.
 */
export const CLI_DEVICE_RATE_LIMIT = { limit: 240, windowMs: 60_000 } as const;

/** Reports whether `value` is a well-formed CLI `user_code`. */
export function isValidUserCode(value: unknown): value is string {
	return typeof value === "string" && USER_CODE_PATTERN.test(value);
}

/** Reports whether `value` is a well-formed (UUID-shaped) `device_code`. */
export function isValidDeviceCode(value: unknown): value is string {
	return typeof value === "string" && DEVICE_CODE_PATTERN.test(value);
}

/** The deadline a newly approved device code should carry. */
export function deviceCodeExpiresAt(now: number = Date.now()): Date {
	return new Date(now + DEVICE_CODE_TTL_MS);
}

/** The lifetime columns `cli_logins` carries. Both are nullable in the schema. */
export interface DeviceCodeLifetime {
	expires_at: Date | null;
	created_at: Date | null;
}

/**
 * The moment a device code stops being redeemable, or null when neither column can
 * supply one.
 *
 * `expires_at` was never written before this change, so every row already in the table
 * has it NULL. Falling back to `created_at + TTL` (created_at has `defaultNow()`) is
 * what makes the deadline real for those rows: a lenient `expires_at && expires_at <
 * now` would leave every existing row immortal — which is the bug — while a strict
 * reject of NULL would kill every in-flight login the moment this deploys.
 */
export function deviceCodeDeadline(row: DeviceCodeLifetime): Date | null {
	if (row.expires_at) return row.expires_at;
	if (row.created_at) return new Date(row.created_at.getTime() + DEVICE_CODE_TTL_MS);
	return null;
}

/**
 * Reports whether a device-code row is past its deadline and must not be redeemed.
 * A row with no usable deadline at all fails closed (treated as expired).
 */
export function isDeviceCodeExpired(
	row: DeviceCodeLifetime,
	now: number = Date.now(),
): boolean {
	const deadline = deviceCodeDeadline(row);
	if (!deadline) return true;
	return now >= deadline.getTime();
}

/** The ownership column the binding check reads. */
export interface DeviceCodeOwner {
	profile_id: string | null;
}

/** Outcome of the generate route's ownership check. */
export type DeviceCodeBinding =
	| { ok: true }
	| { ok: false; reason: "bound_to_another_account" };

/**
 * Decides whether `profileId` may bind (or re-bind) an existing `cli_logins` row.
 *
 * This is the account-takeover gate. The route used to upsert with an unconditional
 * `onConflictDoUpdate`, so opening a phished `/cli/login?device_code=<attacker-uuid>`
 * link re-pointed the ATTACKER's device code at the victim's profile — and the
 * attacker's polling CLI collected the victim's access token, 90-day refresh token and
 * raw git-provider OAuth token. A code already owned by somebody else is now refused.
 */
export function checkDeviceCodeBinding(
	existing: DeviceCodeOwner | undefined,
	profileId: string,
): DeviceCodeBinding {
	if (!existing?.profile_id) return { ok: true };
	if (existing.profile_id === profileId) return { ok: true };
	return { ok: false, reason: "bound_to_another_account" };
}

/**
 * The client IP the limiter buckets on. ONLY `cf-connecting-ip` is trusted: production
 * is Cloudflare Tunnel → Caddy → console and Cloudflare sets/overwrites that header,
 * while a client-supplied `x-forwarded-for` is attacker-controlled — rotating it would
 * mint a fresh bucket per request and defeat the limit entirely. Mirrors the
 * `ipAddressHeaders` Better Auth is configured with in lib/auth/index.ts.
 */
export function trustedClientIp(headers: Headers): string | null {
	const ip = headers.get("cf-connecting-ip")?.trim();
	return ip ? ip : null;
}

/**
 * The rate-limit bucket key for a CLI device-code request, or null when the request
 * must NOT be limited.
 *
 * Null means FAIL OPEN, and that is deliberate: with no trusted IP header — a self-host
 * with no edge proxy in front of the console — every user would collapse into a single
 * bucket and login would break for the whole deployment. See CLI_DEVICE_RATE_LIMIT for
 * what the budget is and is not.
 */
export function cliDeviceRateLimitKey(
	route: "generate" | "exchange",
	headers: Headers,
): string | null {
	const ip = trustedClientIp(headers);
	return ip ? `cli-device:${route}:${ip}` : null;
}
