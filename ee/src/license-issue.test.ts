// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: LicenseRef-Alethia-Commercial

// EDN-E3: the licence issuance tool (ee/scripts/issue-license.ts → runIssueLicense), driven end to
// end with a throwaway signing key generated in this file. Its output must round-trip through the
// verifier the instance runs; it must refuse to run without a signing key in its environment; and
// nothing it writes may contain the signing key.

import { decodeProtectedHeader, importSPKI } from "jose";
import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { licenseState, verifyLicense } from "./license";
import {
	generateLicenseKeypair,
	type IssueIo,
	parseIssueArgs,
	publicKeyFingerprint,
	publicKeyPemFromSigningKey,
	runIssueLicense,
	SIGNING_KEY_ENV,
} from "./license-issue";
import { BUILT_IN_LICENSE_KEYS, isImageBuild } from "./license-keys";

/** A fixed clock: 2027-01-15T08:00:00Z. */
const NOW = new Date(1_800_000_000 * 1000);

const keys = generateLicenseKeypair();
const PUBLIC_PEM = Buffer.from(keys.publicKeyB64, "base64").toString("utf8");
const PRIVATE_PEM = Buffer.from(keys.privateKeyB64, "base64").toString("utf8");

/** What one run of the tool wrote, and its exit code. */
interface Run {
	code: number;
	stdout: string;
	stderr: string;
}

/** Runs the tool with an in-memory process: the given env, files and built-in keys. */
async function run(
	argv: string[],
	options: {
		env?: { [name: string]: string | undefined };
		files?: { [path: string]: string };
		shipped?: boolean;
	} = {},
): Promise<Run> {
	let stdout = "";
	let stderr = "";
	const io: IssueIo = {
		env: options.env ?? { [SIGNING_KEY_ENV]: keys.privateKeyB64 },
		readFile: (path) => {
			const text = options.files?.[path];
			if (text === undefined) throw new Error(`ENOENT: ${path}`);
			return text;
		},
		stdout: (text) => {
			stdout += text;
		},
		stderr: (text) => {
			stderr += text;
		},
		now: () => NOW,
		builtInKeys: options.shipped === false ? [] : [{ id: "test-a", spkiPem: PUBLIC_PEM }],
	};
	const code = await runIssueLicense(argv, io);
	return { code, stdout, stderr };
}

/** Asserts no part of the signing key appears in what the tool wrote. */
function expectNoKeyMaterial(result: Run): void {
	const written = result.stdout + result.stderr;
	expect(written).not.toContain(keys.privateKeyB64);
	expect(written).not.toContain("PRIVATE KEY");
	for (const line of PRIVATE_PEM.split("\n").filter((l) => l.length > 20 && !l.startsWith("-----"))) {
		expect(written).not.toContain(line);
	}
}

describe("runIssueLicense: issuance round-trips through verifyLicense", () => {
	it("issues a licence the instance verifies as active, with sub, tier, exp and grace_days", async () => {
		const result = await run(["--subject", "Example GmbH", "--days", "365"]);
		expect(result.code).toBe(0);
		const token = result.stdout.trim();
		const license = await verifyLicense(token, await importSPKI(PUBLIC_PEM, "EdDSA"));
		expect(license).toEqual({
			subject: "Example GmbH",
			tier: "enterprise",
			entitlements: undefined,
			expiresAt: 1_800_000_000 + 365 * 86_400,
			graceDays: 30,
		});
		expect(licenseState({ verified: true, license }, NOW, true)).toBe("active");
		expect(decodeProtectedHeader(token)).toEqual({ alg: "EdDSA", typ: "JWT", kid: "test-a" });
		expect(result.stderr).toMatch(/built-in key test-a/);
		expectNoKeyMaterial(result);
	});

	it("issues a short licence, which verifies as expiring, with its own tier and grace period", async () => {
		const result = await run([
			"--subject",
			"Eval Ltd",
			"--days",
			"14",
			"--tier",
			"evaluation",
			"--grace-days",
			"0",
		]);
		expect(result.code).toBe(0);
		const license = await verifyLicense(result.stdout.trim(), await importSPKI(PUBLIC_PEM, "EdDSA"));
		expect(license.tier).toBe("evaluation");
		expect(license.graceDays).toBe(0);
		expect(licenseState({ verified: true, license }, NOW, true)).toBe("expiring");
	});

	it("carries an explicit entitlements object from a file", async () => {
		const result = await run(
			["--subject", "Narrow Co", "--days", "90", "--entitlements-file", "ent.json"],
			{ files: { "ent.json": JSON.stringify({ teams: true, sso: true, organizations: false }) } },
		);
		expect(result.code).toBe(0);
		const license = await verifyLicense(result.stdout.trim(), await importSPKI(PUBLIC_PEM, "EdDSA"));
		expect(license.entitlements).toEqual({ teams: true, sso: true, organizations: false });
	});

	it("refuses an entitlements file whose switches are not booleans", async () => {
		const result = await run(
			["--subject", "Narrow Co", "--days", "90", "--entitlements-file", "ent.json"],
			{ files: { "ent.json": JSON.stringify({ teams: "yes" }) } },
		);
		expect(result.code).toBe(1);
		expect(result.stdout).toBe("");
	});
});

describe("runIssueLicense: custody", () => {
	it("refuses to run without the signing key in its environment, and names the broker", async () => {
		const result = await run(["--subject", "Example GmbH", "--days", "365"], { env: {} });
		expect(result.code).toBe(2);
		expect(result.stdout).toBe("");
		expect(result.stderr).toContain(`${SIGNING_KEY_ENV} is not set`);
		expect(result.stderr).toContain("pnpm creds license-signing --");
	});

	it("refuses a signing key the release image does not carry", async () => {
		const result = await run(["--subject", "Example GmbH", "--days", "365"], { shipped: false });
		expect(result.code).toBe(3);
		expect(result.stdout).toBe("");
		expect(result.stderr).toMatch(/does not match a key built into the release image/);
		expectNoKeyMaterial(result);
	});

	it("issues with an unshipped key only when told to, and says so", async () => {
		const result = await run(
			["--subject", "Test", "--days", "30", "--allow-unshipped-key"],
			{ shipped: false },
		);
		expect(result.code).toBe(0);
		expect(result.stderr).toMatch(/NOT built into the release image/);
		const kid = decodeProtectedHeader(result.stdout.trim()).kid;
		expect(kid).toBe(publicKeyFingerprint(PUBLIC_PEM));
	});

	it("refuses a signing key that is not ed25519, without echoing it", async () => {
		const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
		const rsaPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
		const result = await run(["--subject", "X", "--days", "30"], {
			env: { [SIGNING_KEY_ENV]: rsaPem },
		});
		expect(result.code).toBe(1);
		expect(result.stderr).toMatch(/not an ed25519 PKCS8 private key/);
		expect(result.stderr + result.stdout).not.toContain("PRIVATE KEY");
	});

	it("derives the same public key and fingerprint from a raw or base64 signing key", () => {
		expect(publicKeyPemFromSigningKey(PRIVATE_PEM)).toBe(PUBLIC_PEM);
		expect(publicKeyPemFromSigningKey(keys.privateKeyB64)).toBe(PUBLIC_PEM);
		expect(publicKeyFingerprint(PUBLIC_PEM)).toBe(publicKeyFingerprint(keys.publicKeyB64));
		expect(publicKeyFingerprint(PUBLIC_PEM)).toMatch(/^[0-9a-f]{16}$/);
	});
});

describe("parseIssueArgs and the command line", () => {
	it.each<[string, string[], RegExp]>([
		["no subject", ["--days", "30"], /--subject is required/],
		["no end", ["--subject", "X"], /--days is required/],
		["a zero-day licence", ["--subject", "X", "--days", "0"], /--days needs a whole number/],
		["a licence over ten years", ["--subject", "X", "--days", "3661"], /--days needs a whole number/],
		["a fractional day count", ["--subject", "X", "--days", "1.5"], /--days needs a whole number/],
		["a grace period over a year", ["--subject", "X", "--days", "9", "--grace-days", "366"], /--grace-days/],
		["an unknown flag", ["--subject", "X", "--days", "9", "--perpetual"], /unknown argument/],
	])("refuses %s", async (_label, argv, message) => {
		expect(() => parseIssueArgs(argv)).toThrow(message);
		const result = await run(argv);
		expect(result.code).toBe(2);
		expect(result.stdout).toBe("");
	});

	it("prints usage for --help", async () => {
		const result = await run(["--help"], { env: {} });
		expect(result.code).toBe(0);
		expect(result.stdout).toMatch(/^Issue a signed Alethia Enterprise licence/);
	});
});

describe("the built-in keys as this build compiles them", () => {
	it("is not a release image build under the test runner", () => {
		expect(isImageBuild()).toBe(false);
	});

	it("lists only ed25519 public keys, under unique ids", () => {
		const ids = BUILT_IN_LICENSE_KEYS.map((key) => key.id);
		expect(new Set(ids).size).toBe(ids.length);
		expect(BUILT_IN_LICENSE_KEYS.length).toBeLessThanOrEqual(2);
		for (const key of BUILT_IN_LICENSE_KEYS) {
			expect(key.spkiPem).toContain("-----BEGIN PUBLIC KEY-----");
			expect(publicKeyFingerprint(key.spkiPem)).toMatch(/^[0-9a-f]{16}$/);
		}
	});
});
