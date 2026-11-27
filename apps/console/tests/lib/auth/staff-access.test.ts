// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// The staff identity the console's platform privacy routes act as (lib/auth/staff-access.ts). The
// verifier itself is @repo/platform/access-jwt, exercised case by case in
// tests/lib/auth/access-jwt.test.ts; these tests pin what the console adds: WHICH header
// it reads, WHICH settings it verifies against, and that the dev stand-in exists only outside
// production. Real tokens from a locally generated keypair; the team's key endpoint is stubbed.

import { exportJWK, generateKeyPair, SignJWT, type CryptoKey, type JWK } from "jose";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
	ACCESS_JWT_HEADER,
	resetAccessKeyCache,
	STAFF_ACCESS_TOKEN_HEADER,
} from "@repo/platform/access-jwt";
import { verifiedStaffEmail } from "@/lib/auth/staff-access";

const TEAM = "example-team.cloudflareaccess.com";
const ISSUER = `https://${TEAM}`;
const AUD = "staff-app-aud-under-test";
const KID = "test-key-1";

let signingKey: CryptoKey;
let publicJwk: JWK;

/** Signs an Access-shaped token for the staff app's application, or for another audience. */
async function token(aud: string = AUD): Promise<string> {
	return new SignJWT({ email: "Staff@AlethiaLabs.io" })
		.setProtectedHeader({ alg: "RS256", kid: KID })
		.setIssuer(ISSUER)
		.setAudience([aud])
		.setIssuedAt()
		.setExpirationTime("5m")
		.sign(signingKey);
}

/** A platform call carrying the given headers. */
function call(headers: Record<string, string> = {}): Request {
	return new Request("http://localhost/api/internal/platform/privacy/cases", { headers });
}

/** Sets the console environment the verifier reads; `production` picks NODE_ENV. */
function environment(over: { production: boolean; configured?: boolean }): void {
	vi.stubEnv("NODE_ENV", over.production ? "production" : "development");
	vi.stubEnv("CF_ACCESS_TEAM_DOMAIN", over.configured === false ? "" : TEAM);
	vi.stubEnv("CF_ACCESS_AUD", over.configured === false ? "" : AUD);
	vi.stubEnv("SUPPORT_ADMIN_DEV_EMAIL", "dev@alethialabs.io");
}

beforeAll(async () => {
	const pair = await generateKeyPair("RS256", { extractable: true });
	signingKey = pair.privateKey;
	publicJwk = { ...(await exportJWK(pair.publicKey)), kid: KID, alg: "RS256", use: "sig" };
});

beforeEach(() => {
	resetAccessKeyCache();
	vi.stubGlobal(
		"fetch",
		vi.fn(
			async () =>
				new Response(JSON.stringify({ keys: [publicJwk] }), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
		),
	);
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
});

describe("verifiedStaffEmail — production", () => {
	it("answers the lowercased email of a forwarded token that verifies", async () => {
		environment({ production: true });
		const req = call({ [STAFF_ACCESS_TOKEN_HEADER]: await token() });
		expect(await verifiedStaffEmail(req)).toBe("staff@alethialabs.io");
	});

	it("reads only the forwarded header, not Cloudflare's own", async () => {
		environment({ production: true });
		expect(await verifiedStaffEmail(call({ [ACCESS_JWT_HEADER]: await token() }))).toBeNull();
	});

	it("refuses a token minted for a different Access application", async () => {
		environment({ production: true });
		const req = call({ [STAFF_ACCESS_TOKEN_HEADER]: await token("another-application") });
		expect(await verifiedStaffEmail(req)).toBeNull();
	});

	it("refuses a missing token, and never uses the dev stand-in", async () => {
		environment({ production: true });
		expect(await verifiedStaffEmail(call())).toBeNull();
	});

	it("refuses everything when Access is not configured", async () => {
		environment({ production: true, configured: false });
		expect(await verifiedStaffEmail(call({ [STAFF_ACCESS_TOKEN_HEADER]: await token() }))).toBeNull();
		expect(await verifiedStaffEmail(call())).toBeNull();
	});
});

describe("verifiedStaffEmail — outside production", () => {
	it("uses the dev stand-in when no token is sent", async () => {
		environment({ production: false });
		expect(await verifiedStaffEmail(call())).toBe("dev@alethialabs.io");
	});

	it("still verifies a token that is sent, and does not fall back when it fails", async () => {
		environment({ production: false });
		const good = call({ [STAFF_ACCESS_TOKEN_HEADER]: await token() });
		expect(await verifiedStaffEmail(good)).toBe("staff@alethialabs.io");
		const bad = call({ [STAFF_ACCESS_TOKEN_HEADER]: "not-a-token" });
		expect(await verifiedStaffEmail(bad)).toBeNull();
	});
});
