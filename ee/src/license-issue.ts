// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: LicenseRef-Alethia-Commercial

// The license ISSUER — the counterpart to license.ts (the verifier). Alethia Labs mints a customer's
// license offline with the private half of the issuer keypair; the customer's instance verifies it with
// the public half baked into ALETHIA_LICENSE_PUBLIC_KEY. The signing private key lives ONLY in the
// Alethia ops vault (never in this repo, never on a customer instance) — same split as the OIDC issuer.
//
// Kept in the same package as the verifier so the two share one contract (issuer/audience/alg) and the
// unit tests can round-trip issue → verify without an external key ceremony.

import { generateKeyPairSync } from "node:crypto";
import * as jose from "jose";
import type { Entitlements } from "@/lib/authz/types";
import { LICENSE_AUDIENCE, LICENSE_ISSUER } from "./license";

/** Must match license.ts — the alg the verifier accepts. */
const ALG = "EdDSA";

/** Inputs for minting a customer license. */
export interface IssueLicenseInput {
	/** base64(PKCS8 PEM) ed25519 private key — the Alethia license signing key (vault-held). */
	privateKeyB64: string;
	/** Who the license is for (customer / instance id) — becomes the JWT `sub`. */
	subject: string;
	/** The licensed tier label (default "enterprise"). */
	tier?: string;
	/** Optional explicit entitlement grant; omit to grant the full enterprise set at verify time. */
	entitlements?: Entitlements;
	/** Days until expiry; omit for a PERPETUAL license (no `exp`). */
	expiresInDays?: number;
	/** Unix seconds "now" — injectable so issuance is deterministic in tests. Defaults to wall clock. */
	nowSeconds?: number;
}

/** Imports a base64(PKCS8 PEM) ed25519 private key for signing. */
async function importSigningKey(b64: string): Promise<CryptoKey> {
	let pem: string;
	try {
		pem = Buffer.from(b64, "base64").toString("utf8");
	} catch {
		throw new Error("license signing key is not valid base64");
	}
	return jose.importPKCS8(pem, ALG, { extractable: false });
}

/**
 * Mints a signed license JWT for a customer. The token carries the pinned issuer + audience so it only
 * verifies on an Alethia instance, `sub`/`tier` describe the grant, and `exp` (when set) bounds its life.
 */
export async function issueLicense(input: IssueLicenseInput): Promise<string> {
	const privateKey = await importSigningKey(input.privateKeyB64);
	const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
	const claims: Record<string, unknown> = { tier: input.tier ?? "enterprise" };
	if (input.entitlements) claims.entitlements = input.entitlements;

	const builder = new jose.SignJWT(claims)
		.setProtectedHeader({ alg: ALG, typ: "JWT" })
		.setIssuer(LICENSE_ISSUER)
		.setAudience(LICENSE_AUDIENCE)
		.setSubject(input.subject)
		.setIssuedAt(now);
	if (input.expiresInDays !== undefined) {
		builder.setExpirationTime(now + input.expiresInDays * 86_400);
	}
	return builder.sign(privateKey);
}

/** A freshly generated license keypair, both halves base64(PEM)-encoded. */
export interface LicenseKeypair {
	/** base64(PKCS8 PEM) — the SIGNING key. Vault-only; feeds issueLicense. */
	privateKeyB64: string;
	/** base64(SPKI PEM) — the VERIFY key. Baked into ALETHIA_LICENSE_PUBLIC_KEY on the instance. */
	publicKeyB64: string;
}

/**
 * Generates a new ed25519 license keypair. Used once to bootstrap the Alethia signing key (store the
 * private half in the vault, publish the public half to instances) and by the tests to sign fixtures.
 */
export function generateLicenseKeypair(): LicenseKeypair {
	const { privateKey, publicKey } = generateKeyPairSync("ed25519");
	const privPem = privateKey.export({ type: "pkcs8", format: "pem" }) as string;
	const pubPem = publicKey.export({ type: "spki", format: "pem" }) as string;
	return {
		privateKeyB64: Buffer.from(privPem, "utf8").toString("base64"),
		publicKeyB64: Buffer.from(pubPem, "utf8").toString("base64"),
	};
}
