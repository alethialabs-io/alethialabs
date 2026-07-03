// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
