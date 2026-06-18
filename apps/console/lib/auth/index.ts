// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { nextCookies } from "better-auth/next-js";
import { emailOTP, genericOAuth } from "better-auth/plugins";
import type {
	BetterAuthOptions,
	SocialProviders,
} from "better-auth";
import { getAuthConfig } from "@/lib/config/auth";
import { getServiceDb } from "@/lib/db";
import { account, session, user, verification } from "@/lib/db/schema";
import { profiles } from "@/lib/db/schema";
import { sendSignInCodeEmail } from "@/lib/email/auth-email";

const cfg = getAuthConfig();

// Native social providers (registered only when credentials are present).
const socialProviders: SocialProviders = {};
if (cfg.providers.github) {
	socialProviders.github = {
		clientId: cfg.providers.github.clientId,
		clientSecret: cfg.providers.github.clientSecret,
		// `repo` so the linked account's token can drive the git integrations
		// (full consolidation — the login account token IS the integration token).
		scope: ["repo", "read:user", "user:email"],
	};
}
if (cfg.providers.google) {
	socialProviders.google = {
		clientId: cfg.providers.google.clientId,
		clientSecret: cfg.providers.google.clientSecret,
	};
}

// Self-hosted GitLab + Bitbucket via the generic OAuth plugin (registered only
// when configured). Scopes mirror the pre-cutover Supabase link scopes.
const genericOAuthConfigs = [];
if (cfg.providers.gitlab) {
	genericOAuthConfigs.push({
		providerId: "gitlab",
		clientId: cfg.providers.gitlab.clientId,
		clientSecret: cfg.providers.gitlab.clientSecret,
		authorizationUrl: "https://gitlab.itgix.com/oauth/authorize",
		tokenUrl: "https://gitlab.itgix.com/oauth/token",
		userInfoUrl: "https://gitlab.itgix.com/api/v4/user",
		scopes: [
			"read_api",
			"read_user",
			"read_repository",
			"read_registry",
			"openid",
			"profile",
			"email",
		],
	});
}
if (cfg.providers.bitbucket) {
	genericOAuthConfigs.push({
		providerId: "bitbucket",
		clientId: cfg.providers.bitbucket.clientId,
		clientSecret: cfg.providers.bitbucket.clientSecret,
		authorizationUrl: "https://bitbucket.org/site/oauth2/authorize",
		tokenUrl: "https://bitbucket.org/site/oauth2/access_token",
		userInfoUrl: "https://api.bitbucket.org/2.0/user",
		scopes: ["account", "repository"],
	});
}

const plugins: BetterAuthOptions["plugins"] = [
	emailOTP({
		otpLength: 6,
		expiresIn: 600, // 10 minutes — matches the email template copy.
		async sendVerificationOTP({ email, otp }) {
			await sendSignInCodeEmail(email, otp);
		},
	}),
];
if (genericOAuthConfigs.length > 0) {
	plugins.push(genericOAuth({ config: genericOAuthConfigs }));
}
// nextCookies MUST be last so it can set cookies on the outgoing response.
plugins.push(nextCookies());

export const auth = betterAuth({
	secret: cfg.secret,
	baseURL: cfg.baseURL,
	trustedOrigins: [cfg.baseURL],
	database: drizzleAdapter(getServiceDb(), {
		provider: "pg",
		schema: { user, session, account, verification },
	}),
	// UUID ids so user.id populates every `user_id uuid` column + the RLS
	// backstop (current_setting('app.current_owner')::uuid).
	advanced: { database: { generateId: "uuid" } },
	emailAndPassword: { enabled: false },
	socialProviders,
	account: {
		accountLinking: {
			enabled: true,
			trustedProviders: ["github", "google", "gitlab", "bitbucket"],
		},
	},
	databaseHooks: {
		user: {
			create: {
				after: async (u) => {
					await upsertProfile(u);
				},
			},
			update: {
				after: async (u) => {
					await upsertProfile(u);
				},
			},
		},
	},
	plugins,
});

/**
 * Mirrors the Better Auth user into the legacy `profiles` table (id == user.id)
 * so CLI auth + display + the cli_logins.profile_id FK keep working unchanged.
 */
async function upsertProfile(u: {
	id: string;
	email: string;
	name?: string | null;
	image?: string | null;
}): Promise<void> {
	await getServiceDb()
		.insert(profiles)
		.values({
			id: u.id,
			email: u.email,
			full_name: u.name ?? null,
			avatar_url: u.image ?? null,
		})
		.onConflictDoUpdate({
			target: profiles.id,
			set: { email: u.email, full_name: u.name ?? null, avatar_url: u.image ?? null },
		});
}
