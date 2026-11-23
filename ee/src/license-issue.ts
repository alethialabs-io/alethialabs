// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: LicenseRef-Alethia-Commercial

// The licence ISSUER, the counterpart to license.ts (the verifier). Alethia Labs issues a
// customer's licence offline with the private half of a licence signing keypair; the customer's
// instance verifies it with the public half compiled into the build (./license-keys.ts).
//
// Custody: the signing key lives only in Alethia Labs' offline custody. It reaches this code only
// as the `ALETHIA_LICENSE_SIGNING_KEY` environment variable that the credential broker puts in the
// tool's own process (`pnpm creds license-signing -- …`). It is never read from a file in the
// repository, never printed, and never part of any error message this file produces.
//
// `runIssueLicense` is the whole maintainer tool; ee/scripts/issue-license.ts only wires it to the
// process. Keeping it here lets the unit tests drive the tool end to end with a throwaway key.

import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync } from "node:crypto";
import * as jose from "jose";
import type { Entitlements } from "@/lib/authz/types";
import {
	DEFAULT_GRACE_DAYS,
	graceEndsAt,
	importVerificationKey,
	LICENSE_AUDIENCE,
	LICENSE_ISSUER,
	licenseState,
	MAX_GRACE_DAYS,
	verifyLicense,
} from "./license";
import { BUILT_IN_LICENSE_KEYS, type BuiltInLicenseKey } from "./license-keys";

/** Must match license.ts: the alg the verifier accepts. */
const ALG = "EdDSA";

/** The environment variable the issuance tool reads the signing key from. */
export const SIGNING_KEY_ENV = "ALETHIA_LICENSE_SIGNING_KEY";

/** The credential broker profile that holds {@link SIGNING_KEY_ENV}. */
export const SIGNING_KEY_PROFILE = "license-signing";

/** The longest licence the tool issues, in days (ten years). */
export const MAX_LICENSE_DAYS = 3660;

/** Inputs for minting a customer licence. */
export interface IssueLicenseInput {
	/** The ed25519 signing key as a PKCS8 PEM, raw or base64-encoded. */
	privateKeyB64: string;
	/** Who the licence is for (customer / instance id); becomes the JWT `sub`. */
	subject: string;
	/** The licensed tier label (default "enterprise"). */
	tier?: string;
	/** Optional explicit entitlement grant; omit to grant the full enterprise set at verify time. */
	entitlements?: Entitlements;
	/** Days until the licence ends; omit for a licence with no end (no `exp`). */
	expiresInDays?: number;
	/** Days the licence still grants after its end; becomes `grace_days` (default 30). */
	graceDays?: number;
	/** Optional key id, written to the token header as `kid`. */
	keyId?: string;
	/** Unix seconds "now", injectable so issuance is deterministic in tests. Defaults to wall clock. */
	nowSeconds?: number;
}

/** Decodes a PEM that may be raw or base64-encoded. */
function decodePem(raw: string): string {
	const trimmed = raw.trim();
	return trimmed.includes("-----BEGIN") ? trimmed : Buffer.from(trimmed, "base64").toString("utf8");
}

/** A key export as a string, whichever of string or Buffer node returned. */
function pemString(value: string | Buffer): string {
	return typeof value === "string" ? value : value.toString("utf8");
}

/**
 * Reads a signing key and checks it is an ed25519 private key. The thrown message never contains
 * any part of the key.
 */
function readSigningKeyPem(raw: string): string {
	let pem: string;
	try {
		pem = decodePem(raw);
		const key = createPrivateKey({ key: pem });
		if (key.asymmetricKeyType !== "ed25519") throw new Error("not ed25519");
	} catch {
		throw new Error("the licence signing key is not an ed25519 PKCS8 private key");
	}
	return pem;
}

/** Imports a signing key for jose. */
async function importSigningKey(raw: string): Promise<CryptoKey> {
	return jose.importPKCS8(readSigningKeyPem(raw), ALG, { extractable: false });
}

/**
 * Mints a signed licence JWT for a customer. The token carries the pinned issuer and audience so it
 * only verifies on an Alethia instance, `sub`/`tier` describe the grant, `exp` (when set) bounds its
 * life, and `grace_days` says how long it keeps granting after that.
 */
export async function issueLicense(input: IssueLicenseInput): Promise<string> {
	const privateKey = await importSigningKey(input.privateKeyB64);
	const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
	const graceDays = input.graceDays ?? DEFAULT_GRACE_DAYS;
	const claims: jose.JWTPayload = { tier: input.tier ?? "enterprise", grace_days: graceDays };
	if (input.entitlements) claims.entitlements = input.entitlements;

	const builder = new jose.SignJWT(claims)
		.setProtectedHeader(
			input.keyId ? { alg: ALG, typ: "JWT", kid: input.keyId } : { alg: ALG, typ: "JWT" },
		)
		.setIssuer(LICENSE_ISSUER)
		.setAudience(LICENSE_AUDIENCE)
		.setSubject(input.subject)
		.setIssuedAt(now);
	if (input.expiresInDays !== undefined) {
		builder.setExpirationTime(now + input.expiresInDays * 86_400);
	}
	return builder.sign(privateKey);
}

/** A freshly generated licence keypair, both halves base64(PEM)-encoded. For tests. */
export interface LicenseKeypair {
	/** base64(PKCS8 PEM): the signing key. */
	privateKeyB64: string;
	/** base64(SPKI PEM): the verification key. */
	publicKeyB64: string;
}

/**
 * Generates a throwaway ed25519 licence keypair, for tests that sign fixtures. The real Alethia
 * Labs signing keys are generated offline by the maintainer and never by this code.
 */
export function generateLicenseKeypair(): LicenseKeypair {
	const { privateKey, publicKey } = generateKeyPairSync("ed25519");
	const privPem = pemString(privateKey.export({ type: "pkcs8", format: "pem" }));
	const pubPem = pemString(publicKey.export({ type: "spki", format: "pem" }));
	return {
		privateKeyB64: Buffer.from(privPem, "utf8").toString("base64"),
		publicKeyB64: Buffer.from(pubPem, "utf8").toString("base64"),
	};
}

/** The SPKI PEM of the public half of a signing key. */
export function publicKeyPemFromSigningKey(raw: string): string {
	const pem = readSigningKeyPem(raw);
	return pemString(createPublicKey({ key: pem }).export({ type: "spki", format: "pem" }));
}

/** A short, stable fingerprint of a public key: the first 16 hex digits of SHA-256 over its DER. */
export function publicKeyFingerprint(spkiPem: string): string {
	const der = createPublicKey({ key: decodePem(spkiPem) }).export({ type: "spki", format: "der" });
	return createHash("sha256").update(der).digest("hex").slice(0, 16);
}

/** The built-in key whose fingerprint matches, or null. */
function shippedKey(
	fingerprint: string,
	keys: readonly BuiltInLicenseKey[],
): BuiltInLicenseKey | null {
	return keys.find((key) => publicKeyFingerprint(key.spkiPem) === fingerprint) ?? null;
}

/** The parsed command line of the issuance tool. */
export interface IssueArgs {
	subject: string;
	days: number;
	tier: string;
	graceDays: number;
	entitlementsFile: string | null;
	allowUnshippedKey: boolean;
}

/** The tool's usage text. */
export const ISSUE_USAGE = `Issue a signed Alethia Enterprise licence.

Usage:
  pnpm creds ${SIGNING_KEY_PROFILE} -- pnpm -F console exec tsx ../../ee/scripts/issue-license.ts \\
    --subject "<customer>" --days <n> [--tier enterprise] [--grace-days ${DEFAULT_GRACE_DAYS}] \\
    [--entitlements-file <path.json>] [--allow-unshipped-key]

The signing key is read from ${SIGNING_KEY_ENV}, which the credential broker sets for this
process only. The licence is written to standard output; a summary goes to standard error.

  --subject              who the licence is issued to (required)
  --days                 days until the licence ends, 1 to ${MAX_LICENSE_DAYS} (required)
  --tier                 the tier label (default: enterprise)
  --grace-days           days the licence keeps granting after it ends, 0 to ${MAX_GRACE_DAYS} (default: ${DEFAULT_GRACE_DAYS})
  --entitlements-file    a JSON file holding an explicit entitlements object (default: the full set)
  --allow-unshipped-key  issue with a key the release image does not carry (testing only)
`;

/** Reads a whole number in a range from a flag value, or throws naming the flag. */
function wholeNumber(flag: string, value: string | undefined, min: number, max: number): number {
	if (value === undefined || !/^\d+$/.test(value)) {
		throw new Error(`${flag} needs a whole number from ${min} to ${max}`);
	}
	const n = Number(value);
	if (n < min || n > max) throw new Error(`${flag} needs a whole number from ${min} to ${max}`);
	return n;
}

/** Parses the tool's command line. Throws with a message naming the first problem. */
export function parseIssueArgs(argv: readonly string[]): IssueArgs {
	let subject: string | null = null;
	let days: number | null = null;
	let tier = "enterprise";
	let graceDays = DEFAULT_GRACE_DAYS;
	let entitlementsFile: string | null = null;
	let allowUnshippedKey = false;
	for (let i = 0; i < argv.length; i++) {
		const flag = argv[i];
		const value = argv[i + 1];
		switch (flag) {
			case "--subject":
				if (value === undefined || value.trim() === "") throw new Error("--subject needs a value");
				subject = value.trim();
				i++;
				break;
			case "--days":
				days = wholeNumber(flag, value, 1, MAX_LICENSE_DAYS);
				i++;
				break;
			case "--tier":
				if (value === undefined || value.trim() === "") throw new Error("--tier needs a value");
				tier = value.trim();
				i++;
				break;
			case "--grace-days":
				graceDays = wholeNumber(flag, value, 0, MAX_GRACE_DAYS);
				i++;
				break;
			case "--entitlements-file":
				if (value === undefined || value === "") throw new Error("--entitlements-file needs a path");
				entitlementsFile = value;
				i++;
				break;
			case "--allow-unshipped-key":
				allowUnshippedKey = true;
				break;
			default:
				throw new Error(`unknown argument: ${flag}`);
		}
	}
	if (subject === null) throw new Error("--subject is required");
	if (days === null) throw new Error("--days is required");
	return { subject, days, tier, graceDays, entitlementsFile, allowUnshippedKey };
}

/** Narrows parsed JSON to an entitlements object: switches are booleans, `quotas` is an object. */
function isEntitlementsFile(value: unknown): value is Entitlements {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	return Object.entries(value).every(([name, member]) =>
		name === "quotas"
			? typeof member === "object" && member !== null && !Array.isArray(member)
			: typeof member === "boolean",
	);
}

/** What the issuance tool needs from its process, injectable so tests can drive it. */
export interface IssueIo {
	/** The process environment. */
	env: { [name: string]: string | undefined };
	/** Reads a text file. */
	readFile: (path: string) => string;
	/** Writes to standard output. */
	stdout: (text: string) => void;
	/** Writes to standard error. */
	stderr: (text: string) => void;
	/** The current instant. */
	now: () => Date;
	/** The built-in verification keys; defaults to the ones compiled into this build. */
	builtInKeys?: readonly BuiltInLicenseKey[];
}

/** An instant in Unix seconds as an ISO 8601 string, or a dash. */
function iso(seconds: number | null): string {
	return seconds === null ? "-" : new Date(seconds * 1000).toISOString();
}

/**
 * The issuance tool. Refuses without a signing key in the environment, refuses a key the release
 * image does not carry (unless told otherwise), issues the licence, verifies it round-trip with
 * the same verifier the instance runs, writes the licence to stdout and a summary to stderr.
 * Returns the process exit code.
 */
export async function runIssueLicense(argv: readonly string[], io: IssueIo): Promise<number> {
	if (argv.includes("--help") || argv.includes("-h")) {
		io.stdout(ISSUE_USAGE);
		return 0;
	}
	let args: IssueArgs;
	try {
		args = parseIssueArgs(argv);
	} catch (err) {
		io.stderr(`issue-license: ${err instanceof Error ? err.message : String(err)}\n\n${ISSUE_USAGE}`);
		return 2;
	}

	const signingKey = io.env[SIGNING_KEY_ENV];
	if (signingKey === undefined || signingKey.trim() === "") {
		io.stderr(
			`issue-license: ${SIGNING_KEY_ENV} is not set. Run this tool through the credential broker:\n` +
				`  pnpm creds ${SIGNING_KEY_PROFILE} -- pnpm -F console exec tsx ../../ee/scripts/issue-license.ts …\n`,
		);
		return 2;
	}

	try {
		let entitlements: Entitlements | undefined;
		if (args.entitlementsFile !== null) {
			const parsed: unknown = JSON.parse(io.readFile(args.entitlementsFile));
			if (!isEntitlementsFile(parsed)) {
				throw new Error(
					"the entitlements file must hold a JSON object of boolean switches and an optional quotas object",
				);
			}
			entitlements = parsed;
		}

		const publicPem = publicKeyPemFromSigningKey(signingKey);
		const fingerprint = publicKeyFingerprint(publicPem);
		const shipped = shippedKey(fingerprint, io.builtInKeys ?? BUILT_IN_LICENSE_KEYS);
		if (shipped === null && !args.allowUnshippedKey) {
			io.stderr(
				`issue-license: the signing key (fingerprint ${fingerprint}) does not match a key built into ` +
					"the release image (ee/src/license-keys.ts), so the image would report the licence as invalid. " +
					"Ship the public key first, or pass --allow-unshipped-key for a test licence.\n",
			);
			return 3;
		}

		const now = io.now();
		const nowSeconds = Math.floor(now.getTime() / 1000);
		const token = await issueLicense({
			privateKeyB64: signingKey,
			subject: args.subject,
			tier: args.tier,
			entitlements,
			expiresInDays: args.days,
			graceDays: args.graceDays,
			keyId: shipped?.id ?? fingerprint,
			nowSeconds,
		});

		// Round trip: the verifier the instance runs must accept what was just issued.
		const license = await verifyLicense(token, await importVerificationKey(publicPem));
		const state = licenseState({ verified: true, license }, now, true);
		if (state !== "active" && state !== "expiring") {
			throw new Error(`the issued licence verified as "${state}", not active`);
		}

		io.stdout(`${token}\n`);
		io.stderr(
			[
				"Issued an Alethia licence.",
				`  subject      ${license.subject}`,
				`  tier         ${license.tier}`,
				`  entitlements ${entitlements ? "explicit (from file)" : "full enterprise set"}`,
				`  expires      ${iso(license.expiresAt)}`,
				`  grace ends   ${iso(graceEndsAt(license))} (${license.graceDays} days)`,
				`  state now    ${state}`,
				`  signing key  ${fingerprint}${shipped ? ` (built-in key ${shipped.id})` : " (NOT built into the release image)"}`,
				"",
			].join("\n"),
		);
		return 0;
	} catch (err) {
		io.stderr(`issue-license: ${err instanceof Error ? err.message : String(err)}\n`);
		return 1;
	}
}
