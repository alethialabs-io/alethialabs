// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// App-level encryption for api_key integration secrets (Cloudflare token, Vault
// token, Docker Hub PAT, …) stored in connector_credentials. Cloud identities and
// git tokens hold non-secret material (role ARNs, WIF config) and stay plaintext;
// these are real secrets, so we AEAD them at rest. Self-hosted has no guaranteed
// KMS, so this uses AES-256-GCM with a key supplied via ALETHIA_CRED_ENCRYPTION_KEY
// (32-byte base64). Decryption happens only in the claim endpoint, never client-side.

import {
	createCipheriv,
	createDecipheriv,
	randomBytes,
} from "node:crypto";
import type { EncryptedSecret } from "@/types/database-custom.types";

const ALGO = "aes-256-gcm";
const KEY_BYTES = 32;
const IV_BYTES = 12;
const VERSION = 1;

let cachedKey: Buffer | null = null;

/**
 * Resolves the 32-byte encryption key from ALETHIA_CRED_ENCRYPTION_KEY (base64),
 * caching it. Throws a clear error if missing or the wrong length — fail closed
 * rather than store secrets unprotected.
 */
function getKey(): Buffer {
	if (cachedKey) return cachedKey;
	const raw = process.env.ALETHIA_CRED_ENCRYPTION_KEY;
	if (!raw) {
		throw new Error(
			"ALETHIA_CRED_ENCRYPTION_KEY is not set — required to store integration credentials. " +
				"Generate one with: openssl rand -base64 32",
		);
	}
	const key = Buffer.from(raw, "base64");
	if (key.length !== KEY_BYTES) {
		throw new Error(
			`ALETHIA_CRED_ENCRYPTION_KEY must decode to ${KEY_BYTES} bytes (got ${key.length}). ` +
				"Generate one with: openssl rand -base64 32",
		);
	}
	cachedKey = key;
	return key;
}

/** Whether encryption is configured (a valid key is present). */
export function isCredEncryptionConfigured(): boolean {
	try {
		getKey();
		return true;
	} catch {
		return false;
	}
}

/** Encrypts a map of secret fields into a versioned AES-256-GCM envelope. */
export function encryptSecret(
	fields: Record<string, string>,
): EncryptedSecret {
	const iv = randomBytes(IV_BYTES);
	const cipher = createCipheriv(ALGO, getKey(), iv);
	const plaintext = Buffer.from(JSON.stringify(fields), "utf8");
	const data = Buffer.concat([cipher.update(plaintext), cipher.final()]);
	const tag = cipher.getAuthTag();
	return {
		v: VERSION,
		iv: iv.toString("base64"),
		tag: tag.toString("base64"),
		data: data.toString("base64"),
	};
}

/** Decrypts an envelope back into the map of secret fields. Throws on tamper. */
export function decryptSecret(
	envelope: EncryptedSecret,
): Record<string, string> {
	const decipher = createDecipheriv(
		ALGO,
		getKey(),
		Buffer.from(envelope.iv, "base64"),
	);
	decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
	const plaintext = Buffer.concat([
		decipher.update(Buffer.from(envelope.data, "base64")),
		decipher.final(),
	]);
	return JSON.parse(plaintext.toString("utf8")) as Record<string, string>;
}
