// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The Alethia workload-identity OIDC issuer. The control plane is its own OIDC identity provider so the
// managed cloud connectors can federate KEYLESSLY: it mints a short-lived, per-cloud-scoped JWT signed
// with a private key held only in the vault, and publishes the matching public JWKS + discovery document
// so a customer's cloud (Azure federated identity, Alibaba RAM OIDC provider) can verify it.
//
// This is deliberately minimal and single-purpose — NOT a general OAuth server (that's the separate MCP
// provider under /api/auth). It has no interactive/user surface: the only public routes are the discovery
// document and the JWKS, both static signed material. Server-only.

import { createPublicKey } from "node:crypto";
import * as jose from "jose";

/** RS256 — the widest-compatible alg for cloud workload-identity federation (Azure/Alibaba/GCP). */
const ALG = "RS256";

/** Issuer path under the app origin. The full issuer is `${APP_URL}/api/oidc`. */
const ISSUER_PATH = "/api/oidc";

/**
 * The single stable, non-secret workload subject. It is the `sub` of every minted token and MUST match
 * the Azure federated-credential subject + the Alibaba RAM-role OIDC condition. Never per-customer.
 */
export const WORKLOAD_SUBJECT = "alethia-connector";

/** Max token lifetime — assertions are used immediately for a token exchange, so keep them short. */
const MAX_TTL_SECONDS = 600;

/** Env var holding the base64-encoded PKCS8 PEM private key (single line; auto-generated in the vault). */
const SIGNING_KEY_ENV = "ALETHIA_OIDC_SIGNING_KEY";

interface LoadedKey {
	privateKey: CryptoKey;
	/** The public JWK published in the JWKS (kid/alg/use set; no private fields). */
	publicJwk: jose.JWK;
	kid: string;
}

let cached: LoadedKey | null = null;

/** Whether the issuer is configured on this instance (drives connector availability for Azure/Alibaba). */
export function oidcIssuerConfigured(): boolean {
	return !!process.env[SIGNING_KEY_ENV];
}

/** The full issuer URL (`${APP_URL}/api/oidc`) — the value clouds trust + the token `iss`. */
export function issuerUrl(): string {
	const base = (
		process.env.NEXT_PUBLIC_APP_URL ||
		process.env.BETTER_AUTH_URL ||
		""
	).replace(/\/+$/, "");
	return `${base}${ISSUER_PATH}`;
}

/** Decodes + imports the signing key and derives the public JWK (memoized). Throws if unconfigured. */
async function load(): Promise<LoadedKey> {
	if (cached) return cached;
	const b64 = process.env[SIGNING_KEY_ENV];
	if (!b64) {
		throw new Error(`OIDC issuer not configured (${SIGNING_KEY_ENV}).`);
	}
	let pem: string;
	try {
		pem = Buffer.from(b64, "base64").toString("utf8");
	} catch {
		throw new Error(`${SIGNING_KEY_ENV} is not valid base64.`);
	}
	const privateKey = await jose.importPKCS8(pem, ALG, { extractable: false });
	// Derive the public JWK from the private PEM (never expose private fields in the JWKS).
	const publicJwk = await jose.exportJWK(createPublicKey({ key: pem }));
	const kid = await jose.calculateJwkThumbprint(publicJwk);
	publicJwk.kid = kid;
	publicJwk.alg = ALG;
	publicJwk.use = "sig";
	cached = { privateKey, publicJwk, kid };
	return cached;
}

/** Resets the memoized key — for tests that swap the env between cases. */
export function __resetIssuerCache(): void {
	cached = null;
}

/** The public JWKS (`{ keys: [...] }`) served at `${issuer}/jwks` for clouds to verify assertions. */
export async function getPublicJwks(): Promise<{ keys: jose.JWK[] }> {
	const { publicJwk } = await load();
	return { keys: [publicJwk] };
}

/** The OIDC discovery document served at `${issuer}/.well-known/openid-configuration`. */
export async function discoveryDocument(): Promise<Record<string, unknown>> {
	const iss = issuerUrl();
	return {
		issuer: iss,
		jwks_uri: `${iss}/jwks`,
		// A workload-identity issuer: no interactive endpoints. These fields satisfy the validators that
		// fetch discovery (Azure/Alibaba) — only issuer + jwks_uri are load-bearing for federation.
		response_types_supported: ["id_token"],
		subject_types_supported: ["public"],
		id_token_signing_alg_values_supported: [ALG],
		scopes_supported: ["openid"],
		claims_supported: ["iss", "sub", "aud", "iat", "exp"],
	};
}

/**
 * Mints a short-lived assertion for one cloud's token exchange. `audience` is the cloud's expected
 * audience (e.g. `api://AzureADTokenExchange`, or the Alibaba OIDC client id) — scoping the token so it
 * can't be replayed at a different cloud. `subject` defaults to the fixed workload subject.
 */
export async function mintWorkloadToken(opts: {
	audience: string;
	subject?: string;
	ttlSeconds?: number;
}): Promise<string> {
	const { privateKey, kid } = await load();
	const now = Math.floor(Date.now() / 1000);
	const ttl = Math.min(Math.max(opts.ttlSeconds ?? MAX_TTL_SECONDS, 60), MAX_TTL_SECONDS);
	return await new jose.SignJWT({})
		.setProtectedHeader({ alg: ALG, kid, typ: "JWT" })
		.setIssuer(issuerUrl())
		.setSubject(opts.subject ?? WORKLOAD_SUBJECT)
		.setAudience(opts.audience)
		.setIssuedAt(now)
		.setExpirationTime(now + ttl)
		.sign(privateKey);
}
