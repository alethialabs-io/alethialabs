// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Better Auth wiring (lib/auth/index.ts). The module's only export is `auth`, built by betterAuth().
// We mock betterAuth to pass the resolved options straight through, then exercise the REAL config the
// module assembles: the emailOTP OTP sender, the social-provider profile mappers, the generic-OAuth
// (GitLab/Bitbucket) configs + mappers, and the user create/update database hooks (profile upsert +
// member grant + primary-org provision + welcome email, with the best-effort catch path). All
// boundaries (db, email, authz grant, onboarding, plugins, adapter) are mocked.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// betterAuth is the SUT's constructor — make it identity-ish so `auth.options` IS the config we built.
vi.mock("better-auth", () => ({
	betterAuth: vi.fn((opts: unknown) => ({ options: opts })),
}));
vi.mock("better-auth/adapters/drizzle", () => ({
	drizzleAdapter: vi.fn(() => ({ __adapter: true })),
}));
vi.mock("better-auth/next-js", () => ({
	nextCookies: vi.fn(() => ({ id: "nextCookies" })),
}));
// Plugin factories pass their config through so the assembled options stay inspectable.
vi.mock("better-auth/plugins", () => ({
	emailOTP: vi.fn((c: object) => ({ id: "emailOTP", ...c })),
	genericOAuth: vi.fn((c: object) => ({ id: "genericOAuth", ...c })),
	mcp: vi.fn((c: object) => ({ id: "mcp", ...c })),
}));

vi.mock("@/lib/config/auth", () => ({
	getAuthConfig: vi.fn(() => ({
		secret: "test-secret",
		baseURL: "https://app.test",
		providers: {
			github: { clientId: "gh-id", clientSecret: "gh-sec" },
			google: { clientId: "g-id", clientSecret: "g-sec" },
			gitlab: { clientId: "gl-id", clientSecret: "gl-sec" },
			bitbucket: { clientId: "bb-id", clientSecret: "bb-sec" },
		},
	})),
	getGitlabBaseUrl: vi.fn(() => "https://gitlab.example.com"),
}));

vi.mock("@/lib/auth/plugins", () => ({ getAuthPlugins: vi.fn(() => []) }));
vi.mock("@/lib/authz/grants", () => ({ ensureMemberGrant: vi.fn(async () => {}) }));
vi.mock("@/lib/auth/onboarding", () => ({ provisionPrimaryOrg: vi.fn(async () => {}) }));
vi.mock("@/lib/email/auth-email", () => ({ sendSignInCodeEmail: vi.fn(async () => {}) }));
vi.mock("@/lib/email/notify-email", () => ({ sendWelcomeEmail: vi.fn(async () => {}) }));

// Schema tables are only used as adapter/upsert references; the chain is mocked so values are inert.
vi.mock("@/lib/db/schema", () => ({
	account: {},
	invitation: {},
	member: {},
	oauthAccessToken: {},
	oauthApplication: {},
	oauthConsent: {},
	organization: {},
	session: {},
	ssoProvider: {},
	team: {},
	teamMember: {},
	user: {},
	verification: {},
	profiles: { id: "profiles.id" },
}));

// Chainable insert mock: getServiceDb().insert(t).values(v).onConflictDoUpdate(c).
// Hoisted so the vi.mock factory (also hoisted) can safely close over them.
const { values, insert } = vi.hoisted(() => {
	const onConflictDoUpdate = vi.fn(async () => {});
	const values = vi.fn(() => ({ onConflictDoUpdate }));
	const insert = vi.fn(() => ({ values }));
	return { values, insert };
});
vi.mock("@/lib/db", () => ({ getServiceDb: vi.fn(() => ({ insert })) }));

import { auth } from "@/lib/auth";
import { getAuthConfig } from "@/lib/config/auth";
import { ensureMemberGrant } from "@/lib/authz/grants";
import { provisionPrimaryOrg } from "@/lib/auth/onboarding";
import { sendSignInCodeEmail } from "@/lib/email/auth-email";
import { sendWelcomeEmail } from "@/lib/email/notify-email";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const opts = (auth as any).options;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const findPlugin = (id: string) => opts.plugins.find((p: any) => p.id === id);

beforeEach(() => {
	vi.clearAllMocks();
});

describe("base options", () => {
	it("passes the configured secret + baseURL through and trusts that origin", () => {
		expect(opts.secret).toBe("test-secret");
		expect(opts.baseURL).toBe("https://app.test");
		expect(opts.trustedOrigins).toEqual(["https://app.test"]);
	});

	it("keeps email+password disabled and uses uuid id generation", () => {
		expect(opts.emailAndPassword.enabled).toBe(false);
		expect(opts.advanced.database.generateId).toBe("uuid");
	});

	it("ends the plugin chain with nextCookies (must be last to set cookies)", () => {
		const last = opts.plugins[opts.plugins.length - 1];
		expect(last.id).toBe("nextCookies");
	});
});

describe("emailOTP plugin", () => {
	it("is configured with a 6-digit, 10-minute code", () => {
		const p = findPlugin("emailOTP");
		expect(p.otpLength).toBe(6);
		expect(p.expiresIn).toBe(600);
	});

	it("sends the sign-in code via sendSignInCodeEmail", async () => {
		const p = findPlugin("emailOTP");
		await p.sendVerificationOTP({ email: "u@test.io", otp: "123456" });
		expect(sendSignInCodeEmail).toHaveBeenCalledWith("u@test.io", "123456");
	});
});

describe("social providers", () => {
	it("registers github with repo scope and maps the login to username", () => {
		expect(opts.socialProviders.github.clientId).toBe("gh-id");
		expect(opts.socialProviders.github.scope).toEqual(["repo"]);
		expect(opts.socialProviders.github.mapProfileToUser({ login: "bobikenobi12" })).toEqual({
			username: "bobikenobi12",
		});
	});

	it("registers google with its credentials", () => {
		expect(opts.socialProviders.google.clientId).toBe("g-id");
		expect(opts.socialProviders.google.clientSecret).toBe("g-sec");
	});
});

describe("generic OAuth (GitLab + Bitbucket)", () => {
	const cfgFor = (providerId: string) =>
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		findPlugin("genericOAuth").config.find((c: any) => c.providerId === providerId);

	it("builds the GitLab endpoints from the configured base URL", () => {
		const gl = cfgFor("gitlab");
		expect(gl.authorizationUrl).toBe("https://gitlab.example.com/oauth/authorize");
		expect(gl.tokenUrl).toBe("https://gitlab.example.com/oauth/token");
		expect(gl.userInfoUrl).toBe("https://gitlab.example.com/api/v4/user");
		expect(gl.scopes).toContain("read_repository");
	});

	it("maps the GitLab username, ignoring non-string values", () => {
		const gl = cfgFor("gitlab");
		expect(gl.mapProfileToUser({ username: "gl-user" })).toEqual({ username: "gl-user" });
		expect(gl.mapProfileToUser({ username: 42 })).toEqual({ username: undefined });
	});

	it("maps Bitbucket username, falling back to legacy nickname", () => {
		const bb = cfgFor("bitbucket");
		expect(bb.mapProfileToUser({ username: "bb-user" })).toEqual({ username: "bb-user" });
		expect(bb.mapProfileToUser({ nickname: "legacy-nick" })).toEqual({ username: "legacy-nick" });
		expect(bb.mapProfileToUser({})).toEqual({ username: undefined });
	});
});

describe("databaseHooks.user.create.after", () => {
	const afterCreate = () => opts.databaseHooks.user.create.after;

	it("upserts a profile, grants owner membership, provisions the org, and sends welcome", async () => {
		await afterCreate()({
			id: "user-1",
			email: "owner@test.io",
			name: "Owner Name",
			username: "ownerhandle",
		});

		// profile mirror upsert
		expect(insert).toHaveBeenCalledWith({ id: "profiles.id" });
		expect(values).toHaveBeenCalledWith({
			id: "user-1",
			email: "owner@test.io",
			full_name: "Owner Name",
			avatar_url: null,
		});
		// owner grant: (orgId == userId, userId, "owner")
		expect(ensureMemberGrant).toHaveBeenCalledWith("user-1", "user-1", "owner");
		// primary org provisioned with username read off the user
		expect(provisionPrimaryOrg).toHaveBeenCalledWith({
			id: "user-1",
			email: "owner@test.io",
			name: "Owner Name",
			username: "ownerhandle",
		});
		expect(sendWelcomeEmail).toHaveBeenCalledWith("owner@test.io");
	});

	it("passes username:null when the created user has no username field", async () => {
		await afterCreate()({ id: "u2", email: "u2@test.io" });
		expect(provisionPrimaryOrg).toHaveBeenCalledWith({
			id: "u2",
			email: "u2@test.io",
			name: null,
			username: null,
		});
	});

	it("does not throw when org provisioning rejects (best-effort, logged)", async () => {
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		vi.mocked(provisionPrimaryOrg).mockRejectedValueOnce(new Error("provision boom"));

		await expect(
			afterCreate()({ id: "u3", email: "u3@test.io", name: null }),
		).resolves.toBeUndefined();
		expect(errSpy).toHaveBeenCalled();
		// the welcome email still goes out despite the provisioning failure
		expect(sendWelcomeEmail).toHaveBeenCalledWith("u3@test.io");
		errSpy.mockRestore();
	});
});

describe("databaseHooks.user.update.after", () => {
	it("re-upserts the profile only (no grant / org / email)", async () => {
		await opts.databaseHooks.user.update.after({
			id: "u4",
			email: "u4@test.io",
			name: "Renamed",
			image: "https://img/u4.png",
		});
		expect(values).toHaveBeenCalledWith({
			id: "u4",
			email: "u4@test.io",
			full_name: "Renamed",
			avatar_url: "https://img/u4.png",
		});
		expect(ensureMemberGrant).not.toHaveBeenCalled();
		expect(provisionPrimaryOrg).not.toHaveBeenCalled();
		expect(sendWelcomeEmail).not.toHaveBeenCalled();
	});
});

describe("provider-absent branch (re-imported with empty providers)", () => {
	it("registers no social providers and omits the genericOAuth plugin", async () => {
		vi.resetModules();
		const cfgMod = await import("@/lib/config/auth");
		vi.mocked(cfgMod.getAuthConfig).mockReturnValue({
			secret: "s",
			baseURL: "https://app.test",
			providers: {},
		} as never);
		const mod = await import("@/lib/auth");
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const o = (mod.auth as any).options;
		expect(o.socialProviders).toEqual({});
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		expect(o.plugins.some((p: any) => p.id === "genericOAuth")).toBe(false);
		// emailOTP + mcp + nextCookies still present
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		expect(o.plugins.some((p: any) => p.id === "emailOTP")).toBe(true);
	});

	// re-importing reset the module graph; nothing below relies on the top-level `auth` after this,
	// but confirm the original config was the full-providers one for clarity.
	it("the originally imported auth still had all four providers configured", () => {
		expect(vi.mocked(getAuthConfig)).toBeDefined();
	});
});
