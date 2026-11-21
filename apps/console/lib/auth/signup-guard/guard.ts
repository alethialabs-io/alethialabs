// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The decision on whether a NEW account may be created (REL-L10, #6911). Called from Better Auth's
// `databaseHooks.user.create.before` (lib/auth/index.ts), which runs for every path that creates a
// user — the emailed code, every OAuth provider, enterprise SSO — and for nothing else: signing in
// to an account that already exists never reaches it.
//
// TWO CHECKS, in this order:
//   1. Temporary-inbox address  → refused (./disposable-domains.ts). Costs nothing, counts nothing.
//   2. Per-network daily ceiling → refused once the network has created
//      `abuseLimit("signup_accounts_per_network_daily")` accounts this UTC day. The number lives in
//      the ceilings table (lib/abuse/limits.ts); this file holds no copy of it.
//
// WHO IS NOT CHECKED, and why each is safe:
//   - An address with a pending organization invitation. A member of an organization asked for it,
//     and a team joining together from one office is exactly what the network ceiling must not stop.
//   - A user created through enterprise SSO (`/sso/…`). The organization's identity provider vouched
//     for the person; the same one-office argument applies.
//   - A creation with no request behind it (server code calling the adapter directly). There is no
//     client network to count, and nothing a visitor can reach creates users that way.
//   - A request with no valid trusted client address is not counted against a network (there is
//     none to count) but is still checked for a temporary inbox. In production such a request never
//     gets here: the auth route refuses it first (lib/auth/trusted-ip.ts).
//
// The counter is spent before the user row is written, so a creation that then fails for another
// reason still uses one of the day's slots. That errs toward refusing, by at most the number of
// failed creations, and needs no second write.

import { abuseLimit } from "@/lib/abuse/limits";
import {
	SIGNUP_DISPOSABLE_EMAIL,
	SIGNUP_NETWORK_LIMIT,
	type SignupRefusalCode,
} from "@/lib/auth/signup-guard/codes";
import { isDisposableEmail } from "@/lib/auth/signup-guard/disposable-domains";
import { signupNetworkKey } from "@/lib/auth/signup-guard/network";

/** The parts of Better Auth's endpoint context the guard reads. Null when no request is behind it. */
export interface SignupRequestContext {
	path?: string;
	headers?: Headers;
	request?: Request;
}

/** Everything the decision depends on, injected so it is testable without a database or a request. */
export interface SignupGuardDeps {
	/** The client address the deployment's edge reported, or null (lib/auth/trusted-ip.ts). */
	clientIp: (headers: Headers) => string | null;
	/** The secret the network key is hashed under. */
	secret: string;
	/** Whether a pending invitation exists for the address. */
	hasPendingInvitation: (email: string) => Promise<boolean>;
	/** Spends one of the network's slots for today; false when none is left. */
	countSignupForNetwork: (key: string, limit: number) => Promise<boolean>;
	/** The environment the ceiling's override is read from. Defaults to `process.env`. */
	env?: Readonly<Record<string, string | undefined>>;
}

/** A refused sign-up: the code the client matches on. */
export interface SignupRefusal {
	code: SignupRefusalCode;
}

/** Whether this creation came through enterprise single sign-on. */
function isSsoPath(path: string | undefined): boolean {
	return path !== undefined && (path === "/sso" || path.startsWith("/sso/"));
}

/**
 * Decides whether a new account for `email` may be created by the request in `context`. Returns
 * null to allow it, or the refusal. Spends one of the network's daily slots when it allows a
 * counted creation.
 */
export async function checkNewAccount(
	email: string,
	context: SignupRequestContext | null,
	deps: SignupGuardDeps,
): Promise<SignupRefusal | null> {
	if (context === null || isSsoPath(context.path)) return null;

	let invited: boolean | undefined;
	const isInvited = async (): Promise<boolean> => {
		invited ??= await deps.hasPendingInvitation(email);
		return invited;
	};

	if (isDisposableEmail(email) && !(await isInvited())) {
		return { code: SIGNUP_DISPOSABLE_EMAIL };
	}

	const headers = context.headers ?? context.request?.headers;
	const ip = headers ? deps.clientIp(headers) : null;
	const key = ip === null ? null : signupNetworkKey(ip, deps.secret);
	if (key === null) return null;
	if (await isInvited()) return null;

	// The row's window is a UTC day, which is the window the store counts in; a unit test pins the
	// two together so a change to the table cannot silently change what "daily" means here.
	const limit = abuseLimit("signup_accounts_per_network_daily", deps.env ?? process.env);
	const allowed = await deps.countSignupForNetwork(key, limit);
	return allowed ? null : { code: SIGNUP_NETWORK_LIMIT };
}
