// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { nextCookies } from "better-auth/next-js";
import { emailOTP, genericOAuth, mcp } from "better-auth/plugins";
import type {
	BetterAuthOptions,
	SocialProviders,
} from "better-auth";
import { getAuthConfig, getGitlabBaseUrl } from "@/lib/config/auth";
import { getAuthPlugins } from "@/lib/auth/plugins";
import { ensureMemberGrant } from "@/lib/authz/grants";
import { provisionPrimaryOrg } from "@/lib/auth/onboarding";
import { getServiceDb } from "@/lib/db";
import {
	account,
	invitation,
	member,
	oauthAccessToken,
	oauthApplication,
	oauthConsent,
	organization,
	session,
	ssoProvider,
	team,
	teamMember,
	user,
	verification,
} from "@/lib/db/schema";
import { profiles } from "@/lib/db/schema";
import { sendSignInCodeEmail } from "@/lib/email/auth-email";
import { sendWelcomeEmail } from "@/lib/email/notify-email";

const cfg = getAuthConfig();

// Native social providers (registered only when credentials are present).
const socialProviders: SocialProviders = {};
if (cfg.providers.github) {
	socialProviders.github = {
		clientId: cfg.providers.github.clientId,
		clientSecret: cfg.providers.github.clientSecret,
		// `repo` so the linked account's token can drive the git integrations
		// (full consolidation — the login account token IS the integration token).
		// Better Auth merges its read:user/user:email defaults, so only add repo.
		scope: ["repo"],
		// Capture the GitHub login (e.g. "bobikenobi12") → seeds the org slug.
		mapProfileToUser: (profile: { login?: string }) => ({
			username: profile.login,
		}),
	};
}
if (cfg.providers.google) {
	socialProviders.google = {
		clientId: cfg.providers.google.clientId,
		clientSecret: cfg.providers.google.clientSecret,
	};
}

// Self-hosted GitLab + Bitbucket via the generic OAuth plugin (registered only
// when configured). Scopes mirror the git provider link scopes.
const genericOAuthConfigs = [];
if (cfg.providers.gitlab) {
	genericOAuthConfigs.push({
		providerId: "gitlab",
		clientId: cfg.providers.gitlab.clientId,
		clientSecret: cfg.providers.gitlab.clientSecret,
		authorizationUrl: `${getGitlabBaseUrl()}/oauth/authorize`,
		tokenUrl: `${getGitlabBaseUrl()}/oauth/token`,
		userInfoUrl: `${getGitlabBaseUrl()}/api/v4/user`,
		scopes: [
			"read_api",
			"read_user",
			"read_repository",
			"read_registry",
			"openid",
			"profile",
			"email",
		],
		// GitLab returns `username` → seeds the org slug. Return type carries an
		// (unset) `name` so it isn't a "weak type" mismatch against Partial<User>;
		// `username` is persisted at runtime (the column is registered).
		mapProfileToUser: (
			profile: Record<string, unknown>,
		): { name?: string; username?: string } => ({
			username: typeof profile.username === "string" ? profile.username : undefined,
		}),
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
		// Bitbucket returns `username` (legacy `nickname`) → seeds the org slug.
		mapProfileToUser: (
			profile: Record<string, unknown>,
		): { name?: string; username?: string } => {
			const handle = profile.username ?? profile.nickname;
			return { username: typeof handle === "string" ? handle : undefined };
		},
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
	// OAuth 2.1 authorization server for the MCP endpoint (B7): lets remote MCP
	// clients (Claude / claude.ai connectors) register dynamically and obtain an
	// access token that the /api/mcp route resolves into a PDP-scoped actor. No new
	// authority — the token's user drives getActiveScope() like any other caller.
	mcp({
		loginPage: "/login",
		oidcConfig: {
			loginPage: "/login",
			// Shown when a client requests prompt=consent (e.g. a re-auth/scope grant);
			// clients that omit it are issued a code directly (documented MVP posture).
			consentPage: "/auth/oauth/consent",
			allowDynamicClientRegistration: true,
		},
	}),
];
if (genericOAuthConfigs.length > 0) {
	plugins.push(genericOAuth({ config: genericOAuthConfigs }));
}
// Enterprise plugins (organization, SSO) via the getAuthPlugins() seam — [] in the
// community build (lib/auth/plugins.ts).
plugins.push(...getAuthPlugins());
// nextCookies MUST be last so it can set cookies on the outgoing response.
plugins.push(nextCookies());

export const auth = betterAuth({
	secret: cfg.secret,
	baseURL: cfg.baseURL,
	trustedOrigins: [cfg.baseURL],
	database: drizzleAdapter(getServiceDb(), {
		provider: "pg",
		// organization/member/invitation + ssoProvider are mapped for the enterprise
		// organization + SSO plugins (getAuthPlugins); inert in community (the plugins
		// aren't loaded).
		schema: {
			user,
			session,
			account,
			verification,
			organization,
			member,
			invitation,
			team,
			teamMember,
			ssoProvider,
			// MCP OAuth authorization-server tables (mcp() plugin → OIDC provider).
			oauthApplication,
			oauthAccessToken,
			oauthConsent,
		},
	}),
	// UUID ids so user.id populates every `user_id uuid` column + the RLS
	// backstop (current_setting('app.current_owner')::uuid).
	advanced: { database: { generateId: "uuid" } },
	emailAndPassword: { enabled: false },
	socialProviders,
	// `username` is populated server-side from the OAuth profile (mapProfileToUser),
	// never from client input — it seeds the auto-created org slug.
	user: {
		additionalFields: {
			username: { type: "string", required: false, input: false },
			// Server-managed (input:false) — set when the user finishes /onboarding.
			onboardingCompletedAt: { type: "date", required: false, input: false },
		},
	},
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
					// Owner of the personal scope (org_id == user.id) — grant + FGA tuple.
					await ensureMemberGrant(u.id, u.id, "owner");
					// Auto-create a real, named org (slug = username) and make it primary.
					await provisionPrimaryOrg({
						id: u.id,
						email: u.email,
						name: u.name ?? null,
						username: readUsername(u),
					}).catch((e) => console.error("[onboarding] org provision failed:", e));
					// Best-effort welcome (general stream); never block signup on email.
					void sendWelcomeEmail(u.email).catch((e) =>
						console.error("[email] welcome send failed:", e),
					);
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

/** Reads the optional `username` additional field off the created user, if present. */
function readUsername(u: object): string | null {
	if ("username" in u && typeof u.username === "string") return u.username;
	return null;
}
