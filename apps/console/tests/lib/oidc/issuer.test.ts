// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// The workload-identity issuer is the trust root for keyless Azure + Alibaba federation, so these tests
// pin the contract a cloud relies on: a minted assertion verifies against the PUBLISHED JWKS with the
// right iss/sub/aud, the JWKS never leaks private key material, expiry is enforced, and audience scoping
// prevents cross-cloud replay.

import { generateKeyPairSync } from "node:crypto";
import * as jose from "jose";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	__resetIssuerCache,
	discoveryDocument,
	getPublicJwks,
	issuerUrl,
	mintWorkloadToken,
	oidcIssuerConfigured,
	WORKLOAD_SUBJECT,
} from "@/lib/oidc/issuer";

const APP_URL = "https://alethialabs.io";
const saved: Record<string, string | undefined> = {};

/** Generates an RSA-2048 keypair and installs its base64(PKCS8 PEM) as the signing key env. */
function installKey() {
	const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
	const pem = privateKey.export({ type: "pkcs8", format: "pem" }) as string;
	process.env.ALETHIA_OIDC_SIGNING_KEY = Buffer.from(pem, "utf8").toString("base64");
	process.env.NEXT_PUBLIC_APP_URL = APP_URL;
	__resetIssuerCache();
}

beforeEach(() => {
	for (const k of ["ALETHIA_OIDC_SIGNING_KEY", "NEXT_PUBLIC_APP_URL", "BETTER_AUTH_URL"]) {
		saved[k] = process.env[k];
	}
});
afterEach(() => {
	for (const k of ["ALETHIA_OIDC_SIGNING_KEY", "NEXT_PUBLIC_APP_URL", "BETTER_AUTH_URL"]) {
		if (saved[k] === undefined) delete process.env[k];
		else process.env[k] = saved[k];
	}
	__resetIssuerCache();
});

describe("OIDC workload-identity issuer", () => {
	it("is unconfigured without the signing key", () => {
		delete process.env.ALETHIA_OIDC_SIGNING_KEY;
		expect(oidcIssuerConfigured()).toBe(false);
	});

	it("mints an assertion that verifies against the published JWKS", async () => {
		installKey();
		expect(oidcIssuerConfigured()).toBe(true);

		const token = await mintWorkloadToken({ audience: "api://AzureADTokenExchange" });
		const jwks = jose.createLocalJWKSet(
			(await getPublicJwks()) as unknown as jose.JSONWebKeySet,
		);
		const { payload, protectedHeader } = await jose.jwtVerify(token, jwks, {
			issuer: `${APP_URL}/api/oidc`,
			audience: "api://AzureADTokenExchange",
		});
		expect(payload.sub).toBe(WORKLOAD_SUBJECT);
		expect(payload.iss).toBe(`${APP_URL}/api/oidc`);
		expect(protectedHeader.alg).toBe("RS256");
		expect(protectedHeader.kid).toBeTruthy();
	});

	it("scopes the audience so a token for one cloud can't be replayed at another", async () => {
		installKey();
		const token = await mintWorkloadToken({ audience: "sts.aliyuncs.com" });
		const jwks = jose.createLocalJWKSet(
			(await getPublicJwks()) as unknown as jose.JSONWebKeySet,
		);
		await expect(
			jose.jwtVerify(token, jwks, { audience: "api://AzureADTokenExchange" }),
		).rejects.toThrow();
	});

	it("the JWKS exposes only public key material (no private fields)", async () => {
		installKey();
		const { keys } = await getPublicJwks();
		expect(keys).toHaveLength(1);
		const jwk = keys[0];
		expect(jwk.kty).toBe("RSA");
		expect(jwk.n).toBeTruthy();
		expect(jwk.e).toBeTruthy();
		expect(jwk.use).toBe("sig");
		expect(jwk.kid).toBeTruthy();
		for (const priv of ["d", "p", "q", "dp", "dq", "qi"]) {
			expect(jwk[priv as keyof typeof jwk]).toBeUndefined();
		}
	});

	it("enforces expiry", async () => {
		installKey();
		const token = await mintWorkloadToken({ audience: "aud", ttlSeconds: 60 });
		const jwks = jose.createLocalJWKSet(
			(await getPublicJwks()) as unknown as jose.JSONWebKeySet,
		);
		// 61s in the future → past the 60s TTL.
		await expect(
			jose.jwtVerify(token, jwks, {
				audience: "aud",
				currentDate: new Date(Date.now() + 61_000),
			}),
		).rejects.toThrow(/exp/i);
	});

	it("discovery advertises the issuer + jwks_uri", async () => {
		installKey();
		const doc = await discoveryDocument();
		expect(doc.issuer).toBe(`${APP_URL}/api/oidc`);
		expect(doc.jwks_uri).toBe(`${APP_URL}/api/oidc/jwks`);
		expect(doc.id_token_signing_alg_values_supported).toContain("RS256");
		expect(issuerUrl()).toBe(`${APP_URL}/api/oidc`);
	});
});
