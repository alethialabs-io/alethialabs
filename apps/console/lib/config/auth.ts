// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

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

export interface AuthProviders {
	github: ProviderCredentials | null;
	google: ProviderCredentials | null;
	/** Self-hosted GitLab (gitlab.itgix.com) — wired via the genericOAuth plugin. */
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
