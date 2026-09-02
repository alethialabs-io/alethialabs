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
 * How long a REGISTERED-but-undecided request stays live — the window the consent screen
 * counts down.
 *
 * This is deliberately not `DEVICE_CODE_TTL_MS`. That one starts when the user presses
 * Approve and bounds how long the CLI has to redeem; this one starts when `alethia login`
 * runs and bounds how long the user has to decide. Showing the redemption window as the
 * countdown would be showing a clock for a period that has not begun.
 *
 * Ten minutes because that is `loginPollTimeout` in `apps/cli/cmd/login.go` — the point at
 * which the terminal gives up waiting. A pending window longer than that would keep offering
 * a consent screen for a login nothing is listening for any more.
 */
export const PENDING_DEVICE_CODE_TTL_MS = 10 * 60_000;

/** The deadline a freshly registered (not yet approved) device request should carry. */
export function pendingDeviceCodeExpiresAt(now: number = Date.now()): Date {
	return new Date(now + PENDING_DEVICE_CODE_TTL_MS);
}

/** The pending-window column the consent screen's countdown reads. */
export interface PendingDeviceRequestWindow {
	pending_expires_at: Date | null;
}

/**
 * Reports whether a registered request's decision window has closed.
 *
 * A row with no `pending_expires_at` fails OPEN here, and only here: that is a row written
 * by a CLI too old to register (or by `generate` directly, which never had one), and the
 * pending window is a display and refusal aid rather than the security boundary — the
 * boundary is `isDeviceCodeExpired`, which fails closed. Refusing every unregistered row
 * would break every already-shipped `alethia login` the day this deploys.
 */
export function isPendingRequestExpired(
	row: PendingDeviceRequestWindow,
	now: number = Date.now(),
): boolean {
	if (!row.pending_expires_at) return false;
	return now >= row.pending_expires_at.getTime();
}

/** The columns that say which of a device request's three lives it is in. */
export interface DeviceRequestState {
	profile_id: string | null;
	denied_at: Date | null;
}

/** Which life a `cli_logins` row is in — see the table comment in schema/accounts.ts. */
export type DeviceRequestStatus = "pending" | "approved" | "denied";

/**
 * Classifies a device request row.
 *
 * `denied` is checked FIRST and wins over an existing `profile_id`, so a refusal that lands
 * after an approval (the "I pressed the wrong button" case) is terminal rather than a race
 * whose winner is whichever column the reader happened to look at first.
 */
export function deviceRequestStatus(row: DeviceRequestState): DeviceRequestStatus {
	if (row.denied_at) return "denied";
	if (row.profile_id) return "approved";
	return "pending";
}

/** The stored `user_code`, as the binding check reads it. */
export interface DeviceCodeUserCode {
	user_code: string | null;
}

/** Outcome of comparing a request's `user_code` against the stored one. */
export type UserCodeBinding =
	| { ok: true; bound: boolean }
	| { ok: false; reason: "user_code_mismatch" };

/**
 * Decides whether `userCode` may act on a `cli_logins` row.
 *
 * The `user_code` used to be client-minted and never persisted: `generate` validated its
 * shape and then never compared it against anything, so the code on the consent screen was
 * simply whatever the link said. Registration at `alethia login` time stores it, and every
 * later request — approve, deny, read — must present the same one.
 *
 * The three arms are not symmetric, on purpose:
 *
 *  - **No row at all** → `{ ok: true, bound: false }`. Nothing has been registered, so there
 *    is nothing to disagree with. The caller writes the code it was given, which is what
 *    binds it.
 *  - **A row with a NULL `user_code`** → the same. This is a row an already-shipped CLI
 *    created by approving directly, and refusing it would log out every user of every
 *    released binary the moment this deploys. `bound: false` is the honest report: this
 *    request carries no server-verified code and the caller must not claim otherwise.
 *  - **A stored code that differs** → refused. This is the only arm that is KNOWN wrong, and
 *    it is refused rather than coerced: a mismatch means the link in the browser and the
 *    process at the terminal are not the same login.
 *
 * Comparison is exact. The validators upstream already pin the shape to upper-case
 * `AAAA-BBBB`, so a case-folding compare would only ever widen what counts as a match.
 */
export function checkUserCodeBinding(
	existing: DeviceCodeUserCode | undefined,
	userCode: string,
): UserCodeBinding {
	if (!existing || existing.user_code === null) return { ok: true, bound: false };
	if (existing.user_code === userCode) return { ok: true, bound: true };
	return { ok: false, reason: "user_code_mismatch" };
}

/**
 * The longest a client-supplied descriptive field may be before it is cut.
 *
 * These strings are rendered on a consent screen, so their only job is to be READ. 200 is
 * past every honest value (a `user-agent` is ~120 characters, a semver is ~10) and short
 * enough that nobody can push the buttons off the page — or the useful text out of view —
 * by registering a request with a megabyte of "client name".
 */
export const CLIENT_METADATA_MAX_LENGTH = 200;

/**
 * Normalises one client-supplied descriptive field: a non-string, an empty string or a
 * blank one becomes null, and anything longer than `CLIENT_METADATA_MAX_LENGTH` is cut.
 *
 * Null rather than `""` because the consent screen has to distinguish "the client did not
 * say" from "the client said nothing", and rendering an empty string as a value is how a
 * screen ends up showing a blank next to a label as though it were an answer.
 */
export function clientMetadataField(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	if (!trimmed) return null;
	return trimmed.slice(0, CLIENT_METADATA_MAX_LENGTH);
}

/**
 * Budget for `/api/auth/cli/start`, the one UNAUTHENTICATED route here that WRITES.
 *
 * Much tighter than `CLI_DEVICE_RATE_LIMIT`, because the traffic shape is the opposite:
 * `exchange` is polled every two seconds for the length of a login, whereas an honest
 * `alethia login` registers exactly once and retries at most a handful of times. 20/60s
 * still covers several people behind one NAT each starting a login in the same minute,
 * while bounding how many rows one address can insert into `cli_logins`.
 *
 * Same honesty as `CLI_DEVICE_RATE_LIMIT`: `lib/rate-limit.ts` is in-memory and
 * per-process, so a second replica or a restart resets the counter. A damper, not a control.
 */
export const CLI_DEVICE_START_RATE_LIMIT = { limit: 20, windowMs: 60_000 } as const;

/**
 * The JSON error shape every CLI device-code route answers in.
 *
 * One definition rather than a copy per route: the CLI switches on the STATUS and, for the
 * terminal refusal, on the `error` string, so two routes drifting into two shapes is a
 * client-side parse failure that shows up as "authentication failed" with nothing else.
 */
export function deviceCodeFail(error: string, status: number, description?: string) {
	return new Response(
		JSON.stringify(description ? { error, error_description: description } : { error }),
		{ status, headers: { "Content-Type": "application/json" } },
	);
}

/**
 * RFC 8628 §3.5's terminal error code for a request the user refused.
 *
 * A string constant because it is a WIRE value that two codebases have to agree on — the
 * exchange route writes it and `pollForToken` in apps/cli/cmd/login.go compares against it.
 * Spelt differently on either side, the CLI falls through to its generic
 * "authentication failed (HTTP 403)" arm and the user is told nothing about why.
 */
export const DEVICE_ACCESS_DENIED = "access_denied";

/**
 * The linked-account providers whose OAuth token approval hands to the CLI.
 *
 * ONE list, read by both the route that stashes the token (`/api/auth/cli/generate`) and
 * the one that tells the user it will be handed over (`/api/auth/cli/request`). Two copies
 * is how a consent screen ends up under-reporting: add a provider to the stash list alone
 * and approval starts handing over a token the screen never named.
 */
export const CLI_GIT_PROVIDERS = ["github", "gitlab", "bitbucket"] as const;

/** A provider whose token the device flow may hand over. */
export type CliGitProvider = (typeof CLI_GIT_PROVIDERS)[number];

/** Reports whether `providerId` is one whose token the device flow hands over. */
export function isCliGitProvider(providerId: string): providerId is CliGitProvider {
	return CLI_GIT_PROVIDERS.some((provider) => provider === providerId);
}

/** Display names for the providers, so the consent screen says "GitHub", not "github". */
const GIT_PROVIDER_LABELS: Record<CliGitProvider, string> = {
	github: "GitHub",
	gitlab: "GitLab",
	bitbucket: "Bitbucket",
};

/** One line of "what approving this hands over", for the consent screen. */
export interface DeviceApprovalScope {
	/** Stable identifier, so the page can key and order without matching on prose. */
	id: "cli_access_token" | "cli_refresh_token" | "git_provider_token";
	/** The short name of the thing being handed over. */
	label: string;
	/** What it lets the holder do, and for how long. */
	detail: string;
}

/**
 * Enumerates what pressing Approve actually hands to the terminal.
 *
 * The screen used to say "A device is asking to sign in to your account", which is true and
 * incomplete: approval returns the account's access token, a 90-day refresh token AND the
 * raw OAuth token of the first linked git provider. A git-provider token is materially more
 * than a sign-in — it is credential the user granted to Alethia being passed onward — and a
 * consent gesture is only worth what the person knew when they made it.
 *
 * `gitProvider` is null when no linked provider will contribute a token, and the third line
 * is then absent rather than hedged: a screen that lists a token that will not be handed
 * over teaches the user to discount the list.
 */
export function deviceApprovalScopes(
	gitProvider: CliGitProvider | null,
): DeviceApprovalScope[] {
	const scopes: DeviceApprovalScope[] = [
		{
			id: "cli_access_token",
			label: "An access token for your account",
			detail: "Lets the device act as you in the Alethia API. Expires after 1 hour.",
		},
		{
			id: "cli_refresh_token",
			label: "A refresh token",
			detail:
				"Lets the device mint new access tokens without asking you again, for 90 days.",
		},
	];
	if (gitProvider) {
		scopes.push({
			id: "git_provider_token",
			label: `Your ${GIT_PROVIDER_LABELS[gitProvider]} access token`,
			detail: `The OAuth token you granted Alethia for ${GIT_PROVIDER_LABELS[gitProvider]}, passed to the device as-is.`,
		});
	}
	return scopes;
}
