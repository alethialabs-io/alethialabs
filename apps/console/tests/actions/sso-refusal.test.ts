// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #5445 — an @better-auth/sso refusal reaches the admin as a sentence, not a digest.
//
// Every SSO mutation goes through `callAuth`, which dispatches the plugin's endpoint and, on a
// non-2xx, used to `throw new Error(<the plugin's message>)` out of a `"use server"` export. A
// production build replaces a thrown message with a digest, so "the TXT record is not there yet" or
// "issuer must be a URL" reached the SSO form as noise. Since #6129 every mutation is a
// `defineAction` returning `ActionResult`: the plugin's sentence is a `conflict` refusal, shown
// verbatim — any 4xx (a 401/403 from the session / access / entitlement middleware included), and
// any non-500 5xx carrying a better-auth `code` (the plugin's 502 `DOMAIN_VERIFICATION_FAILED` for a
// TXT record not visible yet). A 500, and a 5xx with no `code`, is the server failing: an
// `unexpected` result whose text never reaches the browser.

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
		id: "5f0c1f3a-2b1e-4c6d-9a8b-7c6d5e4f3a2b",
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

const ID = "5f0c1f3a-2b1e-4c6d-9a8b-7c6d5e4f3a2b";

/** A better-auth JSON answer with `status` — built per call, since a Response body reads once. */
function answer(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

/** The refusal result the page shows verbatim. */
function refused(message: string) {
	return { ok: false, error: { kind: "conflict", message } };
}

const NOT_VERIFIED = "Unable to verify domain ownership for acme.com. Try again later";

beforeEach(() => {
	handler.mockReset();
});

describe("SSO mutations — a plugin refusal is a value", () => {
	it("returns the IdP update refusal for the edit form to show", async () => {
		handler.mockImplementation(async () => answer(400, { message: "issuer must be a valid URL" }));
		await expect(updateSsoProvider({ id: ID, issuer: "not a url" })).resolves.toEqual(
			refused("issuer must be a valid URL"),
		);
	});

	it("returns the domain-verification refusal — the commonest answer before DNS propagates", async () => {
		// The plugin's own status for "no TXT record yet" is 502 BAD_GATEWAY, not a 4xx.
		handler.mockImplementation(async () =>
			answer(502, { code: "DOMAIN_VERIFICATION_FAILED", message: NOT_VERIFIED }),
		);
		await expect(verifySsoDomain({ id: ID })).resolves.toEqual(refused(NOT_VERIFIED));
	});

	it("returns delete and token-mint refusals too", async () => {
		handler.mockImplementation(async () => answer(404, { message: "Provider not found" }));
		await expect(deleteSsoProvider({ id: ID })).resolves.toEqual(refused("Provider not found"));
		await expect(requestSsoDomainVerification({ id: ID })).resolves.toEqual(refused("Provider not found"));
	});

	it("returns a 401/403 from the middleware in front of the plugin as a refusal too", async () => {
		// `checkProviderAccess` answers a caller who is not an admin of the provider's org with a 403
		// FORBIDDEN. The 401 below borrows the plugin's own UNAUTHORIZED sentence for an unverified
		// domain to stand for any 401 shape; `callAuth` judges the status and the body, not the path.
		handler.mockImplementation(async () =>
			answer(403, { code: "FORBIDDEN", message: "You don't have access to this provider" }),
		);
		await expect(deleteSsoProvider({ id: ID })).resolves.toEqual(refused("You don't have access to this provider"));
		handler.mockImplementation(async () =>
			answer(401, { code: "UNAUTHORIZED", message: "Provider domain has not been verified" }),
		);
		await expect(updateSsoProvider({ id: ID, issuer: "https://x" })).resolves.toEqual(
			refused("Provider domain has not been verified"),
		);
	});

	it("answers a server failure — a 500, or a bare 5xx no plugin authored — as unexpected, with no server text", async () => {
		handler.mockImplementation(async () =>
			answer(500, { code: "DOMAIN_VERIFICATION_FAILED", message: "relation sso_provider does not exist" }),
		);
		const failed = await updateSsoProvider({ id: ID, issuer: "https://x" });
		expect(failed).toMatchObject({ ok: false, error: { kind: "unexpected" } });
		expect(JSON.stringify(failed)).not.toContain("relation sso_provider");
		handler.mockImplementation(async () => new Response("upstream timed out", { status: 504 }));
		const timedOut = await verifySsoDomain({ id: ID });
		expect(timedOut).toMatchObject({ ok: false, error: { kind: "unexpected" } });
		expect(JSON.stringify(timedOut)).not.toContain("upstream timed out");
	});

	it("refuses a malformed provider id before calling the plugin", async () => {
		await expect(deleteSsoProvider({ id: "sp-1" })).resolves.toMatchObject({
			ok: false,
			error: { kind: "validation" },
		});
		expect(handler).not.toHaveBeenCalled();
	});

	it("answers success with the result, and the minted record", async () => {
		handler.mockImplementation(async () => answer(200, {}));
		await expect(updateSsoProvider({ id: ID, domain: "acme.io" })).resolves.toEqual({
			ok: true,
			data: { updated: true },
		});
		await expect(verifySsoDomain({ id: ID })).resolves.toEqual({ ok: true, data: { verified: true } });

		handler.mockImplementation(async () => answer(200, { domainVerificationToken: "tok-1" }));
		await expect(requestSsoDomainVerification({ id: ID })).resolves.toEqual({
			ok: true,
			data: { record: "_alethia-sso-okta", token: "tok-1" },
		});
	});
});
