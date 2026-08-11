// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The PUBLIC half of the platform receipt-signing key (#2331).
//
// Receipts are signed by the runner from `ALETHIA_RECEIPT_SIGNING_KEY`
// (packages/core/verify SigningKeyFromEnv → provisioner/deploy.go attachReceipt), NOT from an
// `org_signing_key` row — customer-KMS custody is registered but not yet the signing path. So a
// verifier handed only the org's recorded keys would fail closed on every receipt that exists
// today. `alethia verify receipt` needs the platform key in its trusted set to bind a real
// receipt's key_id to anything at all, and a public key is not secret material.
//
// This module reads a private key from the environment and MUST only ever surface the public
// half. A 64-byte ed25519 private key is seed(32) || public(32) — bytes 32..64 are exactly the
// public key. The seed is never read, never returned, and never logged; the failure paths return
// null rather than an error carrying any part of the input.

import { createHash } from "node:crypto";

/** The env var holding the base64(std) 64-byte ed25519 receipt-signing key. Mirrors `verify.SigningKeyEnv`. */
const SIGNING_KEY_ENV = "ALETHIA_RECEIPT_SIGNING_KEY";

/** A 64-byte ed25519 private key is seed(32) || public(32) — RFC 8032. */
const ED25519_PRIVATE_KEY_BYTES = 64;
const ED25519_SEED_BYTES = 32;

/** The platform signing key as a verifier may see it — public material only. */
export interface PlatformSigningKeyView {
	keyId: string;
	publicKey: string;
	algorithm: string;
}

/**
 * Derives the public half of the platform receipt-signing key, or null when no key is configured
 * or the configured value is not a 64-byte ed25519 private key. Null is the honest answer for a
 * deployment that signs nothing — its receipts carry `algorithm:"none"` and there is no key to
 * vouch for.
 *
 * `keyId` is `hex(sha256(pub)[:8])`, matching `KeyID()` in packages/core/verify/receipt.go, so it
 * joins directly to a `SignedReceipt.key_id`.
 */
export function platformSigningKey(): PlatformSigningKeyView | null {
	const raw = process.env[SIGNING_KEY_ENV]?.trim();
	if (!raw) return null;

	const keyBytes = Buffer.from(raw, "base64");
	if (keyBytes.length !== ED25519_PRIVATE_KEY_BYTES) return null;

	// Bytes 32..64 only. The seed half is deliberately never bound to a name in this scope.
	const publicKey = keyBytes.subarray(ED25519_SEED_BYTES, ED25519_PRIVATE_KEY_BYTES);
	return {
		keyId: createHash("sha256").update(publicKey).digest("hex").slice(0, 16),
		publicKey: publicKey.toString("base64"),
		algorithm: "ed25519",
	};
}
