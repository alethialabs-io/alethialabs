// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { BetterAuthOptions } from "better-auth";
import { env } from "next-runtime-env";
import { z } from "zod";

/**
 * Typed, validated Better Auth configuration. Read once, lazily, and cached.
 * Only the secret + base URL are required; every OAuth provider and the email
 * sender are optional so a self-hoster can run with just email-OTP (or only the
 * providers they configure). The auth instance registers a social provider only
 * when its credentials are present — zero-manual for partial setups.
 */
const authConfigSchema = z.object({
	secret: z
		.string()
		.min(1, "BETTER_AUTH_SECRET is required (generate one: openssl rand -base64 32)"),
	baseURL: z.string().min(1, "BETTER_AUTH_URL or NEXT_PUBLIC_APP_URL is required"),
	trustedIpHeader: z
		.string()
		.regex(
			/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/,
			"ALETHIA_TRUSTED_IP_HEADER must be one valid HTTP header name",
		)
		.transform((value) => value.toLowerCase()),
});

export type AuthConfig = z.infer<typeof authConfigSchema>;

/** A configured OAuth provider's client credentials. */
export interface ProviderCredentials {
	clientId: string;
	clientSecret: string;
}

/** Returns credentials only when BOTH id and secret are set, else null. */
function provider(idKey: string, secretKey: string): ProviderCredentials | null {
	const clientId = env(idKey);
	const clientSecret = env(secretKey);
	return clientId && clientSecret ? { clientId, clientSecret } : null;
}

/**
 * Rate-limit policy for the Better Auth HTTP surface (/api/auth/* — sign-in,
 * email-OTP send+verify, OAuth callbacks, session). DB-backed (storage:"database")
 * so counters are consistent across replicas and survive restarts. (lib/rate-limit.ts,
 * the console's own limiter for its non-Better-Auth routes, is Postgres-backed too since
 * #5309, in its own table.)
 *
 * Enabled by default in EVERY environment: Better Auth otherwise only enforces rate
 * limiting in production, so we force it on. Set ALETHIA_AUTH_RATE_LIMIT=0 to disable
 * (e.g. load testing). Unset/empty ⇒ enabled — `!== "0"` (not `=== "1"`) so the prod
 * empty-string env trap (unset vars emitted as "") still resolves to on.
 *
 * The global window/max stays lenient enough for normal auth traffic (session polling,
 * OAuth callbacks); `customRules` clamp only the brute-force-sensitive paths — a
 * handful of attempts per minute per IP, resistant but not user-hostile:
 *  - /sign-in/email-otp                — passwordless login = the OTP-guessing target
 *  - /email-otp/send-verification-otp  — OTP issuance (email-bomb + fresh-guess surface)
 *  - /email-otp/verify-email           — email-confirmation OTP verify
 *
 * NOTE: this only covers paths served by Better Auth's catch-all handler
 * (/api/auth/[...all]). The custom CLI device-code routes (/api/auth/cli/{exchange,
 * refresh,generate}) are separate Next route handlers that never pass through this
 * handler, so nothing here applies to them. /api/auth/cli/{generate,exchange} carry
 * their own limit instead — lib/auth/cli-device-code.ts, keyed on the trusted
 * cf-connecting-ip and sized for the CLI's 2-second poll. That limiter is the
 * per-process in-memory one, so it is a damper on unauthenticated DB writes, not a
 * brute-force control; the 122-bit device_code is what makes guessing infeasible.
 * /api/auth/cli/refresh is still unlimited (it is authenticated by a signed refresh
 * JWT and does no write).
 */
export function getAuthRateLimit(): NonNullable<BetterAuthOptions["rateLimit"]> {
	return {
		enabled: env("ALETHIA_AUTH_RATE_LIMIT") !== "0",
		storage: "database",
		// Global bucket: 100 requests / 60s per IP+path.
		window: 60,
		max: 100,
		customRules: {
			// 6-digit OTP verify (login) — a few guesses per minute.
			"/sign-in/email-otp": { window: 60, max: 5 },
			// OTP issuance — email-bomb + limits how many fresh codes an attacker can mint.
			"/email-otp/send-verification-otp": { window: 60, max: 5 },
			// Email-confirmation OTP verify.
			"/email-otp/verify-email": { window: 60, max: 5 },
		},
	};
}

/** The sign-up challenge's provider configuration (Cloudflare Turnstile). */
export interface SignupChallengeConfig {
	provider: "cloudflare-turnstile";
	/** Server-side verification secret. Never sent to the browser, never logged. */
	secretKey: string;
	/** The public widget key the sign-in form renders with. */
	siteKey: string;
}

/**
 * The challenge required before a sign-in code is emailed (REL-L10, #6911), or null when it is
 * off. It is ON only when BOTH `TURNSTILE_SECRET_KEY` and `NEXT_PUBLIC_TURNSTILE_SITE_KEY` are set:
 * the server cannot verify without the secret, and the form cannot produce a token without the site
 * key — enforcing with only one of the two would refuse every sign-in code, existing accounts
 * included. A self-host without a Turnstile account therefore keeps working with the challenge off;
 * the rate limit above and the per-network sign-up ceiling still apply.
 *
 * Read on every call, not cached; it is two env reads.
 */
export function getSignupChallengeConfig(): SignupChallengeConfig | null {
	const secretKey = env("TURNSTILE_SECRET_KEY")?.trim();
	const siteKey = env("NEXT_PUBLIC_TURNSTILE_SITE_KEY")?.trim();
	if (!secretKey || !siteKey) return null;
	return { provider: "cloudflare-turnstile", secretKey, siteKey };
}

/**
 * Base URL of the GitLab instance used for OAuth + the v4 API. Defaults to the
 * public gitlab.com; set GITLAB_BASE_URL to point at a self-hosted GitLab.
 */
export function getGitlabBaseUrl(): string {
	return (env("GITLAB_BASE_URL") || "https://gitlab.com").replace(/\/+$/, "");
}

export interface AuthProviders {
	github: ProviderCredentials | null;
	google: ProviderCredentials | null;
	/** GitLab (public gitlab.com by default; GITLAB_BASE_URL for self-hosted) — wired via the genericOAuth plugin. */
	gitlab: ProviderCredentials | null;
	bitbucket: ProviderCredentials | null;
}

export interface ResolvedAuthConfig extends AuthConfig {
	providers: AuthProviders;
}

let cached: ResolvedAuthConfig | undefined;

/** Returns the validated auth config, throwing a clear error if misconfigured. */
export function getAuthConfig(): ResolvedAuthConfig {
	if (cached) return cached;

	const parsed = authConfigSchema.safeParse({
		secret: env("BETTER_AUTH_SECRET"),
		baseURL: env("BETTER_AUTH_URL") || env("NEXT_PUBLIC_APP_URL"),
		trustedIpHeader: env("ALETHIA_TRUSTED_IP_HEADER") || "cf-connecting-ip",
	});

	if (!parsed.success) {
		const issues = parsed.error.issues
			.map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
			.join("\n");
		throw new Error(
			`Invalid auth configuration:\n${issues}\n` +
				`Set BETTER_AUTH_SECRET and BETTER_AUTH_URL (or NEXT_PUBLIC_APP_URL) — see .env.example.`,
		);
	}

	cached = {
		...parsed.data,
		providers: {
			github: provider("GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET"),
			google: provider("GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"),
			gitlab: provider("GITLAB_APPLICATION_ID", "GITLAB_SECRET"),
			bitbucket: provider("BITBUCKET_KEY", "BITBUCKET_SECRET"),
		},
	};
	return cached;
}
