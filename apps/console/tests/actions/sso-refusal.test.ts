// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #5445 — an @better-auth/sso refusal reaches the admin as a sentence, not a digest.
//
// Every SSO mutation goes through `callAuth`, which dispatches the plugin's endpoint and, on a
// non-2xx, used to `throw new Error(<the plugin's message>)` out of a `"use server"` export. A
// production build replaces a thrown message with a digest, so "the TXT record is not there yet" or
// "issuer must be a URL" reached the SSO form as noise. A 4xx is now RETURNED; a 5xx still throws.
// On the old code every `resolves` below was a rejection.

import { beforeEach, describe, expect, it, vi } from "vitest";

const handler = vi.fn<(req: Request) => Promise<Response>>();

vi.mock("@/lib/authz/guard", () => ({
	authorizeQuiet: vi.fn(async () => ({ orgId: "org-1", userId: "user-1" })),
}));
vi.mock("@/lib/authz/entitlements", () => ({ getEntitlements: () => ({ sso: true }) }));
vi.mock("@/lib/auth", () => ({ auth: { handler: (req: Request) => handler(req) } }));
vi.mock("@/lib/authz", () => ({
	getPdp: () => ({ can: vi.fn().mockResolvedValue({ allowed: true }) }),
}));
vi.mock("@/lib/alerts/emit", () => ({ emitAlertEventSafe: vi.fn() }));
vi.mock("@/lib/authz/activity", () => ({ recordActivity: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/headers", () => ({ headers: vi.fn(async () => new Headers()) }));
// `ownedProvider`'s read: one OIDC provider row belonging to the actor's org.
vi.mock("@/lib/db", () => {
	const row = {
		id: "sp-1",
		providerId: "okta",
		domain: "acme.com",
		issuer: "https://acme.okta.com",
		oidcConfig: JSON.stringify({ clientId: "abc" }),
		samlConfig: null,
	};
	const chain: Record<string, unknown> = {};
	Object.assign(chain, {
		select: () => chain,
		from: () => chain,
		where: () => chain,
		limit: () => chain,
		then: (resolve: (v: unknown) => void) => resolve([row]),
	});
	return { getServiceDb: () => chain };
});

import {
	deleteSsoProvider,
	requestSsoDomainVerification,
	updateSsoProvider,
	verifySsoDomain,
} from "@/app/server/actions/sso";

/** A better-auth JSON answer with `status` — built per call, since a Response body reads once. */
function answer(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

const NOT_VERIFIED = "Unable to verify domain ownership for acme.com. Try again later";

beforeEach(() => {
	handler.mockReset();
});

describe("SSO mutations — a plugin refusal is a value", () => {
	it("returns the IdP update refusal for the edit form to show", async () => {
		handler.mockImplementation(async () => answer(400, { message: "issuer must be a valid URL" }));
		await expect(
			updateSsoProvider("sp-1", { issuer: "not a url" }),
		).resolves.toEqual({ ok: false, error: "issuer must be a valid URL" });
	});

	it("returns the domain-verification refusal — the commonest answer before DNS propagates", async () => {
		// The plugin's own status for "no TXT record yet" is 502 BAD_GATEWAY, not a 4xx.
		handler.mockImplementation(async () =>
			answer(502, { code: "DOMAIN_VERIFICATION_FAILED", message: NOT_VERIFIED }),
		);
		await expect(verifySsoDomain("sp-1")).resolves.toEqual({
			ok: false,
			error: NOT_VERIFIED,
		});
	});

	it("returns delete and token-mint refusals too", async () => {
		handler.mockImplementation(async () => answer(404, { message: "Provider not found" }));
		await expect(deleteSsoProvider("sp-1")).resolves.toEqual({
			ok: false,
			error: "Provider not found",
		});
		await expect(requestSsoDomainVerification("sp-1")).resolves.toEqual({
			ok: false,
			error: "Provider not found",
		});
	});

	it("still THROWS a server failure — a 500, or a bare 5xx no plugin authored", async () => {
		handler.mockImplementation(async () =>
			answer(500, { code: "DOMAIN_VERIFICATION_FAILED", message: "relation sso_provider does not exist" }),
		);
		await expect(updateSsoProvider("sp-1", { issuer: "https://x" })).rejects.toThrow(
			"relation sso_provider does not exist",
		);
		handler.mockImplementation(async () => new Response("upstream timed out", { status: 504 }));
		await expect(verifySsoDomain("sp-1")).rejects.toThrow("upstream timed out");
	});

	it("answers success with ok: true, and the minted record", async () => {
		handler.mockImplementation(async () => answer(200, {}));
		await expect(updateSsoProvider("sp-1", { domain: "acme.io" })).resolves.toEqual({
			ok: true,
		});
		await expect(verifySsoDomain("sp-1")).resolves.toEqual({ ok: true, verified: true });

		handler.mockImplementation(async () => answer(200, { domainVerificationToken: "tok-1" }));
		await expect(requestSsoDomainVerification("sp-1")).resolves.toEqual({
			ok: true,
			record: "_alethia-sso-okta",
			token: "tok-1",
		});
	});
});
