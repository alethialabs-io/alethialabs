// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Validation for registering a customer-controlled receipt-signing key (#884). The console only
// SHAPE-validates here — it never touches the private key (Alethia stores a reference + the public
// key only). Real control of `key_ref` is proven later by the runner proof-of-possession job (D5),
// which flips the row active; until then a registered key is `pending_verification`.

import { createHash } from "node:crypto";
import { z } from "zod";
import { cloudProvider, signingBackend } from "@/lib/db/schema/enums";

/** ed25519 public keys are exactly 32 bytes (RFC 8032). */
const ED25519_PUBLIC_KEY_BYTES = 32;

/**
 * Decodes a base64(std) ed25519 public key, returning its bytes only when it is canonical base64
 * AND exactly 32 bytes; null otherwise. The round-trip check rejects non-canonical encodings so a
 * key can't have two spellings (which would fork its key_id).
 */
export function decodeEd25519PublicKey(b64: string): Buffer | null {
	const buf = Buffer.from(b64, "base64");
	if (buf.length !== ED25519_PUBLIC_KEY_BYTES) return null;
	if (buf.toString("base64") !== b64) return null;
	return buf;
}

/**
 * The stable key id for a public key: `hex(sha256(pub)[:8])`. This MUST match
 * `KeyID()` in packages/core/verify/receipt.go so a SignedReceipt's `key_id` joins back to the
 * `org_signing_key` row that recorded the public key. Computed server-side from the public key —
 * never accepted from the client.
 */
export function keyIdForPublicKey(publicKeyB64: string): string {
	const pub = decodeEd25519PublicKey(publicKeyB64);
	if (!pub) throw new Error("invalid ed25519 public key");
	return createHash("sha256").update(pub).digest("hex").slice(0, 16);
}

/**
 * Input to register an org signing key. `key_ref` is a REFERENCE to a key held in the customer's
 * cloud (a KMS key resource id, or a secret store ARN/URI) — never the key itself. Shape-only:
 * non-empty, single-line, bounded. The runner's proof-of-possession job resolves + tests it for real.
 */
export const signingKeyRegisterSchema = z.object({
	provider: z.enum(cloudProvider.enumValues),
	backend: z.enum(signingBackend.enumValues),
	key_ref: z
		.string()
		.trim()
		.min(1, "key reference is required")
		.max(512)
		.refine((v) => !/\s/.test(v), "key reference must not contain whitespace"),
	public_key: z
		.string()
		.refine(
			(v) => decodeEd25519PublicKey(v) !== null,
			"must be a base64(std) ed25519 public key (32 bytes)",
		),
});

export type SigningKeyRegisterInput = z.infer<typeof signingKeyRegisterSchema>;
