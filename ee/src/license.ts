// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: LicenseRef-Alethia-Commercial

// Instance-wide license verification. A self-managed / air-gapped enterprise unlocks every
// feature by installing a signed license — a compact EdDSA (ed25519) JWT that Alethia Labs mints
// offline and the customer pastes into `ALETHIA_LICENSE_KEY`. Verification is offline and
// stateless: the enterprise deployment bakes the issuer's PUBLIC key into `ALETHIA_LICENSE_PUBLIC_KEY`
// (base64 SPKI PEM, exactly like the OIDC issuer bakes its signing key into ALETHIA_OIDC_SIGNING_KEY),
// so no phone-home is needed and a revoked/expired license simply stops verifying.
//
// This REPLACES the old `ALETHIA_LICENSE_ACTIVE=true` env placeholder (kept only as a non-production
// dev bypass). The gate is FAIL-CLOSED to the community/per-org path: any missing, malformed, expired,
// wrong-audience, or wrong-issuer license leaves the instance UNlicensed — it never crashes boot.

import { createPublicKey } from "node:crypto";
import * as jose from "jose";
import type { Entitlements } from "@/lib/authz/types";

/** EdDSA (ed25519) — small keys, the algorithm the platform already uses for evidence receipts. */
const ALG = "EdDSA";

/** The license issuer — the token `iss`, pinned so a token minted for something else can't be replayed. */
export const LICENSE_ISSUER = "https://alethialabs.io/license";

/** The license audience — every Alethia instance verifies against this fixed `aud`. */
export const LICENSE_AUDIENCE = "alethia-instance";

/** Env holding the signed license JWT (the "license file" a customer installs). */
const LICENSE_KEY_ENV = "ALETHIA_LICENSE_KEY";

/** Env holding the base64(SPKI PEM) ed25519 PUBLIC key the license is verified against (baked at deploy). */
const LICENSE_PUBLIC_KEY_ENV = "ALETHIA_LICENSE_PUBLIC_KEY";

/** Legacy env — honored ONLY outside production, as a local-dev convenience (see resolveInstanceLicense). */
const LEGACY_ACTIVE_ENV = "ALETHIA_LICENSE_ACTIVE";

/** The verified license payload — the claims the gate reads. */
export interface License {
	/** Who the license was issued to (customer / instance identifier); the JWT `sub`. */
	subject: string;
	/** The licensed tier (informational; a valid license unlocks the enterprise feature set). */
	tier: string;
	/** Optional explicit entitlement grant; when absent the instance gets the full enterprise set. */
	entitlements?: Entitlements;
	/** Unix seconds the license expires (from `exp`), or null for a perpetual license. */
	expiresAt: number | null;
}

/** The resolved instance-license state: active + the parsed license, or inactive + the reason why. */
export interface InstanceLicense {
	active: boolean;
	license?: License;
	/** Human-readable reason when inactive/degraded — logged once at boot, never thrown. */
	reason?: string;
}

/**
 * Imports the configured verification public key. Accepts either a base64-encoded SPKI PEM (the baked
 * convention, mirroring ALETHIA_OIDC_SIGNING_KEY) or a raw PEM string, so an operator can paste either.
 */
async function importVerificationKey(raw: string): Promise<jose.KeyLike> {
	const trimmed = raw.trim();
	const pem = trimmed.includes("-----BEGIN")
		? trimmed
		: Buffer.from(trimmed, "base64").toString("utf8");
	// createPublicKey validates the SPKI; jose.importSPKI gives the key jwtVerify wants.
	createPublicKey({ key: pem });
	return jose.importSPKI(pem, ALG, { extractable: false });
}

/** Narrows an unknown JWT claim to a plain entitlement object, or undefined if not present/typed. */
function readEntitlementsClaim(value: unknown): Entitlements | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	return value as Entitlements;
}

/**
 * Verifies a signed license JWT against the issuer public key. Returns the parsed License on success.
 * Throws (via jose) on a bad signature, wrong issuer/audience, or an expired/not-yet-valid token —
 * jose enforces `exp`/`nbf`/`iss`/`aud` and the ed25519 signature for us.
 */
export async function verifyLicense(
	token: string,
	publicKey: jose.KeyLike,
): Promise<License> {
	const { payload } = await jose.jwtVerify(token, publicKey, {
		algorithms: [ALG],
		issuer: LICENSE_ISSUER,
		audience: LICENSE_AUDIENCE,
	});
	const subject = typeof payload.sub === "string" ? payload.sub : "unknown";
	const tier = typeof payload.tier === "string" ? payload.tier : "enterprise";
	return {
		subject,
		tier,
		entitlements: readEntitlementsClaim(payload.entitlements),
		expiresAt: typeof payload.exp === "number" ? payload.exp : null,
	};
}

let cached: Promise<InstanceLicense> | null = null;

/**
 * Resolves — and memoizes — whether this instance holds a valid license. A license is static for the
 * process lifetime, so this runs once. Order:
 *  1. A dev bypass: `ALETHIA_LICENSE_ACTIVE=true` outside production (local dev only; logged loudly).
 *  2. A signed `ALETHIA_LICENSE_KEY` verified against `ALETHIA_LICENSE_PUBLIC_KEY`.
 * Any failure is swallowed into `{ active: false, reason }` — the caller falls back to the per-org
 * (billing) path, so a broken license degrades to community, never to a boot crash.
 */
export async function resolveInstanceLicense(): Promise<InstanceLicense> {
	if (!cached) cached = resolve();
	return cached;
}

/** The uncached resolution — split out so resolveInstanceLicense stays a thin memoizer. */
async function resolve(): Promise<InstanceLicense> {
	// Dev-only bypass: the old flag still unlocks a local instance, but NEVER in production, where a
	// real signed license is required. This is the sole surviving use of the legacy env.
	if (process.env[LEGACY_ACTIVE_ENV] === "true") {
		if (process.env.NODE_ENV === "production") {
			return {
				active: false,
				reason: `${LEGACY_ACTIVE_ENV} is ignored in production — install a signed ${LICENSE_KEY_ENV}.`,
			};
		}
		return {
			active: true,
			reason: `${LEGACY_ACTIVE_ENV} dev bypass — NOT valid in production.`,
			license: { subject: "dev-bypass", tier: "enterprise", expiresAt: null },
		};
	}

	const token = process.env[LICENSE_KEY_ENV];
	if (!token) {
		return { active: false, reason: `no ${LICENSE_KEY_ENV} set` };
	}
	const publicKeyRaw = process.env[LICENSE_PUBLIC_KEY_ENV];
	if (!publicKeyRaw) {
		return {
			active: false,
			reason: `${LICENSE_KEY_ENV} is set but ${LICENSE_PUBLIC_KEY_ENV} is not — cannot verify it`,
		};
	}
	try {
		const publicKey = await importVerificationKey(publicKeyRaw);
		const license = await verifyLicense(token, publicKey);
		return { active: true, license };
	} catch (err) {
		return {
			active: false,
			reason: `${LICENSE_KEY_ENV} failed verification: ${
				err instanceof Error ? err.message : String(err)
			}`,
		};
	}
}

/** Resets the memoized license — for tests that swap the env between cases. */
export function __resetLicenseCache(): void {
	cached = null;
}
