// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: LicenseRef-Alethia-Commercial

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generateLicenseKeypair, issueLicense } from "./license-issue";
import {
	__resetLicenseCache,
	LICENSE_AUDIENCE,
	LICENSE_ISSUER,
	resolveInstanceLicense,
	verifyLicense,
} from "./license";
import { importSPKI } from "jose";

/** A stable "now" so exp math is deterministic. */
const NOW = 1_800_000_000; // 2027-01-15-ish

const keys = generateLicenseKeypair();

async function publicKey() {
	const pem = Buffer.from(keys.publicKeyB64, "base64").toString("utf8");
	return importSPKI(pem, "EdDSA", { extractable: false });
}

/** Snapshot + restore the env each case so bleed-through can't hide a bug. */
let savedEnv: NodeJS.ProcessEnv;
beforeEach(() => {
	savedEnv = { ...process.env };
	delete process.env.ALETHIA_LICENSE_ACTIVE;
	delete process.env.ALETHIA_LICENSE_KEY;
	delete process.env.ALETHIA_LICENSE_PUBLIC_KEY;
	__resetLicenseCache();
});
afterEach(() => {
	process.env = savedEnv;
	__resetLicenseCache();
});

describe("verifyLicense (issue → verify round-trip)", () => {
	it("verifies a well-formed license and returns its claims", async () => {
		const token = await issueLicense({
			privateKeyB64: keys.privateKeyB64,
			subject: "acme-corp",
			tier: "enterprise",
			expiresInDays: 365,
			nowSeconds: NOW,
		});
		const license = await verifyLicense(token, await publicKey());
		expect(license.subject).toBe("acme-corp");
		expect(license.tier).toBe("enterprise");
		expect(license.expiresAt).toBe(NOW + 365 * 86_400);
	});

	it("carries a perpetual license with no expiry", async () => {
		const token = await issueLicense({
			privateKeyB64: keys.privateKeyB64,
			subject: "perpetual-co",
			nowSeconds: NOW,
		});
		const license = await verifyLicense(token, await publicKey());
		expect(license.expiresAt).toBeNull();
	});

	it("rejects a license signed by a DIFFERENT key (forgery)", async () => {
		const attacker = generateLicenseKeypair();
		const token = await issueLicense({
			privateKeyB64: attacker.privateKeyB64,
			subject: "forged",
			nowSeconds: NOW,
		});
		await expect(verifyLicense(token, await publicKey())).rejects.toThrow();
	});

	it("rejects a tampered token", async () => {
		const token = await issueLicense({
			privateKeyB64: keys.privateKeyB64,
			subject: "acme-corp",
			nowSeconds: NOW,
		});
		const parts = token.split(".");
		// Flip a byte in the payload segment.
		const bad = `${parts[0]}.${parts[1]}x.${parts[2]}`;
		await expect(verifyLicense(bad, await publicKey())).rejects.toThrow();
	});

	it("rejects an expired license", async () => {
		// jose checks `exp` against the real wall clock, so anchor issuance firmly in the past
		// (Sept 2020) with a 1-day life — expired no matter when the suite runs.
		const token = await issueLicense({
			privateKeyB64: keys.privateKeyB64,
			subject: "lapsed",
			expiresInDays: 1,
			nowSeconds: 1_600_000_000,
		});
		await expect(verifyLicense(token, await publicKey())).rejects.toThrow();
	});

	it("rejects a wrong-audience token", async () => {
		const attacker = keys;
		// Hand-mint a token with the right key + issuer but a foreign audience.
		const { SignJWT, importPKCS8 } = await import("jose");
		const pk = await importPKCS8(
			Buffer.from(attacker.privateKeyB64, "base64").toString("utf8"),
			"EdDSA",
		);
		const token = await new SignJWT({ tier: "enterprise" })
			.setProtectedHeader({ alg: "EdDSA", typ: "JWT" })
			.setIssuer(LICENSE_ISSUER)
			.setAudience("some-other-app")
			.setSubject("wrong-aud")
			.setIssuedAt(NOW)
			.sign(pk);
		await expect(verifyLicense(token, await publicKey())).rejects.toThrow();
	});

	it("pins issuer + audience to the exported constants", () => {
		expect(LICENSE_ISSUER).toBe("https://alethialabs.io/license");
		expect(LICENSE_AUDIENCE).toBe("alethia-instance");
	});
});

describe("resolveInstanceLicense (the boot gate)", () => {
	it("is inactive with no license configured", async () => {
		const r = await resolveInstanceLicense();
		expect(r.active).toBe(false);
		expect(r.reason).toMatch(/no ALETHIA_LICENSE_KEY/);
	});

	it("is inactive when a key is set but no public key to verify it", async () => {
		process.env.ALETHIA_LICENSE_KEY = "whatever";
		const r = await resolveInstanceLicense();
		expect(r.active).toBe(false);
		expect(r.reason).toMatch(/ALETHIA_LICENSE_PUBLIC_KEY is not/);
	});

	it("activates on a valid signed license", async () => {
		process.env.ALETHIA_LICENSE_KEY = await issueLicense({
			privateKeyB64: keys.privateKeyB64,
			subject: "acme-corp",
			nowSeconds: NOW,
		});
		process.env.ALETHIA_LICENSE_PUBLIC_KEY = keys.publicKeyB64;
		const r = await resolveInstanceLicense();
		expect(r.active).toBe(true);
		expect(r.license?.subject).toBe("acme-corp");
	});

	it("stays inactive (does not crash) on a bad signature", async () => {
		const attacker = generateLicenseKeypair();
		process.env.ALETHIA_LICENSE_KEY = await issueLicense({
			privateKeyB64: attacker.privateKeyB64,
			subject: "forged",
			nowSeconds: NOW,
		});
		process.env.ALETHIA_LICENSE_PUBLIC_KEY = keys.publicKeyB64;
		const r = await resolveInstanceLicense();
		expect(r.active).toBe(false);
		expect(r.reason).toMatch(/failed verification/);
	});

	it("honors the dev bypass only outside production", async () => {
		process.env.ALETHIA_LICENSE_ACTIVE = "true";
		const prev = process.env.NODE_ENV;

		process.env.NODE_ENV = "development";
		__resetLicenseCache();
		expect((await resolveInstanceLicense()).active).toBe(true);

		process.env.NODE_ENV = "production";
		__resetLicenseCache();
		const prod = await resolveInstanceLicense();
		expect(prod.active).toBe(false);
		expect(prod.reason).toMatch(/ignored in production/);

		process.env.NODE_ENV = prev;
	});
});
