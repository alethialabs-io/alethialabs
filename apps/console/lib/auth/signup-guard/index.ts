// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Sign-up controls (beta unit REL-L10, #6911) — the two seams lib/auth/index.ts plugs in:
//
//   - signupChallengePlugins() → a challenge on sign-in code issuance. Registered on the ONE route
//     that emails a code (`/email-otp/send-verification-otp`), so each code costs the requester a
//     solved challenge. It covers sign-in to an existing account too: the route does not know, and
//     must not reveal, whether the address has one.
//   - assertNewAccountAllowed() → the temporary-inbox refusal and the per-network daily ceiling,
//     run before a user row is written (./guard.ts says who is checked and who is not).
//
// The challenge uses Better Auth's own captcha plugin rather than a hand-rolled verifier: it calls
// the provider's verify endpoint with a timeout and fails closed on a provider outage.

import type { BetterAuthPlugin } from "better-auth";
import { APIError } from "better-auth/api";
import { captcha } from "better-auth/plugins";
import { getAuthConfig, getSignupChallengeConfig } from "@/lib/config/auth";
import { trustedClientIp } from "@/lib/auth/trusted-ip";
import { SIGNUP_CHALLENGE_ACTION, SIGNUP_NETWORK_LIMIT, SIGNUP_REFUSAL_MESSAGES } from "@/lib/auth/signup-guard/codes";
import { checkNewAccount, type SignupRequestContext } from "@/lib/auth/signup-guard/guard";
import { countSignupForNetwork, hasPendingInvitation } from "@/lib/auth/signup-guard/store";
import { log } from "@/lib/observability/log";

/** The Better Auth route that emails a sign-in code — the one the challenge guards. */
export const CODE_ISSUANCE_PATH = "/email-otp/send-verification-otp";

/**
 * The plugins that put a challenge in front of code issuance: one captcha plugin when the challenge
 * is configured (lib/config/auth.ts `getSignupChallengeConfig`), none otherwise.
 */
export function signupChallengePlugins(): BetterAuthPlugin[] {
	const cfg = getSignupChallengeConfig();
	if (cfg === null) return [];
	return [
		captcha({
			provider: cfg.provider,
			secretKey: cfg.secretKey,
			endpoints: [CODE_ISSUANCE_PATH],
			expectedAction: SIGNUP_CHALLENGE_ACTION,
		}),
	];
}

/**
 * Refuses the creation of a new account for `email` when the sign-up controls say no, by throwing
 * the Better Auth error the client sees: 403 for a temporary inbox, 429 for a network over today's
 * ceiling. Returns normally to let the creation proceed.
 *
 * The log line carries the refusal code only — never the address or the client network.
 */
export async function assertNewAccountAllowed(
	email: string,
	context: SignupRequestContext | null,
): Promise<void> {
	const refusal = await checkNewAccount(email, context, {
		clientIp: trustedClientIp,
		secret: getAuthConfig().secret,
		hasPendingInvitation,
		countSignupForNetwork,
	});
	if (refusal === null) return;
	log.warn("[auth] new account refused", { code: refusal.code });
	throw new APIError(refusal.code === SIGNUP_NETWORK_LIMIT ? "TOO_MANY_REQUESTS" : "FORBIDDEN", {
		code: refusal.code,
		message: SIGNUP_REFUSAL_MESSAGES[refusal.code],
	});
}
