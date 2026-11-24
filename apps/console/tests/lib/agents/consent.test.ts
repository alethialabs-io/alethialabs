// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// The consent step's pure parts (AGT-L2, G8 and G17): reading the signed request without trusting
// it, telling expired from malformed, splitting the requested scopes, what may be granted, and the
// redirect in Better Auth's answer.

import { describe, expect, it, vi } from "vitest";

const can = vi.fn();
vi.mock("@/lib/authz", () => ({ getPdp: () => ({ can }) }));

import {
	consentRedirectUrl,
	grantableScopes,
	parseConsentRequest,
	partitionRequestedScopes,
	SCOPE_VERB,
	scopesRoleAllows,
} from "@/lib/agents/consent";

const NOW = new Date("2026-11-24T12:00:00Z");
const exp = (offsetSeconds: number) => String(Math.floor(NOW.getTime() / 1000) + offsetSeconds);

/** A query string shaped like the one Better Auth signs. */
function query(over: Record<string, string | null> = {}): string {
	const params = new URLSearchParams({
		client_id: "https://cursor.com/c.json",
		scope: "openid read plan apply",
		redirect_uri: "https://cursor.com/cb",
		exp: exp(300),
		sig: "signature-value",
	});
	for (const [key, value] of Object.entries(over)) {
		if (value === null) params.delete(key);
		else params.set(key, value);
	}
	return params.toString();
}

describe("parseConsentRequest", () => {
	it("reads the client, the scopes and the expiry", () => {
		const reading = parseConsentRequest(query(), NOW);
		expect(reading.ok).toBe(true);
		if (!reading.ok) return;
		expect(reading.request.clientId).toBe("https://cursor.com/c.json");
		expect(reading.request.requestedScopes).toEqual(["openid", "read", "plan", "apply"]);
		expect(reading.request.expiresAt.getTime()).toBe((Math.floor(NOW.getTime() / 1000) + 300) * 1000);
		expect(reading.request.key).toMatch(/^[0-9a-f]{64}$/);
	});

	it("keys the request by its signature, so a different request has a different key", () => {
		const a = parseConsentRequest(query(), NOW);
		const b = parseConsentRequest(query({ sig: "another" }), NOW);
		expect(a.ok && b.ok && a.request.key !== b.request.key).toBe(true);
	});

	it("says expired when the signed expiry has passed", () => {
		expect(parseConsentRequest(query({ exp: exp(-1) }), NOW)).toEqual({ ok: false, reason: "expired" });
	});

	it("says missing when the page was opened directly", () => {
		expect(parseConsentRequest("", NOW)).toEqual({ ok: false, reason: "missing" });
	});

	it("says malformed without a single signature or a readable expiry", () => {
		expect(parseConsentRequest(query({ sig: null }), NOW)).toEqual({ ok: false, reason: "malformed" });
		expect(parseConsentRequest(`${query()}&sig=second`, NOW)).toEqual({ ok: false, reason: "malformed" });
		expect(parseConsentRequest(query({ exp: "soon" }), NOW)).toEqual({ ok: false, reason: "malformed" });
	});
});

describe("partitionRequestedScopes", () => {
	it("splits agent, sign-in and unknown scopes, once each", () => {
		expect(partitionRequestedScopes(["openid", "read", "billing:write", "read", "profile", "admin", "destroy"])).toEqual({
			agent: ["read", "destroy"],
			oidc: ["openid", "profile"],
			unknown: ["billing:write", "admin"],
		});
	});
});

describe("grantableScopes", () => {
	it("is what was requested and the role allows", () => {
		expect(grantableScopes(["read", "plan", "apply"], ["read", "plan", "design"])).toEqual(["read", "plan"]);
	});
});

describe("scopesRoleAllows", () => {
	it("asks the PDP for each scope's project verb", async () => {
		can.mockImplementation(async (_actor: unknown, verb: string) => ({ allowed: verb === "view" || verb === "plan" }));
		const actor = { userId: "u", orgId: "o", credential: "session" as const };
		expect(await scopesRoleAllows(actor)).toEqual(["read", "plan"]);
		expect(can).toHaveBeenCalledWith(actor, SCOPE_VERB.apply, { type: "project" });
	});
});

describe("consentRedirectUrl", () => {
	it("reads each shape the provider has answered with", () => {
		expect(consentRedirectUrl({ redirect: true, url: "https://a.test/cb?code=1" })).toBe("https://a.test/cb?code=1");
		expect(consentRedirectUrl({ redirect_uri: "https://a.test/cb" })).toBe("https://a.test/cb");
		expect(consentRedirectUrl({ redirectURI: "https://a.test/cb" })).toBe("https://a.test/cb");
	});

	it("finds nothing in anything else", () => {
		expect(consentRedirectUrl(null)).toBeNull();
		expect(consentRedirectUrl({ url: "" })).toBeNull();
		expect(consentRedirectUrl("https://a.test")).toBeNull();
	});
});
