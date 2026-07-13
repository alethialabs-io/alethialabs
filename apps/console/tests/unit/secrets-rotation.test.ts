// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Key-rotation unit tests for lib/crypto/secrets.ts (the keyring + kid envelope) and the pure
// re-encrypt transforms (scripts/reencrypt-secrets.ts). We craft envelopes directly with node:crypto
// so we don't depend on the module's own writer for the legacy/retired fixtures. Env vars are set
// once here (active key kid "2", retired key kid "1") and the keyring cache is reset before use.

import { createCipheriv, randomBytes } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import type { EncryptedSecret } from "@/types/jsonb.types";

// Deterministic 32-byte keys (values irrelevant, just distinct + correct length).
const ACTIVE_KEY = Buffer.alloc(32, 0x11);
const RETIRED_KEY = Buffer.alloc(32, 0x22);
const ACTIVE_KID = "2";
const RETIRED_KID = "1";

// Set the keyring env BEFORE importing the module under test (getKeyring reads process.env lazily,
// but set-first + cache-reset keeps this robust regardless of import order).
process.env.ALETHIA_CRED_ENCRYPTION_KEY = ACTIVE_KEY.toString("base64");
process.env.ALETHIA_CRED_ENCRYPTION_KID = ACTIVE_KID;
process.env[`ALETHIA_CRED_ENCRYPTION_KEY_${RETIRED_KID}`] = RETIRED_KEY.toString("base64");

import {
	decryptSecret,
	encryptSecret,
	getActiveKid,
	isCredEncryptionConfigured,
	reencryptSecret,
	resetKeyringCache,
} from "@/lib/crypto/secrets";
import {
	reencryptCloudCredentials,
	reencryptConnectorCredentials,
	reencryptSealedString,
} from "@/scripts/reencrypt-secrets";

/** Seals fields under an explicit key, optionally stamping a kid — mimics writers past & present. */
function seal(
	key: Buffer,
	fields: Record<string, string>,
	kid?: string,
): EncryptedSecret {
	const iv = randomBytes(12);
	const cipher = createCipheriv("aes-256-gcm", key, iv);
	const data = Buffer.concat([
		cipher.update(Buffer.from(JSON.stringify(fields), "utf8")),
		cipher.final(),
	]);
	const tag = cipher.getAuthTag();
	const env: EncryptedSecret = {
		v: 1,
		iv: iv.toString("base64"),
		tag: tag.toString("base64"),
		data: data.toString("base64"),
	};
	if (kid !== undefined) env.kid = kid;
	return env;
}

beforeAll(() => {
	resetKeyringCache();
});

describe("keyring + kid envelope", () => {
	it("reports configured and exposes the active kid", () => {
		expect(isCredEncryptionConfigured()).toBe(true);
		expect(getActiveKid()).toBe(ACTIVE_KID);
	});

	// (a) legacy no-kid ciphertext (old single-key path) still decrypts under the active key.
	it("decrypts a LEGACY envelope with no kid under the active key", () => {
		const legacy = seal(ACTIVE_KEY, { api_token: "legacy-secret" });
		expect(legacy.kid).toBeUndefined();
		expect(decryptSecret(legacy)).toEqual({ api_token: "legacy-secret" });
	});

	// (b) encrypt → decrypt round-trips, and new writes carry the active kid.
	it("round-trips encrypt/decrypt and stamps the active kid on writes", () => {
		const env = encryptSecret({ token: "hunter2", extra: "x" });
		expect(env.kid).toBe(ACTIVE_KID);
		expect(decryptSecret(env)).toEqual({ token: "hunter2", extra: "x" });
	});

	// (c) a ciphertext bearing a RETIRED kid decrypts while new writes still use the active kid.
	it("decrypts a retired-kid ciphertext from the ring while writing new active-kid ciphertext", () => {
		const retired = seal(RETIRED_KEY, { api_token: "old-key-secret" }, RETIRED_KID);
		expect(retired.kid).toBe(RETIRED_KID);
		expect(decryptSecret(retired)).toEqual({ api_token: "old-key-secret" });
		// New writes are unaffected — still the active kid.
		expect(encryptSecret({ a: "b" }).kid).toBe(ACTIVE_KID);
	});

	// (d) a kid not present in the ring is a clear, actionable error (not a silent {}).
	it("throws a clear error when the envelope kid is not in the keyring", () => {
		const orphan = seal(RETIRED_KEY, { api_token: "x" }, "999");
		expect(() => decryptSecret(orphan)).toThrow(/kid "999"/);
	});

	// (e) tamper (flipped ciphertext byte) fails the auth tag and throws.
	it("throws on tamper", () => {
		const env = encryptSecret({ token: "x" });
		const raw = Buffer.from(env.data, "base64");
		raw[0] ^= 0xff;
		const tampered: EncryptedSecret = { ...env, data: raw.toString("base64") };
		expect(() => decryptSecret(tampered)).toThrow();
	});
});

describe("reencryptSecret (idempotent)", () => {
	it("re-stamps a retired-kid ciphertext to the active kid and preserves plaintext", () => {
		const retired = seal(RETIRED_KEY, { api_token: "old" }, RETIRED_KID);
		const { envelope, changed } = reencryptSecret(retired);
		expect(changed).toBe(true);
		expect(envelope.kid).toBe(ACTIVE_KID);
		expect(decryptSecret(envelope)).toEqual({ api_token: "old" });
	});

	it("stamps a legacy no-kid ciphertext on the first pass", () => {
		const legacy = seal(ACTIVE_KEY, { api_token: "legacy" });
		const { envelope, changed } = reencryptSecret(legacy);
		expect(changed).toBe(true);
		expect(envelope.kid).toBe(ACTIVE_KID);
	});

	it("is a no-op for a ciphertext already at the active kid", () => {
		const current = encryptSecret({ token: "x" });
		const { envelope, changed } = reencryptSecret(current);
		expect(changed).toBe(false);
		expect(envelope).toBe(current);
	});
});

describe("re-encrypt transforms over in-memory rows", () => {
	it("reencryptConnectorCredentials rewrites .secret under the active kid", () => {
		const creds = {
			fields: { username: "bob" },
			secret: seal(RETIRED_KEY, { pat: "ghp_x" }, RETIRED_KID),
		};
		const { value, changed } = reencryptConnectorCredentials(creds);
		expect(changed).toBe(true);
		expect(value.secret?.kid).toBe(ACTIVE_KID);
		expect(value.fields).toEqual({ username: "bob" });
		// Second pass is idempotent.
		expect(reencryptConnectorCredentials(value).changed).toBe(false);
	});

	it("reencryptConnectorCredentials is a no-op when there is no secret", () => {
		const { changed } = reencryptConnectorCredentials({ fields: { a: "b" } });
		expect(changed).toBe(false);
	});

	it("reencryptCloudCredentials rewrites token + S3 keys, leaving plaintext fields intact", () => {
		const creds = {
			role_arn: "arn:aws:iam::1:role/x",
			token: seal(RETIRED_KEY, { api_token: "t" }, RETIRED_KID),
			s3_access_key: seal(RETIRED_KEY, { access_key: "ak" }, RETIRED_KID),
			s3_secret_key: null,
		};
		const { value, changed } = reencryptCloudCredentials(creds);
		expect(changed).toBe(true);
		expect(value.token?.kid).toBe(ACTIVE_KID);
		expect(value.s3_access_key?.kid).toBe(ACTIVE_KID);
		expect(value.s3_secret_key).toBeNull();
		expect(value.role_arn).toBe("arn:aws:iam::1:role/x");
		expect(reencryptCloudCredentials(value).changed).toBe(false);
	});

	it("reencryptSealedString re-stamps a sealed inventory blob and round-trips", () => {
		const sealed = JSON.stringify(seal(RETIRED_KEY, { cidr: "10.0.0.0/16" }, RETIRED_KID));
		const { value, changed } = reencryptSealedString(sealed);
		expect(changed).toBe(true);
		const parsed: EncryptedSecret = JSON.parse(value ?? "");
		expect(parsed.kid).toBe(ACTIVE_KID);
		expect(decryptSecret(parsed)).toEqual({ cidr: "10.0.0.0/16" });
		expect(reencryptSealedString(value).changed).toBe(false);
	});

	it("reencryptSealedString passes null through", () => {
		expect(reencryptSealedString(null).changed).toBe(false);
	});
});
