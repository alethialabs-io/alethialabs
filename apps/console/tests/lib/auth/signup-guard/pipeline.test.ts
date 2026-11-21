// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment node

// REL-L10 (#6911) through the REAL Better Auth request pipeline: the installed better-auth, its
// captcha and emailOTP plugins and its database-hook dispatch, against an in-memory adapter, driven
// through `auth.handler` with real Requests the way the catch-all route is. A suite with
// betterAuth mocked (tests/lib/auth/index.test.ts) can only see that the hook is wired; this one
// sees that a refusal really stops the user row and reaches the client with its code.
//
// Mocked boundaries only: the challenge provider's verify endpoint (global fetch), the email
// sender, the bucket/invitation store, config, and the plugins this behaviour does not touch.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
	codes: new Map<string, string>(),
	db: {} as Record<string, Record<string, unknown>[]>,
	buckets: new Map<string, number>(),
}));

vi.mock("server-only", () => ({}));
vi.mock("better-auth/adapters/drizzle", async () => {
	const { memoryAdapter } = await import("better-auth/adapters/memory");
	return { drizzleAdapter: vi.fn(() => memoryAdapter(h.db)) };
});
vi.mock("better-auth/next-js", () => ({ nextCookies: vi.fn(() => ({ id: "next-cookies" })) }));
vi.mock("@better-auth/mcp", () => ({ mcp: vi.fn(() => ({ id: "mcp" })) }));
vi.mock("@better-auth/cimd", () => ({ cimd: vi.fn(() => ({ id: "cimd" })) }));
vi.mock("@better-auth/cimd/node", () => ({ fetchClientMetadataResource: vi.fn() }));
vi.mock("@/lib/config/auth", () => ({
	getAuthConfig: vi.fn(() => ({
		secret: "test-secret-test-secret-test-secret-0123",
		baseURL: "https://app.test",
		trustedIpHeader: "cf-connecting-ip",
		providers: {},
	})),
	getGitlabBaseUrl: vi.fn(() => "https://gitlab.example.com"),
	getAuthRateLimit: vi.fn(() => ({ enabled: false })),
	getSignupChallengeConfig: vi.fn(() => ({
		provider: "cloudflare-turnstile",
		secretKey: "challenge-secret",
		siteKey: "challenge-site-key",
	})),
}));
vi.mock("@/lib/auth/plugins", () => ({ getAuthPlugins: vi.fn(() => []) }));
vi.mock("@/lib/authz/grants", () => ({ ensureMemberGrant: vi.fn(async () => {}) }));
vi.mock("@/lib/auth/onboarding", () => ({ provisionPrimaryOrg: vi.fn(async () => {}) }));
// The profile mirror in the create-after hook: an insert chain that accepts anything.
vi.mock("@/lib/db", () => {
	const onConflictDoUpdate = async () => {};
	const values = () => ({ onConflictDoUpdate });
	return { getServiceDb: vi.fn(() => ({ insert: () => ({ values }) })) };
});
vi.mock("@/lib/email/auth-email", () => ({
	sendSignInCodeEmail: async (to: string, code: string) => {
		h.codes.set(to, code);
	},
}));
vi.mock("@/lib/email/notify-email", () => ({ sendWelcomeEmail: vi.fn(async () => {}) }));
// The bucket table, in memory, with the same contract: a refused hit is not counted.
vi.mock("@/lib/auth/signup-guard/store", () => ({
	UTC_DAY_MS: 86_400_000,
	countSignupForNetwork: async (key: string, limit: number) => {
		const n = h.buckets.get(key) ?? 0;
		if (n >= limit) return false;
		h.buckets.set(key, n + 1);
		return true;
	},
	hasPendingInvitation: async () => false,
}));

import { auth } from "@/lib/auth/index";
import { SIGNUP_CHALLENGE_ACTION } from "@/lib/auth/signup-guard/codes";

/** What the stubbed verify endpoint answers for a token. */
const VERDICTS: Record<string, { success: boolean; action?: string }> = {
	"good-token": { success: true, action: SIGNUP_CHALLENGE_ACTION },
	"good-token-2": { success: true, action: SIGNUP_CHALLENGE_ACTION },
	"failed-token": { success: false },
	"other-action-token": { success: true, action: "some-other-widget" },
};

const verify = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
	const body: unknown = JSON.parse(String(init?.body ?? "{}"));
	const token =
		typeof body === "object" && body !== null && "response" in body && typeof body.response === "string"
			? body.response
			: "";
	return Response.json(VERDICTS[token] ?? { success: false });
});

/** POSTs to `path` under /api/auth as the browser's auth client does. */
function post(path: string, body: object, extra: Record<string, string> = {}, ip = "203.0.113.7") {
	return auth.handler(
		new Request(`https://app.test/api/auth${path}`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				origin: "https://app.test",
				"cf-connecting-ip": ip,
				...extra,
			},
			body: JSON.stringify(body),
		}),
	);
}

/** Requests a code with a challenge token. */
function requestCode(email: string, token: string | null, ip?: string) {
	return post(
		"/email-otp/send-verification-otp",
		{ email, type: "sign-in" },
		token === null ? {} : { "x-captcha-response": token },
		ip,
	);
}

/** Requests a code (with a passing token) and then signs in with it. */
async function signUp(email: string, ip?: string, token = "good-token") {
	const sent = await requestCode(email, token, ip);
	expect(sent.status).toBe(200);
	const otp = h.codes.get(email);
	expect(otp).toBeDefined();
	return post("/sign-in/email-otp", { email, otp }, {}, ip);
}

beforeEach(() => {
	for (const key of Object.keys(h.db)) delete h.db[key];
	Object.assign(h.db, { user: [], session: [], account: [], verification: [] });
	h.codes.clear();
	h.buckets.clear();
	verify.mockClear();
	vi.stubGlobal("fetch", verify);
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
});

describe("challenge on code issuance", () => {
	it.each(["known@example.com", "new@example.org"])("sends no code without a token (%s)", async (email) => {
		const res = await requestCode(email, null);
		expect(res.status).toBe(400);
		expect(h.codes.has(email)).toBe(false);
	});

	it.each(["failed-token", "other-action-token"])("sends no code for a token that does not verify (%s)", async (token) => {
		const res = await requestCode("someone@example.com", token);
		expect(res.status).toBe(403);
		expect(h.codes.has("someone@example.com")).toBe(false);
	});

	it.each(["good-token", "good-token-2"])("sends the code for a verified token (%s)", async (token) => {
		const res = await requestCode("someone@example.com", token);
		expect(res.status).toBe(200);
		expect(h.codes.has("someone@example.com")).toBe(true);
		expect(verify).toHaveBeenCalledTimes(1);
	});

	it("fails closed when the challenge provider is unreachable", async () => {
		verify.mockRejectedValueOnce(new Error("network down"));
		const res = await requestCode("someone@example.com", "good-token");
		expect(res.status).toBeGreaterThanOrEqual(500);
		expect(h.codes.has("someone@example.com")).toBe(false);
	});
});

describe("new-account refusals", () => {
	it.each(["temp@mailinator.com", "temp@sharklasers.com"])(
		"refuses a temporary-inbox address and writes no user (%s)",
		async (email) => {
			const res = await signUp(email);
			expect(res.status).toBe(403);
			expect(await res.json()).toMatchObject({ code: "SIGNUP_DISPOSABLE_EMAIL" });
			expect(h.db.user).toEqual([]);
		},
	);

	it.each([
		["198.51.100.10", "198.51.100.11"],
		["2001:db8:5:6::1", "2001:db8:5:7::1"],
	])("refuses a network over the ceiling (%s) and not its neighbour (%s)", async (ip, neighbour) => {
		vi.stubEnv("ALETHIA_SIGNUP_ACCOUNTS_PER_NETWORK_DAILY", "1");

		expect((await signUp("first@example.com", ip)).status).toBe(200);

		const refused = await signUp("second@example.com", ip, "good-token-2");
		expect(refused.status).toBe(429);
		expect(await refused.json()).toMatchObject({ code: "SIGNUP_NETWORK_LIMIT" });
		expect(h.db.user?.map((u) => u.email)).toEqual(["first@example.com"]);

		expect((await signUp("third@example.com", neighbour)).status).toBe(200);
	});

	it("never refuses sign-in to an account that already exists", async () => {
		vi.stubEnv("ALETHIA_SIGNUP_ACCOUNTS_PER_NETWORK_DAILY", "1");
		const ip = "198.51.100.20";
		expect((await signUp("owner@example.com", ip)).status).toBe(200);
		// The network is now at its ceiling; the same person signing in again is not a new account.
		expect((await signUp("owner@example.com", ip, "good-token-2")).status).toBe(200);
	});
});
