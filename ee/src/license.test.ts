// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: LicenseRef-Alethia-Commercial

// EDN-E3: licence verification, the six licence states at fixed clocks, and custody of the
// verification key (the built-in keys and the release-image build flag).
//
// Every licence here is signed with a throwaway key generated in this file. The built-in key list
// and the image-build flag are replaced by a mock whose state each case sets, so the release-image
// path (built-in keys only, every runtime override ignored) is exercised without a real key.
// Expected values are written out by hand, never derived from the module under test.

import { generateKeyPairSync } from "node:crypto";
import { type LicenseState, licenseStateGrants } from "@alethia/enterprise-api";
import { importPKCS8, importSPKI, SignJWT } from "jose";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** The state the mocked ./license-keys answers with; each case sets what it needs. */
const keyState = vi.hoisted(() => ({
	image: false,
	keys: new Array<{ id: string; spkiPem: string }>(),
}));

vi.mock("./license-keys", () => ({
	get BUILT_IN_LICENSE_KEYS() {
		return keyState.keys;
	},
	isImageBuild: () => keyState.image,
}));

import {
	__resetLicenseCache,
	DEFAULT_GRACE_DAYS,
	type InstanceLicense,
	importVerificationKey,
	LICENSE_AUDIENCE,
	LICENSE_ISSUER,
	type License,
	licenseGrants,
	licenseState,
	resolveInstanceLicense,
	verifyLicense,
} from "./license";
import { generateLicenseKeypair, issueLicense } from "./license-issue";

/** A fixed clock: 2027-01-15T08:00:00Z. */
const NOW_SECONDS = 1_800_000_000;
const NOW = new Date(NOW_SECONDS * 1000);
const DAY = 86_400;

const keys = generateLicenseKeypair();

/** The SPKI PEM of a base64(PEM) public key. */
function pemOf(b64: string): string {
	return Buffer.from(b64, "base64").toString("utf8");
}

/** This file's verification key, imported. */
async function publicKey() {
	return importSPKI(pemOf(keys.publicKeyB64), "EdDSA", { extractable: false });
}

/** Signs an arbitrary payload with this file's key, for the malformed-claim cases. */
async function signRaw(claims: { [name: string]: unknown }) {
	const pk = await importPKCS8(pemOf(keys.privateKeyB64), "EdDSA");
	return new SignJWT(claims).setProtectedHeader({ alg: "EdDSA", typ: "JWT" }).sign(pk);
}

/** The claims every well-formed licence carries. */
const BASE_CLAIMS = {
	iss: LICENSE_ISSUER,
	aud: LICENSE_AUDIENCE,
	sub: "acme-corp",
	tier: "enterprise",
	iat: NOW_SECONDS,
};

/** A verified licence as resolveInstanceLicense returns it. */
function verified(expiresAt: number | null, graceDays = DEFAULT_GRACE_DAYS): InstanceLicense {
	const license: License = { subject: "acme-corp", tier: "enterprise", expiresAt, graceDays };
	return { verified: true, license };
}

/** Snapshot and restore the env each case so bleed-through cannot hide a bug. */
let savedEnv: NodeJS.ProcessEnv;
beforeEach(() => {
	savedEnv = { ...process.env };
	delete process.env.ALETHIA_LICENSE_ACTIVE;
	delete process.env.ALETHIA_LICENSE_KEY;
	delete process.env.ALETHIA_LICENSE_PUBLIC_KEY;
	keyState.image = false;
	keyState.keys = [];
	__resetLicenseCache();
});
afterEach(() => {
	vi.unstubAllEnvs();
	process.env = savedEnv;
	__resetLicenseCache();
});

describe("verifyLicense: issue → verify round trip", () => {
	it("verifies a well-formed licence and returns its claims, with the default grace period", async () => {
		const token = await issueLicense({
			privateKeyB64: keys.privateKeyB64,
			subject: "acme-corp",
			tier: "enterprise",
			expiresInDays: 365,
			nowSeconds: NOW_SECONDS,
		});
		expect(await verifyLicense(token, await publicKey())).toEqual({
			subject: "acme-corp",
			tier: "enterprise",
			entitlements: undefined,
			expiresAt: NOW_SECONDS + 365 * DAY,
			graceDays: 30,
		});
	});

	it("carries an explicit grace period and an explicit entitlements claim", async () => {
		const token = await issueLicense({
			privateKeyB64: keys.privateKeyB64,
			subject: "acme-corp",
			expiresInDays: 10,
			graceDays: 7,
			entitlements: {
				organizations: true,
				teams: true,
				sso: false,
				customRoles: false,
				activityExport: false,
				alerting: false,
				advancedAlerting: false,
				byoRunners: false,
				managedPools: false,
				agentPolicy: false,
				quotas: {
					maxConcurrentJobs: null,
					priorityLevel: 30,
					includedRunnerMinutes: 1,
					activityRetentionDays: 1,
				},
			},
			nowSeconds: NOW_SECONDS,
		});
		const license = await verifyLicense(token, await publicKey());
		expect(license.graceDays).toBe(7);
		expect(license.entitlements?.teams).toBe(true);
		expect(license.entitlements?.sso).toBe(false);
	});

	it("carries a licence with no end", async () => {
		const token = await issueLicense({
			privateKeyB64: keys.privateKeyB64,
			subject: "perpetual-co",
			nowSeconds: NOW_SECONDS,
		});
		expect((await verifyLicense(token, await publicKey())).expiresAt).toBeNull();
	});

	it("still verifies a correctly signed licence whose end has passed; the state reads the dates", async () => {
		const token = await issueLicense({
			privateKeyB64: keys.privateKeyB64,
			subject: "lapsed",
			expiresInDays: 1,
			nowSeconds: 1_600_000_000,
		});
		const license = await verifyLicense(token, await publicKey());
		expect(license.expiresAt).toBe(1_600_086_400);
		expect(licenseState({ verified: true, license }, NOW, true)).toBe("expired");
	});

	it("verifies against the second of two trusted keys (rotation)", async () => {
		const retired = generateLicenseKeypair();
		const token = await issueLicense({
			privateKeyB64: keys.privateKeyB64,
			subject: "acme-corp",
			nowSeconds: NOW_SECONDS,
		});
		const both = [await importVerificationKey(retired.publicKeyB64), await publicKey()];
		expect((await verifyLicense(token, both)).subject).toBe("acme-corp");
	});

	it("refuses when there is no key to verify against", async () => {
		const token = await issueLicense({ privateKeyB64: keys.privateKeyB64, subject: "x" });
		await expect(verifyLicense(token, [])).rejects.toThrow(/no licence verification key/);
	});
});

describe("verifyLicense: a tampered or foreign licence never verifies", () => {
	it("refuses a licence signed by a different key", async () => {
		const other = generateLicenseKeypair();
		const token = await issueLicense({ privateKeyB64: other.privateKeyB64, subject: "forged" });
		await expect(verifyLicense(token, await publicKey())).rejects.toThrow(/does not verify/);
	});

	it("refuses a licence whose payload was edited (a later end written in)", async () => {
		const token = await issueLicense({
			privateKeyB64: keys.privateKeyB64,
			subject: "acme-corp",
			expiresInDays: 1,
			nowSeconds: NOW_SECONDS,
		});
		const [header, payload, signature] = token.split(".");
		const claims: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
		if (typeof claims !== "object" || claims === null) throw new Error("fixture payload");
		const edited = Buffer.from(
			JSON.stringify({ ...claims, exp: NOW_SECONDS + 3650 * DAY }),
		).toString("base64url");
		await expect(
			verifyLicense(`${header}.${edited}.${signature}`, await publicKey()),
		).rejects.toThrow(/does not verify/);
	});

	it("refuses a licence whose signature was altered", async () => {
		const token = await issueLicense({ privateKeyB64: keys.privateKeyB64, subject: "acme-corp" });
		const [header, payload, signature] = token.split(".");
		const flipped = `${signature.startsWith("A") ? "B" : "A"}${signature.slice(1)}`;
		await expect(
			verifyLicense(`${header}.${payload}.${flipped}`, await publicKey()),
		).rejects.toThrow(/does not verify/);
	});

	it("refuses an unsigned licence (alg none)", async () => {
		const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
		const payload = Buffer.from(JSON.stringify(BASE_CLAIMS)).toString("base64url");
		await expect(verifyLicense(`${header}.${payload}.`, await publicKey())).rejects.toThrow(
			/does not verify/,
		);
	});

	it("refuses a licence that is not a JWT at all", async () => {
		await expect(verifyLicense("not-a-licence", await publicKey())).rejects.toThrow(
			/does not verify/,
		);
	});

	it.each<[string, { [name: string]: unknown }]>([
		["a foreign audience", { ...BASE_CLAIMS, aud: "some-other-app" }],
		["a foreign issuer", { ...BASE_CLAIMS, iss: "https://example.com/license" }],
		["no subject", { ...BASE_CLAIMS, sub: undefined }],
		["an empty subject", { ...BASE_CLAIMS, sub: "  " }],
		["a non-string tier", { ...BASE_CLAIMS, tier: 3 }],
		["an end that is not a number", { ...BASE_CLAIMS, exp: "2030-01-01" }],
		["a negative grace period", { ...BASE_CLAIMS, grace_days: -1 }],
		["a grace period above the maximum", { ...BASE_CLAIMS, grace_days: 366 }],
		["a fractional grace period", { ...BASE_CLAIMS, grace_days: 1.5 }],
		["a grace period written as text", { ...BASE_CLAIMS, grace_days: "30" }],
		["an nbf claim", { ...BASE_CLAIMS, nbf: NOW_SECONDS }],
		["an entitlements claim that is a list", { ...BASE_CLAIMS, entitlements: ["teams"] }],
	])("refuses a correctly signed licence with %s", async (_label, claims) => {
		await expect(verifyLicense(await signRaw(claims), await publicKey())).rejects.toThrow(
			/^licence /,
		);
	});

	it("accepts an audience given as a list that names the instance", async () => {
		const token = await signRaw({ ...BASE_CLAIMS, aud: ["other", LICENSE_AUDIENCE] });
		expect((await verifyLicense(token, await publicKey())).subject).toBe("acme-corp");
	});

	it("refuses a verification key that is not ed25519", async () => {
		const { publicKey: rsa } = generateKeyPairSync("rsa", { modulusLength: 2048 });
		const pem = rsa.export({ type: "spki", format: "pem" }).toString();
		await expect(importVerificationKey(pem)).rejects.toThrow(/not an ed25519/);
	});

	it("pins issuer and audience to the exported constants", () => {
		expect(LICENSE_ISSUER).toBe("https://alethialabs.io/license");
		expect(LICENSE_AUDIENCE).toBe("alethia-instance");
	});
});

describe("licenseState: the six states at a fixed clock", () => {
	it("is `none` when no licence is installed", () => {
		expect(licenseState({ verified: false }, NOW, false)).toBe("none");
	});

	it("is `invalid` when a licence is installed and did not verify", () => {
		expect(licenseState({ verified: false, reason: "bad signature" }, NOW, true)).toBe("invalid");
	});

	it("is `invalid` when the state says verified and carries no licence", () => {
		expect(licenseState({ verified: true }, NOW, true)).toBe("invalid");
	});

	it("is `active` for a licence with no end", () => {
		expect(licenseState(verified(null), NOW, true)).toBe("active");
	});

	it("is `active` with more than 30 days left", () => {
		expect(licenseState(verified(NOW_SECONDS + 30 * DAY + 1), NOW, true)).toBe("active");
	});

	it("is `expiring` with exactly 30 days left, and with one second left", () => {
		expect(licenseState(verified(NOW_SECONDS + 30 * DAY), NOW, true)).toBe("expiring");
		expect(licenseState(verified(NOW_SECONDS + 1), NOW, true)).toBe("expiring");
	});

	it("is `grace` at the instant the licence ends, and until the grace period ends", () => {
		expect(licenseState(verified(NOW_SECONDS), NOW, true)).toBe("grace");
		expect(licenseState(verified(NOW_SECONDS - 30 * DAY + 1), NOW, true)).toBe("grace");
	});

	it("is `expired` at the instant the grace period ends, and after", () => {
		expect(licenseState(verified(NOW_SECONDS - 30 * DAY), NOW, true)).toBe("expired");
		expect(licenseState(verified(NOW_SECONDS - 400 * DAY), NOW, true)).toBe("expired");
	});

	it("honours the licence's own grace period, including none at all", () => {
		expect(licenseState(verified(NOW_SECONDS - 5 * DAY, 7), NOW, true)).toBe("grace");
		expect(licenseState(verified(NOW_SECONDS - 8 * DAY, 7), NOW, true)).toBe("expired");
		expect(licenseState(verified(NOW_SECONDS, 0), NOW, true)).toBe("expired");
	});

	it("is `invalid` when the dates cannot be compared", () => {
		expect(licenseState(verified(Number.NaN), NOW, true)).toBe("invalid");
		expect(licenseState(verified(NOW_SECONDS + DAY), new Date(Number.NaN), true)).toBe("invalid");
	});
});

describe("licenseGrants", () => {
	const STATES: [LicenseState, boolean][] = [
		["none", false],
		["active", true],
		["expiring", true],
		["grace", true],
		["expired", false],
		["invalid", false],
	];

	it.each(STATES)("`%s` grants: %s, and agrees with @alethia/enterprise-api", (state, grants) => {
		expect(licenseGrants(state)).toBe(grants);
		expect(licenseStateGrants(state)).toBe(grants);
	});
});

describe("resolveInstanceLicense: the boot gate outside a release image", () => {
	it("is unverified with no licence installed", async () => {
		const r = await resolveInstanceLicense();
		expect(r.verified).toBe(false);
		expect(r.reason).toMatch(/no ALETHIA_LICENSE_KEY/);
	});

	it("is unverified when a licence is installed and the build carries no key", async () => {
		process.env.ALETHIA_LICENSE_KEY = await issueLicense({
			privateKeyB64: keys.privateKeyB64,
			subject: "acme-corp",
		});
		const r = await resolveInstanceLicense();
		expect(r.verified).toBe(false);
		expect(r.reason).toMatch(/carries no licence verification key/);
	});

	it("verifies against the development key outside production", async () => {
		vi.stubEnv("NODE_ENV", "development");
		process.env.ALETHIA_LICENSE_KEY = await issueLicense({
			privateKeyB64: keys.privateKeyB64,
			subject: "acme-corp",
		});
		process.env.ALETHIA_LICENSE_PUBLIC_KEY = keys.publicKeyB64;
		const r = await resolveInstanceLicense();
		expect(r.verified).toBe(true);
		expect(r.license?.subject).toBe("acme-corp");
	});

	it("ignores the development key in production", async () => {
		vi.stubEnv("NODE_ENV", "production");
		process.env.ALETHIA_LICENSE_KEY = await issueLicense({
			privateKeyB64: keys.privateKeyB64,
			subject: "acme-corp",
		});
		process.env.ALETHIA_LICENSE_PUBLIC_KEY = keys.publicKeyB64;
		const r = await resolveInstanceLicense();
		expect(r.verified).toBe(false);
		expect(r.reason).toMatch(/ALETHIA_LICENSE_PUBLIC_KEY is ignored/);
	});

	it("stays unverified, without throwing, on a licence signed by another key", async () => {
		const other = generateLicenseKeypair();
		process.env.ALETHIA_LICENSE_KEY = await issueLicense({
			privateKeyB64: other.privateKeyB64,
			subject: "forged",
		});
		process.env.ALETHIA_LICENSE_PUBLIC_KEY = keys.publicKeyB64;
		const r = await resolveInstanceLicense();
		expect(r.verified).toBe(false);
		expect(r.reason).toMatch(/failed verification/);
	});

	it("honours the development switch only outside production", async () => {
		process.env.ALETHIA_LICENSE_ACTIVE = "true";

		vi.stubEnv("NODE_ENV", "development");
		__resetLicenseCache();
		expect((await resolveInstanceLicense()).verified).toBe(true);

		vi.stubEnv("NODE_ENV", "production");
		__resetLicenseCache();
		const prod = await resolveInstanceLicense();
		expect(prod.verified).toBe(false);
		expect(prod.reason).toMatch(/ignored in this build/);
	});
});

describe("resolveInstanceLicense: a release image trusts its built-in keys only", () => {
	beforeEach(() => {
		keyState.image = true;
		keyState.keys = [{ id: "test-a", spkiPem: pemOf(keys.publicKeyB64) }];
		// The overrides below must be ignored even where NODE_ENV would allow them.
		vi.stubEnv("NODE_ENV", "development");
	});

	it("verifies a licence signed by the built-in key", async () => {
		process.env.ALETHIA_LICENSE_KEY = await issueLicense({
			privateKeyB64: keys.privateKeyB64,
			subject: "acme-corp",
			expiresInDays: 365,
		});
		const r = await resolveInstanceLicense();
		expect(r.verified).toBe(true);
		expect(r.license?.subject).toBe("acme-corp");
		expect(licenseState(r, new Date(), true)).toBe("active");
	});

	it("refuses a licence signed by an operator's own key, even with that key in the environment", async () => {
		const operator = generateLicenseKeypair();
		process.env.ALETHIA_LICENSE_KEY = await issueLicense({
			privateKeyB64: operator.privateKeyB64,
			subject: "self-issued",
		});
		process.env.ALETHIA_LICENSE_PUBLIC_KEY = operator.publicKeyB64;
		const r = await resolveInstanceLicense();
		expect(r.verified).toBe(false);
		expect(r.license).toBeUndefined();
		expect(licenseState(r, new Date(), true)).toBe("invalid");
	});

	it("ignores the development switch", async () => {
		process.env.ALETHIA_LICENSE_ACTIVE = "true";
		const r = await resolveInstanceLicense();
		expect(r.verified).toBe(false);
		expect(r.reason).toMatch(/ignored in this build/);
	});

	it("reports an installed licence as unverifiable when the image carries no key", async () => {
		keyState.keys = [];
		process.env.ALETHIA_LICENSE_KEY = await issueLicense({
			privateKeyB64: keys.privateKeyB64,
			subject: "acme-corp",
		});
		process.env.ALETHIA_LICENSE_PUBLIC_KEY = keys.publicKeyB64;
		const r = await resolveInstanceLicense();
		expect(r.verified).toBe(false);
		expect(r.reason).toMatch(/carries no licence verification key/);
		expect(licenseState(r, new Date(), true)).toBe("invalid");
	});
});
