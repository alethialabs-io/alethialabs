// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { createHash, createPrivateKey, sign as edSign } from "node:crypto";
import { canonicalReceiptJson } from "@/lib/evidence/receipt-canonical";
import type { SignedReceipt, VerifyReceiptBody } from "@/types/jsonb.types";

/**
 * Signs a demo evidence receipt the same way `packages/core/verify` does — an
 * ed25519 signature over the canonical JSON of the receipt body — so the seeded
 * receipt is a first-class `SignedReceipt` the Evidence surface renders in full.
 *
 * When `ALETHIA_RECEIPT_SIGNING_KEY` is unset it emits `algorithm:"none"` (a
 * legitimate, fully-rendering state). When set, it produces a real signature
 * with a **demo** key — honestly attesting only "the demo runner said so",
 * never customer-anchored trust. The canonical bytes come from
 * `canonicalReceiptJson` (shared with the Rekor anchor), byte-matching Go's
 * `json.Marshal(Receipt)`.
 */

const SIGNING_KEY_ENV = "ALETHIA_RECEIPT_SIGNING_KEY";
// DER PKCS8 prefix for a raw 32-byte ed25519 seed.
const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

/** Wraps a receipt body in a `SignedReceipt`, signing it when a demo key is present. */
export function signReceipt(body: VerifyReceiptBody): SignedReceipt {
	const raw = process.env[SIGNING_KEY_ENV];
	if (!raw) return { receipt: body, algorithm: "none" };

	const keyBytes = Buffer.from(raw, "base64");
	if (keyBytes.length !== 64) {
		// Not a 64-byte ed25519 private key — degrade honestly to unsigned.
		return { receipt: body, algorithm: "none" };
	}
	const seed = keyBytes.subarray(0, 32);
	const publicKey = keyBytes.subarray(32, 64);
	const keyObject = createPrivateKey({
		key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]),
		format: "der",
		type: "pkcs8",
	});
	const message = Buffer.from(canonicalReceiptJson(body), "utf8");
	const signature = edSign(null, message, keyObject).toString("base64");
	const keyId = createHash("sha256").update(publicKey).digest("hex").slice(0, 16);
	return { receipt: body, algorithm: "ed25519", key_id: keyId, signature };
}
