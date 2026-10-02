// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The browser's HPKE open (#5285) against BOTH vectors the Go seal publishes
// (packages/core/kubeaccess/testdata/seal_vectors.json). This is the proof the browser and the runner
// agree: the CFRG vector pins every intermediate of RFC 9180 for this exact suite, and the Alethia
// vector is a blob Go's own `Seal` produced under the mint construction (info + AAD binding).

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
	SEAL_INFO,
	SealOpenError,
	aeadOpen,
	decap,
	fromBase64Url,
	generateRecipientKey,
	keySchedule,
	mintAad,
	openSealed,
	openWith,
	toBase64Url,
	type RecipientKey,
} from "@/components/clusters/kubeconfig-download/hpke";

const hex = z.string().regex(/^[0-9a-f]*$/);
const vectorsSchema = z.object({
	rfc9180: z.object({
		mode: z.literal(0),
		kem_id: z.literal(32),
		kdf_id: z.literal(1),
		aead_id: z.literal(2),
		info: hex,
		skRm: hex,
		pkRm: hex,
		enc: hex,
		shared_secret: hex,
		key_schedule_context: hex,
		secret: hex,
		key: hex,
		base_nonce: hex,
		encryptions: z.array(z.object({ aad: hex, ct: hex, nonce: hex, pt: hex })).min(2),
	}),
	alethia_mint: z.object({
		info: z.string(),
		recipient_sk_hex: hex,
		recipient_pk_b64url: z.string(),
		mint_id: z.string(),
		cluster_id: z.string(),
		aad_hex: hex,
		sealed_b64url: z.string(),
		plaintext: z.string(),
	}),
});

const VECTORS = vectorsSchema.parse(
	JSON.parse(
		readFileSync(
			path.resolve(__dirname, "../../../../../../packages/core/kubeaccess/testdata/seal_vectors.json"),
			"utf8",
		),
	),
);

/** Hex → bytes. */
function h(s: string): Uint8Array {
	return Uint8Array.from(s.match(/../g) ?? [], (b) => Number.parseInt(b, 16));
}

/** Bytes → hex. */
function toHex(b: Uint8Array): string {
	return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

/** Imports a raw X25519 private scalar the way a test can (JWK); production keys are generated. */
async function recipientFrom(sk: Uint8Array, pk: Uint8Array): Promise<RecipientKey> {
	const privateKey = await crypto.subtle.importKey(
		"jwk",
		{ kty: "OKP", crv: "X25519", d: toBase64Url(sk), x: toBase64Url(pk) },
		{ name: "X25519" },
		false,
		["deriveBits"],
	);
	return { privateKey, publicKey: pk };
}

describe("RFC 9180 vector — DHKEM(X25519, HKDF-SHA256) / HKDF-SHA256 / AES-256-GCM, base mode", () => {
	const v = VECTORS.rfc9180;

	it("reproduces the KEM shared secret", async () => {
		const r = await recipientFrom(h(v.skRm), h(v.pkRm));
		expect(toHex(await decap(h(v.enc), r))).toBe(v.shared_secret);
	});

	it("reproduces the key schedule context, secret, key and base nonce", async () => {
		const ks = await keySchedule(h(v.shared_secret), h(v.info));
		expect(toHex(ks.keyScheduleContext)).toBe(v.key_schedule_context);
		expect(toHex(ks.secret)).toBe(v.secret);
		expect(toHex(ks.key)).toBe(v.key);
		expect(toHex(ks.baseNonce)).toBe(v.base_nonce);
	});

	it("opens both published encryptions, at sequence 0 and 1", async () => {
		const ks = await keySchedule(h(v.shared_secret), h(v.info));
		for (const [seq, e] of v.encryptions.entries()) {
			expect(toHex(await aeadOpen(ks, seq, h(e.aad), h(e.ct)))).toBe(e.pt);
		}
	});

	it("opens the first encryption end to end through the single-shot path the mint uses", async () => {
		const r = await recipientFrom(h(v.skRm), h(v.pkRm));
		const e = v.encryptions[0];
		const blob = new Uint8Array([...h(v.enc), ...h(e.ct)]);
		expect(toHex(await openWith(r, h(v.info), h(e.aad), blob))).toBe(e.pt);
	});
});

describe("Alethia mint vector — a blob Go's kubeaccess.Seal produced", () => {
	const v = VECTORS.alethia_mint;
	const sk = h(v.recipient_sk_hex);
	const pk = fromBase64Url(v.recipient_pk_b64url);

	it("builds the same info and AAD bytes as kubeaccess.MintAAD", () => {
		expect(SEAL_INFO).toBe(v.info);
		expect(toHex(mintAad(v.mint_id, v.cluster_id))).toBe(v.aad_hex);
	});

	it("opens to the exact plaintext with the right key, mint and cluster", async () => {
		const r = await recipientFrom(sk, pk);
		const pt = await openSealed(r, v.sealed_b64url, v.mint_id, v.cluster_id);
		expect(new TextDecoder().decode(pt)).toBe(v.plaintext);
	});

	it("refuses to open under another mint id, another cluster id, or a flipped byte", async () => {
		const r = await recipientFrom(sk, pk);
		const otherId = "00000000-0000-4000-8000-000000000000";
		await expect(openSealed(r, v.sealed_b64url, otherId, v.cluster_id)).rejects.toBeInstanceOf(SealOpenError);
		await expect(openSealed(r, v.sealed_b64url, v.mint_id, otherId)).rejects.toBeInstanceOf(SealOpenError);
		const blob = fromBase64Url(v.sealed_b64url);
		blob[blob.length - 1] ^= 0x01;
		await expect(openSealed(r, toBase64Url(blob), v.mint_id, v.cluster_id)).rejects.toBeInstanceOf(SealOpenError);
	});

	it("refuses a key that is not the recipient's", async () => {
		const stranger = await generateRecipientKey();
		await expect(openSealed(stranger, v.sealed_b64url, v.mint_id, v.cluster_id)).rejects.toBeInstanceOf(
			SealOpenError,
		);
	});

	it("refuses a non-canonical id spelling rather than computing different AAD bytes", () => {
		expect(() => mintAad(v.mint_id.toUpperCase(), v.cluster_id)).toThrow(SealOpenError);
	});

	it("refuses padded base64 and a blob shorter than enc + tag", async () => {
		const r = await recipientFrom(sk, pk);
		await expect(openSealed(r, `${v.sealed_b64url}=`, v.mint_id, v.cluster_id)).rejects.toBeInstanceOf(
			SealOpenError,
		);
		await expect(openSealed(r, toBase64Url(new Uint8Array(47)), v.mint_id, v.cluster_id)).rejects.toBeInstanceOf(
			SealOpenError,
		);
	});

	it("refuses a low-order (all-zero) enc instead of deriving from it", async () => {
		const r = await recipientFrom(sk, pk);
		const blob = fromBase64Url(v.sealed_b64url);
		blob.fill(0, 0, 32);
		await expect(openSealed(r, toBase64Url(blob), v.mint_id, v.cluster_id)).rejects.toBeInstanceOf(SealOpenError);
	});
});

describe("the ephemeral client key", () => {
	it("is generated non-extractable, with a 43-char wire public key", async () => {
		const k = await generateRecipientKey();
		expect(k.privateKey.extractable).toBe(false);
		await expect(crypto.subtle.exportKey("jwk", k.privateKey)).rejects.toThrow();
		expect(toBase64Url(k.publicKey)).toMatch(/^[A-Za-z0-9_-]{43}$/);
	});
});
