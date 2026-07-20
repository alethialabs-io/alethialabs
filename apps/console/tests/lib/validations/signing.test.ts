// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import {
	decodeEd25519PublicKey,
	keyIdForPublicKey,
	signingKeyRegisterSchema,
} from "@/lib/validations/signing";

// A valid 32-byte ed25519 public key (all zeros) as base64(std).
const ZERO_PUB = Buffer.alloc(32).toString("base64");

describe("decodeEd25519PublicKey", () => {
	it("accepts a canonical 32-byte base64 key", () => {
		expect(decodeEd25519PublicKey(ZERO_PUB)?.length).toBe(32);
	});
	it("rejects the wrong length", () => {
		expect(decodeEd25519PublicKey(Buffer.alloc(31).toString("base64"))).toBeNull();
		expect(decodeEd25519PublicKey(Buffer.alloc(33).toString("base64"))).toBeNull();
	});
	it("rejects non-canonical base64 (no two spellings of one key)", () => {
		// A trailing-bit variant that base64-decodes to the same 32 bytes but isn't canonical.
		expect(decodeEd25519PublicKey(`${ZERO_PUB.slice(0, -1)}B`)).toBeNull();
	});
});

describe("keyIdForPublicKey", () => {
	it("matches the Go verify.KeyID contract: hex(sha256(pub)[:8])", () => {
		// Cross-checked against packages/core/verify KeyID on the same 32 zero bytes.
		expect(keyIdForPublicKey(ZERO_PUB)).toBe("66687aadf862bd77");
	});
	it("is derived server-side (throws on an invalid key rather than trusting input)", () => {
		expect(() => keyIdForPublicKey("not-a-key")).toThrow();
	});
});

describe("signingKeyRegisterSchema", () => {
	const base = { provider: "aws", backend: "kms", key_ref: "arn:aws:kms:...:key/abc", public_key: ZERO_PUB };
	it("accepts a well-formed registration", () => {
		expect(signingKeyRegisterSchema.parse(base)).toMatchObject({ provider: "aws", backend: "kms" });
	});
	it("rejects a bad public key", () => {
		expect(() => signingKeyRegisterSchema.parse({ ...base, public_key: "xxx" })).toThrow();
	});
	it("rejects a key_ref with whitespace", () => {
		expect(() => signingKeyRegisterSchema.parse({ ...base, key_ref: "arn with space" })).toThrow();
	});
	it("rejects an unknown provider / backend", () => {
		expect(() => signingKeyRegisterSchema.parse({ ...base, provider: "ibm" })).toThrow();
		expect(() => signingKeyRegisterSchema.parse({ ...base, backend: "hsm" })).toThrow();
	});
});
