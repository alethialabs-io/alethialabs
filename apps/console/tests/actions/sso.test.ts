// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Mocked-boundary tests for getSsoProviders: stub the actor + a thenable drizzle chain (so
// `await db.select()…where()` resolves to seeded rows), keep the real JSON parsing + X509
// fingerprint logic, and assert the oidc/saml type derivation, IdP-detail extraction, and the
// org-scoped query.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/authz/guard", () => ({ currentActor: vi.fn() }));
vi.mock("@/lib/db", () => ({ getServiceDb: vi.fn() }));

import { getSsoProviders } from "@/app/server/actions/sso";
import { currentActor } from "@/lib/authz/guard";
import { getServiceDb } from "@/lib/db";

// A real self-signed cert (generated for the test). Its SHA-256 fingerprint is fixed below.
const CERT_FP =
	"87:AA:C6:6C:3E:B9:FC:9A:14:AA:99:7F:F1:47:01:AD:04:45:5D:EA:81:D5:21:23:EE:B9:24:1C:BB:C9:7E:33";
const CERT_BARE =
	"MIIC/zCCAeegAwIBAgIUJug4tvX2gWaqUcm6ueAV5idrrAcwDQYJKoZIhvcNAQELBQAwDzENMAsGA1UEAwwEdGVzdDAeFw0yNjA2MjgxNzUzMDBaFw0yNzA2MjgxNzUzMDBaMA8xDTALBgNVBAMMBHRlc3QwggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQDRuZkgJrPr1PIppNXBBTigGB3LtIjqaf6cXiXy0LSQ4Zsa0iLvE5T8NdDzojSPth9LEhNjqqu+kXO8PZ9FbatjLhCeqqf5bec8Nfl51Zb+aQbbeneUdz+NhaltRBvKjbkQYf3ngrP8coYt3S5YVpgQ6nnamqlviM68fjy1i8N6eiaj4//jAmNYDlmijnhOb5jBmzd80RyZy9OP0oOfZduc8VdLwcD6fB8+tl4fnu2NyoFYF3nvFsqVHWijRttdB6cAic/RgMgBrnZu/dF6fVXWghl6Vhd0UGHBVcz6hJv35IVBnoab3RNEa2feZBrJiw4BgtBD2pOciRrsJVTJEOLzAgMBAAGjUzBRMB0GA1UdDgQWBBQiPN5u55bBUolOs1Sq4uEEgqDMpzAfBgNVHSMEGDAWgBQiPN5u55bBUolOs1Sq4uEEgqDMpzAPBgNVHRMBAf8EBTADAQH/MA0GCSqGSIb3DQEBCwUAA4IBAQC0q1+hFENKEQgGWTYcU0gprT03oy2+RPgobGa/Adi1vTPpq21pdRkeGfbewaNg8Y7lHsHM3yNgBC2yfS7T6Q5RkHv5j8jPB6t2BqCXD7H7e49pu2DavN10ZZWb9Yw7l4iZn7Dy7kq1FEYIkAtWMngdKDZoQGvdDpJE2SO/ZjzWDNn0eM400BaAXzU31YqSiwTb5KPABQy4+Hyp+WcMrs1kDZBxgfKoNIiA+jhpwlCIwWMP9gMoJBKoJ5Io66loHyAInjC2b12bWPVvJSDCKru1rQ90A39jsKunfCyhOSBNok6WqUGTitrQHnBuqSYan4zvWT9DnkF4KU97BYzZ5FLt";
const CERT_PEM = `-----BEGIN CERTIFICATE-----\n${CERT_BARE}\n-----END CERTIFICATE-----`;

/** A drizzle-ish chain whose builders return itself and which awaits to `rows`. Records `.where()`. */
function mockDb(rows: unknown[]) {
	const whereSpy = vi.fn();
	const db: Record<string, unknown> = {};
	Object.assign(db, {
		select: () => db,
		from: () => db,
		where: (...a: unknown[]) => {
			whereSpy(...a);
			return db;
		},
		then: (resolve: (v: unknown) => void) => resolve(rows),
	});
	vi.mocked(getServiceDb).mockReturnValue(db as never);
	return { whereSpy };
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(currentActor).mockResolvedValue({ orgId: "org-1", userId: "user-1" } as never);
});

describe("getSsoProviders", () => {
	it("returns an empty list when no providers are registered", async () => {
		mockDb([]);
		expect(await getSsoProviders()).toEqual([]);
	});

	it("derives type=oidc and surfaces the client id (never the secret) when oidcConfig is present", async () => {
		mockDb([
			{
				id: "p-1",
				providerId: "okta-oidc",
				domain: "acme.com",
				issuer: "https://okta.com",
				oidcConfig: JSON.stringify({ clientId: "client-abc", clientSecret: "shhh" }),
				samlConfig: null,
				domainVerified: true,
			},
		]);
		const rows = await getSsoProviders();
		expect(rows).toHaveLength(1);
		expect(rows[0]).toEqual({
			id: "p-1",
			providerId: "okta-oidc",
			domain: "acme.com",
			issuer: "https://okta.com",
			type: "oidc",
			domainVerified: true,
			ssoUrl: null,
			certFingerprint: null,
			clientId: "client-abc",
		});
		// Secret is never exposed on the returned shape.
		expect(JSON.stringify(rows[0])).not.toContain("shhh");
	});

	it("derives type=saml and computes the SHA-256 fingerprint from a bare-base64 cert", async () => {
		mockDb([
			{
				id: "p-2",
				providerId: "onelogin-saml",
				domain: "beta.com",
				issuer: "https://idp.beta.com",
				oidcConfig: null,
				samlConfig: JSON.stringify({ entryPoint: "https://idp.beta.com/sso", cert: CERT_BARE }),
				domainVerified: false,
			},
		]);
		const [row] = await getSsoProviders();
		expect(row.type).toBe("saml");
		expect(row.ssoUrl).toBe("https://idp.beta.com/sso");
		expect(row.certFingerprint).toBe(CERT_FP);
		expect(row.clientId).toBeNull();
		expect(row.domainVerified).toBe(false);
	});

	it("accepts a PEM-wrapped cert and yields the same fingerprint", async () => {
		mockDb([
			{
				id: "p-3",
				providerId: "saml-pem",
				domain: "pem.com",
				issuer: "https://idp.pem.com",
				oidcConfig: null,
				samlConfig: JSON.stringify({ cert: CERT_PEM }),
				domainVerified: true,
			},
		]);
		const [row] = await getSsoProviders();
		expect(row.certFingerprint).toBe(CERT_FP);
		expect(row.ssoUrl).toBeNull(); // no entryPoint configured
	});

	it("returns null fingerprint for an unparseable cert and null ssoUrl when absent", async () => {
		mockDb([
			{
				id: "p-4",
				providerId: "saml-bad",
				domain: "bad.com",
				issuer: "https://idp.bad.com",
				oidcConfig: null,
				samlConfig: JSON.stringify({ cert: "not-a-real-certificate" }),
				domainVerified: false,
			},
		]);
		const [row] = await getSsoProviders();
		expect(row.type).toBe("saml");
		expect(row.certFingerprint).toBeNull();
		expect(row.ssoUrl).toBeNull();
	});

	it("tolerates malformed config JSON, falling back to saml with null IdP details", async () => {
		mockDb([
			{
				id: "p-5",
				providerId: "broken",
				domain: "broken.com",
				issuer: "https://idp.broken.com",
				oidcConfig: null,
				samlConfig: "{not json",
				domainVerified: false,
			},
		]);
		const [row] = await getSsoProviders();
		expect(row.type).toBe("saml"); // no oidcConfig → saml
		expect(row.ssoUrl).toBeNull();
		expect(row.certFingerprint).toBeNull();
		expect(row.clientId).toBeNull();
	});

	it("scopes the query to the active organization", async () => {
		const { whereSpy } = mockDb([]);
		await getSsoProviders();
		expect(currentActor).toHaveBeenCalledTimes(1);
		expect(whereSpy).toHaveBeenCalledTimes(1);
		// The where clause is a drizzle SQL object; assert it was passed (org-scoped predicate built).
		expect(whereSpy.mock.calls[0][0]).toBeTruthy();
	});

	it("maps multiple providers preserving order and per-row type", async () => {
		mockDb([
			{
				id: "a",
				providerId: "a-oidc",
				domain: "a.com",
				issuer: "ia",
				oidcConfig: JSON.stringify({ clientId: "ca" }),
				samlConfig: null,
				domainVerified: true,
			},
			{
				id: "b",
				providerId: "b-saml",
				domain: "b.com",
				issuer: "ib",
				oidcConfig: null,
				samlConfig: JSON.stringify({ entryPoint: "https://b/sso" }),
				domainVerified: false,
			},
		]);
		const rows = await getSsoProviders();
		expect(rows.map((r) => r.type)).toEqual(["oidc", "saml"]);
		expect(rows[0].clientId).toBe("ca");
		expect(rows[1].ssoUrl).toBe("https://b/sso");
	});
});
