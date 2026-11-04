// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment node

// #6109: a sign-in code email that fails to send must reach the client as an error, not as
// `{ success: true }` (which the form renders as "We sent a 6-digit code").
//
// This deliberately runs the REAL Better Auth request pipeline — the installed better-auth,
// the real emailOTP plugin, the real hook dispatch — against an in-memory adapter, and drives
// it through `auth.handler` with a real Request, the way the catch-all route does. The fix
// rests on two facts about Better Auth's internals (the send is awaited before the after-hooks
// run, and the handler and the after-hook see the same per-request AuthContext). A test with
// betterAuth mocked out (tests/lib/auth/index.test.ts) cannot see either, so an upgrade that
// broke one would leave that suite green and put the silent "code sent" back. This one goes red.
//
// Only the boundaries are mocked: the email sender (the "provider"), the DB handle, config,
// and the plugins this behaviour does not touch.

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
	send: vi.fn<(to: string, code: string) => Promise<void>>(async () => {}),
	db: {} as Record<string, Record<string, unknown>[]>,
}));

vi.mock("server-only", () => ({}));
vi.mock("better-auth/adapters/drizzle", async () => {
	const { memoryAdapter } = await import("better-auth/adapters/memory");
	return { drizzleAdapter: vi.fn(() => memoryAdapter(h.db)) };
});
// nextCookies reaches for next/headers, which has no request scope here; it only sets cookies.
vi.mock("better-auth/next-js", () => ({ nextCookies: vi.fn(() => ({ id: "next-cookies" })) }));
// The MCP authorization server is orthogonal to sign-in codes and drags in its own schema.
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
}));
vi.mock("@/lib/auth/plugins", () => ({ getAuthPlugins: vi.fn(() => []) }));
vi.mock("@/lib/authz/grants", () => ({ ensureMemberGrant: vi.fn(async () => {}) }));
vi.mock("@/lib/auth/onboarding", () => ({ provisionPrimaryOrg: vi.fn(async () => {}) }));
vi.mock("@/lib/db", () => ({ getServiceDb: vi.fn(() => ({})) }));
vi.mock("@/lib/email/auth-email", () => ({
	sendSignInCodeEmail: (to: string, code: string) => h.send(to, code),
}));
vi.mock("@/lib/email/notify-email", () => ({ sendWelcomeEmail: vi.fn(async () => {}) }));

import { auth } from "@/lib/auth/index";

const KNOWN = "known@example.com";
const UNKNOWN = "nobody@example.com";

/** POSTs to the send-code route exactly as the browser's auth client does. */
async function requestCode(email: string, type = "sign-in"): Promise<Response> {
	return auth.handler(
		new Request("https://app.test/api/auth/email-otp/send-verification-otp", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				origin: "https://app.test",
				"cf-connecting-ip": "203.0.113.7",
			},
			body: JSON.stringify({ email, type }),
		}),
	);
}

/**
 * Makes the email provider throw, the way an outage or a missing EMAIL_PROVIDER does.
 *
 * The failure arrives after a real timer tick, as a network call's would. An immediately
 * rejected promise settles within a few microtasks — fast enough to beat the after-hook even
 * if the send were fire-and-forget (`advanced.backgroundTasks.handler`), which would leave
 * this suite green over exactly the regression it exists to catch. Measured: with the
 * immediate rejection, adding a background handler passed all six tests.
 */
function providerDown(): void {
	h.send.mockImplementation(async () => {
		await new Promise((resolve) => setTimeout(resolve, 10));
		throw new Error("email provider unavailable");
	});
}

beforeEach(() => {
	for (const key of Object.keys(h.db)) delete h.db[key];
	Object.assign(h.db, {
		user: [
			{
				id: "u-known",
				email: KNOWN,
				name: "Known",
				emailVerified: true,
				createdAt: new Date(),
				updatedAt: new Date(),
			},
		],
		session: [],
		account: [],
		verification: [],
	});
	h.send.mockReset();
	h.send.mockResolvedValue(undefined);
});

describe("sending a sign-in code (#6109)", () => {
	it("answers 200 when the email goes out", async () => {
		const res = await requestCode(KNOWN);

		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ success: true });
		expect(h.send).toHaveBeenCalledWith(KNOWN, expect.stringMatching(/^\d{6}$/));
	});

	it("answers an error the form can render when the provider throws", async () => {
		providerDown();
		const res = await requestCode(KNOWN);

		expect(res.status).toBe(503);
		expect(await res.json()).toMatchObject({
			code: "SIGN_IN_CODE_SEND_FAILED",
			message: "We couldn’t send the code — try again.",
		});
	});

	it("reports the failure exactly once", async () => {
		providerDown();
		const spy = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			await requestCode(KNOWN);
			// Better Auth's own "Failed to run background task" log is the second report the
			// sender's catch exists to prevent; ours is the only line.
			expect(spy).toHaveBeenCalledTimes(1);
			expect(String(spy.mock.calls[0]?.[0])).toContain("[auth] sign-in code email failed");
		} finally {
			spy.mockRestore();
		}
	});

	it("answers an unknown address exactly as it answers a registered one", async () => {
		// Not an enumeration oracle: with sign-up enabled Better Auth sends a sign-in code to
		// ANY address, so a failure is reached the same way whether or not one exists.
		providerDown();
		const known = await requestCode(KNOWN);
		const unknown = await requestCode(UNKNOWN);

		expect(unknown.status).toBe(known.status);
		expect(await unknown.json()).toEqual(await known.json());
		expect(h.send).toHaveBeenCalledWith(UNKNOWN, expect.any(String));
	});

	it("does not carry one request's failure into the next", async () => {
		providerDown();
		expect((await requestCode(KNOWN)).status).toBe(503);

		h.send.mockResolvedValue(undefined);
		const res = await requestCode(KNOWN);
		expect(res.status).toBe(200);
	});

	it("leaves the other OTP types as Better Auth answers them", async () => {
		// These skip the send for an unknown address, so surfacing their failures WOULD say
		// which addresses are registered. Only "sign-in" is surfaced.
		providerDown();
		const res = await requestCode(KNOWN, "email-verification");

		expect(res.status).toBe(200);
		expect(h.send).toHaveBeenCalled();
	});
});
