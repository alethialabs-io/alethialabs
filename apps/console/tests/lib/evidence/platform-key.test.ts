// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// platformSigningKey() reads a PRIVATE key from the environment to derive a PUBLIC one. The tests
// that matter here are the ones asserting the seed never escapes: everything else is arithmetic.

import { createHash, generateKeyPairSync } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { platformSigningKey } from "@/lib/evidence/platform-key";

const ENV = "ALETHIA_RECEIPT_SIGNING_KEY";

/** Builds a raw 64-byte ed25519 private key (seed || public), as the env var carries it. */
function rawPrivateKey(): { raw: Buffer; seed: Buffer; publicKey: Buffer } {
	const { privateKey, publicKey } = generateKeyPairSync("ed25519");
	// DER pkcs8 for ed25519 ends with the 32-byte seed; spki ends with the 32-byte public key.
	const seed = privateKey.export({ format: "der", type: "pkcs8" }).subarray(-32);
	const pub = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
	return { raw: Buffer.concat([seed, pub]), seed, publicKey: pub };
}

afterEach(() => {
	delete process.env[ENV];
});

describe("platformSigningKey", () => {
	it("derives the public half and a key_id matching verify.KeyID", () => {
		const { raw, publicKey } = rawPrivateKey();
		process.env[ENV] = raw.toString("base64");

		const got = platformSigningKey();
		expect(got).not.toBeNull();
		expect(got?.publicKey).toBe(publicKey.toString("base64"));
		expect(got?.algorithm).toBe("ed25519");
		// hex(sha256(pub)[:8]) — the same derivation as KeyID() in packages/core/verify/receipt.go,
		// which is what joins a SignedReceipt.key_id back to a key.
		expect(got?.keyId).toBe(
			createHash("sha256").update(publicKey).digest("hex").slice(0, 16),
		);
	});

	// The one that would matter if it ever broke: no part of the private seed may appear in
	// anything this function returns.
	it("never surfaces the private seed", () => {
		const { raw, seed } = rawPrivateKey();
		process.env[ENV] = raw.toString("base64");

		const got = platformSigningKey();
		const emitted = JSON.stringify(got);
		expect(emitted).not.toContain(seed.toString("base64"));
		expect(emitted).not.toContain(seed.toString("hex"));
		expect(emitted).not.toContain(raw.toString("base64"));
	});

	it("returns null when no key is configured", () => {
		expect(platformSigningKey()).toBeNull();
		process.env[ENV] = "   ";
		expect(platformSigningKey()).toBeNull();
	});

	it("returns null for a value that is not a 64-byte ed25519 private key", () => {
		process.env[ENV] = Buffer.from("too short").toString("base64");
		expect(platformSigningKey()).toBeNull();

		// A 32-byte value is a PUBLIC key, not a private one — refuse it rather than treat the
		// tail 32 bytes of something else as a public key.
		process.env[ENV] = Buffer.alloc(32, 7).toString("base64");
		expect(platformSigningKey()).toBeNull();
	});
});
