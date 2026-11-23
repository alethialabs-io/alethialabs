// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: LicenseRef-Alethia-Commercial

// Instance-wide licence verification and licence states. A self-managed enterprise instance turns
// its enterprise features on by installing a signed licence: a compact EdDSA (ed25519) JWT that
// Alethia Labs issues offline (ee/scripts/issue-license.ts) and the operator sets as
// `ALETHIA_LICENSE_KEY`. Verification is offline and stateless; nothing is sent to Alethia Labs.
//
// Custody: the key a licence is verified against is compiled into the build
// (./license-keys.ts). A release image trusts only those keys. Outside a release image, and only
// outside production, `ALETHIA_LICENSE_PUBLIC_KEY` adds one more key so local development and the
// test suites can verify licences they sign with a throwaway key.
//
// Verification and dates are separate questions. `resolveInstanceLicense` answers "did the
// installed licence verify" once per process; `licenseState` answers "what state is it in at this
// instant" on every call, so a licence that ends while the process runs moves to `grace` and then
// to `expired` without a restart.
//
// Fail-safe: a licence that is missing, malformed, signed by another key, for another issuer or
// audience, or carrying a claim of the wrong shape does not verify, and an unverified licence
// grants nothing. No path here throws into the caller; boot never fails because of a licence.

import { createPublicKey } from "node:crypto";
import type { LicenseState } from "@alethia/enterprise-api";
import * as jose from "jose";
import type { Entitlements } from "@/lib/authz/types";
import { BUILT_IN_LICENSE_KEYS, isImageBuild } from "./license-keys";

/** EdDSA (ed25519): small keys, the algorithm the platform already uses for evidence receipts. */
const ALG = "EdDSA";

/** The licence issuer, the token `iss`, pinned so a token minted for something else is refused. */
export const LICENSE_ISSUER = "https://alethialabs.io/license";

/** The licence audience: every Alethia instance verifies against this fixed `aud`. */
export const LICENSE_AUDIENCE = "alethia-instance";

/** Grace days a licence gets after its end when it does not state `grace_days`. */
export const DEFAULT_GRACE_DAYS = 30;

/** The largest `grace_days` a licence may carry. A larger value is a malformed licence. */
export const MAX_GRACE_DAYS = 365;

/** A licence with this many days or fewer left is `expiring`. */
export const EXPIRING_WITHIN_DAYS = 30;

/** Seconds in a day. */
const DAY_SECONDS = 86_400;

/** Env holding the signed licence JWT (the licence an operator installs). */
const LICENSE_KEY_ENV = "ALETHIA_LICENSE_KEY";

/**
 * Env holding an extra base64(SPKI PEM) verification key. Honoured only outside a release image
 * and outside production: a development and test aid, never an operator setting.
 */
const LICENSE_PUBLIC_KEY_ENV = "ALETHIA_LICENSE_PUBLIC_KEY";

/** Legacy env, honoured only outside a release image and outside production (local development). */
const LEGACY_ACTIVE_ENV = "ALETHIA_LICENSE_ACTIVE";

/** The verified licence payload: the claims the gate reads. */
export interface License {
	/** Who the licence was issued to; the JWT `sub`. */
	subject: string;
	/** The licensed tier (informational; a granting licence unlocks the enterprise feature set). */
	tier: string;
	/** Optional explicit entitlement grant; when absent the instance gets the full enterprise set. */
	entitlements?: Entitlements;
	/** Unix seconds the licence ends (from `exp`), or null for a licence with no end. */
	expiresAt: number | null;
	/** Days after `expiresAt` during which the licence still grants (from `grace_days`). */
	graceDays: number;
}

/** The resolved instance licence: whether the installed licence verified, and its claims if so. */
export interface InstanceLicense {
	/**
	 * Whether an installed licence verified: its signature against a trusted key, its issuer, its
	 * audience and the shape of its claims. Says nothing about its dates; see {@link licenseState}.
	 */
	verified: boolean;
	/** The licence's claims, present only when {@link verified} is true. */
	license?: License;
	/** Why the licence did not verify, or a note on how it did. Logged once at boot, never thrown. */
	reason?: string;
}

// jose 6 removed the `KeyLike` alias (keys are Web Crypto `CryptoKey`s now). Deriving the type
// from the importer rather than naming a jose export means this cannot break the next time the
// library renames its key type, and it is always exactly what compactVerify accepts here.
type VerificationKey = Awaited<ReturnType<typeof jose.importSPKI>>;

/**
 * Imports a verification public key. Accepts a raw SPKI PEM or a base64-encoded one, so the
 * built-in list can hold the PEM as-is and the development env can hold it on one line. Refuses a
 * key that is not ed25519.
 */
export async function importVerificationKey(raw: string): Promise<VerificationKey> {
	const trimmed = raw.trim();
	const pem = trimmed.includes("-----BEGIN")
		? trimmed
		: Buffer.from(trimmed, "base64").toString("utf8");
	const parsed = createPublicKey({ key: pem });
	if (parsed.asymmetricKeyType !== "ed25519") {
		throw new Error("licence verification key is not an ed25519 key");
	}
	return jose.importSPKI(pem, ALG, { extractable: false });
}

/** Narrows an unknown value to a plain (non-array) object. */
function isPlainObject(value: unknown): value is { [key: string]: unknown } {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Narrows an entitlements claim. Any plain object is accepted as one: the readers of a licence's
 * entitlements test each switch for the boolean `true`, so a member of another type grants nothing.
 */
function isEntitlementsClaim(value: unknown): value is Entitlements {
	return isPlainObject(value);
}

/** Whether a token `aud` claim names the instance audience. */
function audienceMatches(aud: unknown): boolean {
	if (typeof aud === "string") return aud === LICENSE_AUDIENCE;
	return Array.isArray(aud) && aud.includes(LICENSE_AUDIENCE);
}

/**
 * Reads the claims of a token whose signature has verified. Throws on any claim that is missing
 * or not the stated shape, so a malformed licence is refused rather than read with defaults.
 */
export function parseLicenseClaims(payload: unknown): License {
	if (!isPlainObject(payload)) throw new Error("licence payload is not a JSON object");
	if (payload.iss !== LICENSE_ISSUER) throw new Error("licence issuer is not Alethia Labs");
	if (!audienceMatches(payload.aud)) throw new Error("licence audience is not an Alethia instance");

	const { sub, tier, exp, nbf, entitlements } = payload;
	const graceClaim = payload.grace_days;
	if (typeof sub !== "string" || sub.trim() === "") {
		throw new Error("licence subject (sub) is missing");
	}
	if (tier !== undefined && typeof tier !== "string") {
		throw new Error("licence tier is not a string");
	}
	if (exp !== undefined && (typeof exp !== "number" || !Number.isFinite(exp))) {
		throw new Error("licence end (exp) is not a number");
	}
	// The issuer never sets `nbf`; a licence carrying one is not one it issued.
	if (nbf !== undefined) throw new Error("licence carries an unsupported nbf claim");
	let graceDays = DEFAULT_GRACE_DAYS;
	if (graceClaim !== undefined) {
		if (
			typeof graceClaim !== "number" ||
			!Number.isInteger(graceClaim) ||
			graceClaim < 0 ||
			graceClaim > MAX_GRACE_DAYS
		) {
			throw new Error(`licence grace_days is not a whole number from 0 to ${MAX_GRACE_DAYS}`);
		}
		graceDays = graceClaim;
	}
	if (entitlements !== undefined && !isEntitlementsClaim(entitlements)) {
		throw new Error("licence entitlements claim is not an object");
	}
	return {
		subject: sub,
		tier: tier ?? "enterprise",
		entitlements,
		expiresAt: exp ?? null,
		graceDays,
	};
}

/**
 * Verifies a signed licence JWT against one or more trusted public keys and returns its claims.
 * Throws when the signature verifies against none of them, when the algorithm is not EdDSA, and
 * when any claim is missing or malformed (see {@link parseLicenseClaims}). Dates are NOT checked
 * here: a correctly signed licence that has ended still verifies, and {@link licenseState} decides
 * whether it is in `grace` or `expired`.
 */
export async function verifyLicense(
	token: string,
	keys: VerificationKey | VerificationKey[],
): Promise<License> {
	const candidates = Array.isArray(keys) ? keys : [keys];
	if (candidates.length === 0) throw new Error("no licence verification key is available");
	let payload: Uint8Array | null = null;
	for (const key of candidates) {
		try {
			payload = (await jose.compactVerify(token, key, { algorithms: [ALG] })).payload;
			break;
		} catch {
			// Try the next trusted key; the refusal below names the outcome.
		}
	}
	if (payload === null) {
		throw new Error("licence signature does not verify against any trusted key");
	}
	let claims: unknown;
	try {
		claims = JSON.parse(new TextDecoder().decode(payload));
	} catch {
		throw new Error("licence payload is not JSON");
	}
	return parseLicenseClaims(claims);
}

/** The instant (Unix seconds) a licence's grace period ends, or null for a licence with no end. */
export function graceEndsAt(license: License): number | null {
	if (license.expiresAt === null) return null;
	return license.expiresAt + license.graceDays * DAY_SECONDS;
}

/**
 * The state of the instance licence at `now`.
 *
 * - `none`: no licence is installed.
 * - `invalid`: a licence is installed and did not verify, or its dates cannot be compared.
 * - `active`: verified, and either no end or more than {@link EXPIRING_WITHIN_DAYS} days left.
 * - `expiring`: verified, {@link EXPIRING_WITHIN_DAYS} days or fewer left.
 * - `grace`: the end has passed and its grace period has not.
 * - `expired`: the end and its grace period have both passed.
 *
 * @param instance the resolved instance licence
 * @param now the instant the licence dates are compared against
 * @param installed whether the operator installed a licence at all
 */
export function licenseState(instance: InstanceLicense, now: Date, installed: boolean): LicenseState {
	if (!instance.verified || instance.license === undefined) {
		return installed ? "invalid" : "none";
	}
	const { expiresAt } = instance.license;
	if (expiresAt === null) return "active";
	const graceEnd = graceEndsAt(instance.license);
	const nowMs = now.getTime();
	if (
		!Number.isFinite(expiresAt) ||
		graceEnd === null ||
		!Number.isFinite(graceEnd) ||
		!Number.isFinite(nowMs)
	) {
		return "invalid";
	}
	if (nowMs < expiresAt * 1000) {
		const expiringFrom = (expiresAt - EXPIRING_WITHIN_DAYS * DAY_SECONDS) * 1000;
		return nowMs >= expiringFrom ? "expiring" : "active";
	}
	return nowMs < graceEnd * 1000 ? "grace" : "expired";
}

/**
 * Whether a licence in this state grants its entitlements: `active`, `expiring` and `grace` do,
 * every other state does not. Kept in step with `licenseStateGrants` in `@alethia/enterprise-api`
 * (a test asserts the two agree on all six states); this package imports that one as types only.
 */
export function licenseGrants(state: LicenseState): boolean {
	switch (state) {
		case "active":
		case "expiring":
		case "grace":
			return true;
		case "none":
		case "expired":
		case "invalid":
			return false;
	}
}

/** Whether runtime overrides (the development env key and the legacy switch) may be honoured. */
function overridesAllowed(): boolean {
	return !isImageBuild() && process.env.NODE_ENV !== "production";
}

/** The keys an installed licence is verified against, and a note when an override was ignored. */
async function trustedKeys(): Promise<{ keys: VerificationKey[]; note?: string }> {
	const keys: VerificationKey[] = [];
	for (const key of BUILT_IN_LICENSE_KEYS) keys.push(await importVerificationKey(key.spkiPem));
	const envKey = process.env[LICENSE_PUBLIC_KEY_ENV];
	if (envKey === undefined || envKey.trim() === "") return { keys };
	if (!overridesAllowed()) {
		return {
			keys,
			note: `${LICENSE_PUBLIC_KEY_ENV} is ignored; this build verifies against its built-in keys only`,
		};
	}
	keys.push(await importVerificationKey(envKey));
	return { keys };
}

let cached: Promise<InstanceLicense> | null = null;

/**
 * Resolves, and memoizes, whether the installed licence verified. Verification does not depend on
 * the clock, so it runs once per process; {@link licenseState} applies the dates on every call.
 * Order:
 *  1. A development switch: `ALETHIA_LICENSE_ACTIVE=true`, honoured only outside a release image
 *     and outside production.
 *  2. A signed `ALETHIA_LICENSE_KEY`, verified against the trusted keys.
 * Any failure is returned as `{ verified: false, reason }`; the caller falls back to the
 * per-organisation path, so a broken licence degrades to community, never to a boot crash.
 */
export async function resolveInstanceLicense(): Promise<InstanceLicense> {
	if (!cached) cached = resolve();
	return cached;
}

/** The uncached resolution, split out so resolveInstanceLicense stays a thin memoizer. */
async function resolve(): Promise<InstanceLicense> {
	if (process.env[LEGACY_ACTIVE_ENV] === "true") {
		if (!overridesAllowed()) {
			return {
				verified: false,
				reason: `${LEGACY_ACTIVE_ENV} is ignored in this build; install a signed ${LICENSE_KEY_ENV}.`,
			};
		}
		return {
			verified: true,
			reason: `${LEGACY_ACTIVE_ENV} development switch; not honoured in production.`,
			license: { subject: "dev-bypass", tier: "enterprise", expiresAt: null, graceDays: 0 },
		};
	}

	const token = process.env[LICENSE_KEY_ENV];
	if (!token || token.trim() === "") {
		return { verified: false, reason: `no ${LICENSE_KEY_ENV} set` };
	}
	try {
		const { keys, note } = await trustedKeys();
		if (keys.length === 0) {
			return {
				verified: false,
				reason: `${LICENSE_KEY_ENV} is set but this build carries no licence verification key${
					note ? ` (${note})` : ""
				}`,
			};
		}
		const license = await verifyLicense(token.trim(), keys);
		return note ? { verified: true, license, reason: note } : { verified: true, license };
	} catch (err) {
		return {
			verified: false,
			reason: `${LICENSE_KEY_ENV} failed verification: ${
				err instanceof Error ? err.message : String(err)
			}`,
		};
	}
}

/** Resets the memoized licence, for tests that swap the env between cases. */
export function __resetLicenseCache(): void {
	cached = null;
}
