// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment node
// (jose's `instanceof Uint8Array` checks run in the Node realm; jsdom's TextEncoder yields a
// cross-realm Uint8Array that jose rejects, breaking both signing and the SUT's jwtVerify.)

// CLI token verification (lib/cli/auth.ts). The only boundary is CLI_JWT_SECRET (read via
// next-runtime-env, aliased to process.env by tests/setup.ts) — jose is kept REAL so we sign
// genuine JWTs and exercise every branch: missing/malformed header, missing secret, valid
// access token, wrong token type, and a signature/claim that fails verification.

import * as jose from "jose";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { verifyCliToken } from "@/lib/cli/auth";

const SECRET = "cli-test-secret-value";
const ISSUER = "urn:example:issuer";
const AUDIENCE = "urn:example:audience";

/** Sign a real HS256 JWT with the SUT's expected issuer/audience. */
async function signToken(
	claims: Record<string, unknown>,
	opts: { secret?: string; issuer?: string; audience?: string } = {},
): Promise<string> {
	const key = new TextEncoder().encode(opts.secret ?? SECRET);
	return new jose.SignJWT(claims)
		.setProtectedHeader({ alg: "HS256" })
		.setIssuer(opts.issuer ?? ISSUER)
		.setAudience(opts.audience ?? AUDIENCE)
		.setExpirationTime("1h")
		.sign(key);
}

/** Build a Request carrying the given Authorization header (omit for none). */
function reqWith(authHeader?: string): Request {
	const headers = new Headers();
	if (authHeader !== undefined) headers.set("Authorization", authHeader);
	return new Request("https://console.test/api/cli", { headers });
}

beforeEach(() => {
	process.env.CLI_JWT_SECRET = SECRET;
});

afterEach(() => {
	delete process.env.CLI_JWT_SECRET;
});

describe("verifyCliToken", () => {
	it("returns a 401 error response and null payload when no Authorization header is present", async () => {
		const { error, payload } = await verifyCliToken(reqWith());
		expect(payload).toBeNull();
		expect(error).toBeInstanceOf(Response);
		expect(error?.status).toBe(401);
		expect(await error?.json()).toEqual({ error: "Unauthorized: Missing token" });
	});

	it("returns a 401 when the header does not use the Bearer scheme", async () => {
		const { error, payload } = await verifyCliToken(reqWith("Basic abc123"));
		expect(payload).toBeNull();
		expect(error?.status).toBe(401);
		expect(await error?.json()).toEqual({ error: "Unauthorized: Missing token" });
	});

	it("returns a 500 config error when CLI_JWT_SECRET is unset, even with a Bearer token", async () => {
		delete process.env.CLI_JWT_SECRET;
		const token = await signToken({ type: "access" });
		const { error, payload } = await verifyCliToken(reqWith(`Bearer ${token}`));
		expect(payload).toBeNull();
		expect(error?.status).toBe(500);
		expect(await error?.json()).toEqual({ error: "Internal server configuration error" });
	});

	it("accepts a valid access token and returns the decoded payload with no error", async () => {
		const token = await signToken({ type: "access", sub: "user-42", org: "acme" });
		const { error, payload } = await verifyCliToken(reqWith(`Bearer ${token}`));
		expect(error).toBeNull();
		expect(payload).not.toBeNull();
		expect(payload?.type).toBe("access");
		expect(payload?.sub).toBe("user-42");
		expect(payload?.org).toBe("acme");
		expect(payload?.iss).toBe(ISSUER);
		expect(payload?.aud).toBe(AUDIENCE);
	});

	it("rejects a structurally valid token whose type is not 'access' (e.g. a refresh token)", async () => {
		const token = await signToken({ type: "refresh", sub: "user-42" });
		const { error, payload } = await verifyCliToken(reqWith(`Bearer ${token}`));
		expect(payload).toBeNull();
		expect(error?.status).toBe(401);
		expect(await error?.json()).toEqual({ error: "Unauthorized: Invalid token type" });
	});

	it("rejects a token signed with the wrong secret as an invalid token", async () => {
		const token = await signToken({ type: "access" }, { secret: "a-different-secret" });
		const { error, payload } = await verifyCliToken(reqWith(`Bearer ${token}`));
		expect(payload).toBeNull();
		expect(error?.status).toBe(401);
		expect(await error?.json()).toEqual({ error: "Unauthorized: Invalid token" });
	});

	it("rejects a token whose issuer/audience claims do not match as an invalid token", async () => {
		const token = await signToken(
			{ type: "access" },
			{ issuer: "urn:evil:issuer", audience: "urn:evil:audience" },
		);
		const { error } = await verifyCliToken(reqWith(`Bearer ${token}`));
		expect(error?.status).toBe(401);
		expect(await error?.json()).toEqual({ error: "Unauthorized: Invalid token" });
	});

	it("rejects a garbage (non-JWT) bearer value as an invalid token", async () => {
		const { error, payload } = await verifyCliToken(reqWith("Bearer not-a-real-jwt"));
		expect(payload).toBeNull();
		expect(error?.status).toBe(401);
		expect(await error?.json()).toEqual({ error: "Unauthorized: Invalid token" });
	});
});
