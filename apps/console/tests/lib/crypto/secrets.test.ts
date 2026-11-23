// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CONSOLE_INSTANCE_SECRETS } from "@/lib/crypto/secrets";

// The key is cached at module scope, so each scenario resets modules and re-imports with the
// env it wants — same pattern as the Stripe config test.
const KEY = randomBytes(32).toString("base64");
const ORIGINAL_ENV = { ...process.env };

beforeEach(() => vi.resetModules());
afterEach(() => {
	process.env = { ...ORIGINAL_ENV };
});

describe("with a valid encryption key", () => {
	beforeEach(() => {
		process.env.ALETHIA_CRED_ENCRYPTION_KEY = KEY;
	});

	it("round-trips a secret map", async () => {
		const { encryptSecret, decryptSecret, isCredEncryptionConfigured } = await import(
			"@/lib/crypto/secrets"
		);
		expect(isCredEncryptionConfigured()).toBe(true);

		const fields = { token: "super-secret-123", extra: "value" };
		const env = encryptSecret(fields);
		expect(env.v).toBe(1);
		// The ciphertext must not leak the plaintext.
		expect(env.data).not.toContain("super-secret-123");
		expect(decryptSecret(env)).toEqual(fields);
	});

	it("uses a fresh IV per call (non-deterministic ciphertext)", async () => {
		const { encryptSecret } = await import("@/lib/crypto/secrets");
		const a = encryptSecret({ x: "1" });
		const b = encryptSecret({ x: "1" });
		expect(a.iv).not.toBe(b.iv);
		expect(a.data).not.toBe(b.data);
	});

	it("rejects a tampered envelope (GCM auth tag)", async () => {
		const { encryptSecret, decryptSecret } = await import("@/lib/crypto/secrets");
		const env = encryptSecret({ x: "1" });
		const tampered = { ...env, data: Buffer.from("not-the-ciphertext").toString("base64") };
		expect(() => decryptSecret(tampered)).toThrow();
	});
});

describe("without a usable key (fail closed)", () => {
	it("reports not-configured and refuses to encrypt", async () => {
		delete process.env.ALETHIA_CRED_ENCRYPTION_KEY;
		const { isCredEncryptionConfigured, encryptSecret } = await import(
			"@/lib/crypto/secrets"
		);
		expect(isCredEncryptionConfigured()).toBe(false);
		expect(() => encryptSecret({ x: "1" })).toThrow(/ALETHIA_CRED_ENCRYPTION_KEY/);
	});

	it("rejects a wrong-length key", async () => {
		process.env.ALETHIA_CRED_ENCRYPTION_KEY = Buffer.from("too-short").toString("base64");
		const { isCredEncryptionConfigured } = await import("@/lib/crypto/secrets");
		expect(isCredEncryptionConfigured()).toBe(false);
	});
});

// ── Instance secrets (#6803) ────────────────────────────────────────────────────────────────────
// The manifest is the one list of instance secrets; these tests hold the console's copy of the
// names, generators and placeholder digests equal to it and to deploy/selfhost/secrets.sh.
const REPO = resolve(__dirname, "../../../../..");
const MANIFEST = readFileSync(resolve(REPO, "deploy/selfhost/secrets.manifest"), "utf8");
const SECRETS_SH = readFileSync(resolve(REPO, "deploy/selfhost/secrets.sh"), "utf8");

/** The manifest's `secret` records as [name, generator, consumers]. */
function manifestSecrets(): Array<[string, string, string[]]> {
	return MANIFEST.split("\n")
		.map((line) => line.trim().split(/\s+/))
		.filter((f) => f[0] === "secret")
		.map((f): [string, string, string[]] => [f[1] ?? "", f[2] ?? "", (f[5] ?? "").split(",")]);
}

describe("instance secrets", () => {
	it("checks every manifest secret the console reads, with the manifest's generator", async () => {
		const { CONSOLE_INSTANCE_SECRETS } = await import("@/lib/crypto/secrets");
		// The database passwords reach the console only inside the connection URLs.
		const viaUrl = new Set(["ALETHIA_DB_PASSWORD", "ALETHIA_APP_DB_PASSWORD"]);
		const expected = Object.fromEntries(
			manifestSecrets()
				.filter(([name, , consumers]) => consumers.includes("app") && !viaUrl.has(name))
				.map(([name, generator]) => [name, generator]),
		);
		expect({ ...CONSOLE_INSTANCE_SECRETS }).toEqual(expected);
	});

	it("holds the same placeholder digests as deploy/selfhost/secrets.sh", async () => {
		const { PLACEHOLDER_DIGESTS } = await import("@/lib/crypto/secrets");
		const line = SECRETS_SH.split("\n").find((l) => l.startsWith("PLACEHOLDER_DIGESTS="));
		const shell = (line ?? "").replace(/^PLACEHOLDER_DIGESTS="|"$/g, "").split(/\s+/);
		expect([...PLACEHOLDER_DIGESTS].sort()).toEqual(shell.sort());
		expect(PLACEHOLDER_DIGESTS.size).toBeGreaterThan(0);
	});

	it("recognises a placeholder by marker or by digest, and never an empty or generated value", async () => {
		const { isTemplatePlaceholder } = await import("@/lib/crypto/secrets");
		const sample = "a-template-value";
		const digests = new Set([createHash("sha256").update(sample).digest("hex")]);
		expect(isTemplatePlaceholder(sample, digests)).toBe(true);
		expect(isTemplatePlaceholder("<generate me>")).toBe(true);
		expect(isTemplatePlaceholder("")).toBe(false);
		expect(isTemplatePlaceholder(randomBytes(32).toString("hex"))).toBe(false);
	});

	it.each(Object.keys(CONSOLE_INSTANCE_SECRETS))(
		"refuses a placeholder for %s, naming it and never echoing the value",
		async (name) => {
			const { assertInstanceSecrets } = await import("@/lib/crypto/secrets");
			const value = "<replace with a generated value>";
			let message = "";
			try {
				assertInstanceSecrets({ [name]: value });
			} catch (err) {
				message = err instanceof Error ? err.message : String(err);
			}
			expect(message).toContain(name);
			expect(message).toContain("Generate one with");
			expect(message).not.toContain(value);
		},
	);

	it("accepts generated values and refuses an empty required one", async () => {
		const { assertInstanceSecrets } = await import("@/lib/crypto/secrets");
		const generated = {
			BETTER_AUTH_SECRET: randomBytes(32).toString("hex"),
			ALETHIA_CRED_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
		};
		expect(() => assertInstanceSecrets(generated, ["BETTER_AUTH_SECRET"])).not.toThrow();
		// Unset optional secrets are fine; an unset required one is refused by name.
		expect(() => assertInstanceSecrets({}, [])).not.toThrow();
		expect(() => assertInstanceSecrets({}, ["BETTER_AUTH_SECRET"])).toThrow(
			/BETTER_AUTH_SECRET is not set/,
		);
	});

	it("refuses a placeholder encryption key before using it", async () => {
		process.env.ALETHIA_CRED_ENCRYPTION_KEY = "<base64 of 32 random bytes>";
		const { isCredEncryptionConfigured, encryptSecret } = await import("@/lib/crypto/secrets");
		expect(isCredEncryptionConfigured()).toBe(false);
		expect(() => encryptSecret({ x: "1" })).toThrow(/template placeholder/);
	});
});
