// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// W4: proves add-on secret knobs are encrypted-at-rest — a secret field is stored as an
// EncryptedSecret envelope (never plaintext), round-trips back to its value, and non-secret /
// empty / pre-W4-plaintext values are handled tolerantly. The encryption key is cached at module
// scope, so each run resets modules + re-imports with the env it wants (mirrors the crypto test).

import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const KEY = randomBytes(32).toString("base64");
const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
	vi.resetModules();
	process.env.ALETHIA_CRED_ENCRYPTION_KEY = KEY;
});
afterEach(() => {
	process.env = { ...ORIGINAL_ENV };
});

async function load() {
	const { encryptAddonSecrets, decryptAddonSecrets } = await import(
		"@/lib/addons/secrets"
	);
	const { getAddOn } = await import("@/lib/addons/catalog");
	const externalDns = getAddOn("external-dns");
	const minio = getAddOn("minio");
	if (!externalDns || !minio) throw new Error("expected catalog add-ons missing");
	return { encryptAddonSecrets, decryptAddonSecrets, externalDns, minio };
}

describe("add-on secret encrypt-at-rest", () => {
	it("encrypts a secret field into an envelope (never plaintext) and decrypts it back", async () => {
		const { encryptAddonSecrets, decryptAddonSecrets, externalDns } = await load();

		const stored = encryptAddonSecrets(externalDns, {
			provider: "cloudflare",
			apiToken: "cf-secret-abc",
		});
		// Non-secret field untouched; the token is an EncryptedSecret envelope, not plaintext.
		expect(stored.provider).toBe("cloudflare");
		expect(typeof stored.apiToken).toBe("object");
		expect(JSON.stringify(stored.apiToken)).not.toContain("cf-secret-abc");

		const back = decryptAddonSecrets(externalDns, stored);
		expect(back.apiToken).toBe("cf-secret-abc");
		expect(back.provider).toBe("cloudflare");
	});

	it("drops an empty secret (no blank envelope) and tolerates pre-W4 plaintext on decrypt", async () => {
		const { encryptAddonSecrets, decryptAddonSecrets, externalDns } = await load();

		const stored = encryptAddonSecrets(externalDns, {
			provider: "hetzner",
			apiToken: "",
		});
		expect("apiToken" in stored).toBe(false);

		// A pre-W4 row may hold a plaintext token — decrypt must pass it through, not throw.
		expect(
			decryptAddonSecrets(externalDns, { apiToken: "legacy-plain" }).apiToken,
		).toBe("legacy-plain");
	});

	it("no-ops for an add-on with no secret fields", async () => {
		const { encryptAddonSecrets, minio } = await load();
		const vals = { storageGb: 100, mode: "standalone" };
		// Same reference back — nothing to encrypt.
		expect(encryptAddonSecrets(minio, vals)).toBe(vals);
	});
});
