// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { exportJWK, generateKeyPair, SignJWT, type CryptoKey, type JWK } from "jose";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
	accessConfigFrom,
	resetAccessKeyCache,
	resolveStaffEmail,
	type StaffIdentityInput,
} from "@repo/platform/access-jwt";

const TEAM = "example-team.cloudflareaccess.com";
const ISSUER = `https://${TEAM}`;
const AUD = "aud-tag-under-test";
const KID = "test-key-1";

let signingKey: CryptoKey;
let otherKey: CryptoKey;
let publicJwk: JWK;
let fetchMock: ReturnType<typeof vi.fn>;

/** Signs an Access-shaped token; each field can be overridden to build a failing case. */
async function token(
	overrides: {
		email?: string | null;
		iss?: string;
		aud?: string | string[];
		exp?: number | string;
		nbf?: number | string;
		key?: CryptoKey;
	} = {},
): Promise<string> {
	const claims: Record<string, string> = {};
	if (overrides.email !== null) claims.email = overrides.email ?? "Staff@Example.com";
	const jwt = new SignJWT(claims)
		.setProtectedHeader({ alg: "RS256", kid: KID })
		.setIssuer(overrides.iss ?? ISSUER)
		.setAudience(overrides.aud ?? [AUD])
		.setIssuedAt()
		.setExpirationTime(overrides.exp ?? "5m");
	if (overrides.nbf !== undefined) jwt.setNotBefore(overrides.nbf);
	return jwt.sign(overrides.key ?? signingKey);
}

/** A production input with valid configuration; tests override the field under test. */
function input(over: Partial<StaffIdentityInput>): StaffIdentityInput {
	return {
		token: null,
		teamDomain: TEAM,
		audience: AUD,
		devEmail: "dev@example.com",
		production: true,
		...over,
	};
}

beforeAll(async () => {
	const pair = await generateKeyPair("RS256", { extractable: true });
	signingKey = pair.privateKey;
	publicJwk = { ...(await exportJWK(pair.publicKey)), kid: KID, alg: "RS256", use: "sig" };
	otherKey = (await generateKeyPair("RS256")).privateKey;
});

beforeEach(() => {
	resetAccessKeyCache();
	fetchMock = vi.fn(
		async () =>
			new Response(JSON.stringify({ keys: [publicJwk] }), {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
	);
	vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("resolveStaffEmail — verified Access token", () => {
	it("returns the lowercased email of a valid token, fetching keys from the team certs URL", async () => {
		expect(await resolveStaffEmail(input({ token: await token() }))).toBe("staff@example.com");
		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [requested] = fetchMock.mock.calls[0] ?? [];
		expect(String(requested)).toBe(`${ISSUER}/cdn-cgi/access/certs`);
	});

	it("reuses the cached keys across requests", async () => {
		await resolveStaffEmail(input({ token: await token() }));
		await resolveStaffEmail(input({ token: await token() }));
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("accepts a team domain written with its https scheme and a trailing slash", async () => {
		const t = await token();
		expect(await resolveStaffEmail(input({ token: t, teamDomain: `${ISSUER}/` }))).toBe(
			"staff@example.com",
		);
	});

	it("refuses a token for a different application (wrong aud)", async () => {
		const t = await token({ aud: ["another-application"] });
		expect(await resolveStaffEmail(input({ token: t }))).toBeNull();
	});

	it("refuses a token from a different issuer", async () => {
		const t = await token({ iss: "https://other-team.cloudflareaccess.com" });
		expect(await resolveStaffEmail(input({ token: t }))).toBeNull();
	});

	it("refuses an expired token", async () => {
		const past = Math.floor(Date.now() / 1000) - 3600;
		expect(await resolveStaffEmail(input({ token: await token({ exp: past }) }))).toBeNull();
	});

	it("refuses a token that is not yet valid (nbf)", async () => {
		const future = Math.floor(Date.now() / 1000) + 3600;
		const t = await token({ nbf: future, exp: future + 600 });
		expect(await resolveStaffEmail(input({ token: t }))).toBeNull();
	});

	it("refuses a token signed by a key the team does not publish", async () => {
		expect(await resolveStaffEmail(input({ token: await token({ key: otherKey }) }))).toBeNull();
	});

	it("refuses a token whose payload was altered after signing", async () => {
		const [h, , s] = (await token()).split(".");
		const forged = Buffer.from(
			JSON.stringify({ email: "someone@example.com", iss: ISSUER, aud: [AUD] }),
		).toString("base64url");
		expect(await resolveStaffEmail(input({ token: `${h}.${forged}.${s}` }))).toBeNull();
	});

	it("refuses a verified token that carries no email claim", async () => {
		expect(await resolveStaffEmail(input({ token: await token({ email: null }) }))).toBeNull();
	});

	it("refuses garbage, and never falls back to the dev email once a token is present", async () => {
		expect(
			await resolveStaffEmail(input({ token: "not-a-jwt", production: false })),
		).toBeNull();
	});

	it("returns null when the key endpoint is unreachable", async () => {
		fetchMock.mockRejectedValue(new Error("network down"));
		expect(await resolveStaffEmail(input({ token: await token() }))).toBeNull();
	});
});

describe("resolveStaffEmail — production fails closed", () => {
	it("returns null when no token is sent", async () => {
		expect(await resolveStaffEmail(input({ token: null }))).toBeNull();
		expect(await resolveStaffEmail(input({ token: "" }))).toBeNull();
	});

	it("returns null when the team domain is not configured, even with a valid token", async () => {
		const t = await token();
		expect(await resolveStaffEmail(input({ token: t, teamDomain: undefined }))).toBeNull();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("returns null when the AUD is not configured, even with a valid token", async () => {
		const t = await token();
		expect(await resolveStaffEmail(input({ token: t, audience: "" }))).toBeNull();
	});

	it("never uses the dev email in production", async () => {
		expect(
			await resolveStaffEmail(
				input({ token: null, teamDomain: null, audience: null, devEmail: "dev@example.com" }),
			),
		).toBeNull();
	});
});

describe("resolveStaffEmail — outside production", () => {
	it("uses the dev email when Access is unconfigured", async () => {
		expect(
			await resolveStaffEmail(
				input({ production: false, teamDomain: null, audience: null, devEmail: " Dev@Example.com " }),
			),
		).toBe("dev@example.com");
	});

	it("uses the dev email when Access is configured but no token is sent", async () => {
		expect(await resolveStaffEmail(input({ production: false, token: null }))).toBe(
			"dev@example.com",
		);
	});

	it("still verifies a token when one is sent", async () => {
		expect(await resolveStaffEmail(input({ production: false, token: await token() }))).toBe(
			"staff@example.com",
		);
	});

	it("returns null with neither Access nor a dev email", async () => {
		expect(
			await resolveStaffEmail(
				input({ production: false, teamDomain: null, audience: null, devEmail: "" }),
			),
		).toBeNull();
	});
});

describe("accessConfigFrom", () => {
	it("normalises a bare team host to an https origin", () => {
		expect(accessConfigFrom(TEAM, ` ${AUD} `)).toEqual({ issuer: ISSUER, audience: AUD });
	});

	it.each([
		["http scheme", `http://${TEAM}`],
		["a path", `${ISSUER}/cdn-cgi/access/certs`],
		["a query", `${ISSUER}/?x=1`],
		["credentials", `https://user:pw@${TEAM}`],
		["an unparsable host", "https://exa mple"],
		["an empty value", "  "],
	])("refuses a team domain with %s", (_label, domain) => {
		expect(accessConfigFrom(domain, AUD)).toBeNull();
	});

	it("refuses a missing AUD", () => {
		expect(accessConfigFrom(TEAM, undefined)).toBeNull();
	});
});
