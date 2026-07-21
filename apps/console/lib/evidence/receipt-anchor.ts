// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import {
	createHash,
	createPrivateKey,
	createPublicKey,
	type KeyObject,
	sign as ecSign,
	verify as ecVerify,
} from "node:crypto";
import { z } from "zod";
import { canonicalReceiptJson } from "@/lib/evidence/receipt-canonical";
import type { RekorAnchor, SignedReceipt } from "@/types/jsonb.types";

// Console-side Rekor transparency-log anchoring (#885). The runner produces + ed25519-signs an
// evidence receipt; AFTER it lands (authenticated) the console anchors it here — submission and
// any private-log credentials stay out of the untrusted runner sandbox.
//
// The receipt is logged as a `hashedrekord` (hash-only — the body, which references customer
// plan data, is never uploaded). The logged signature is a dedicated platform ECDSA-P256
// "anchor signature" over sha256(canonical receipt), SEPARATE from the ed25519 receipt
// signature (PureEd25519 is rejected by hashedrekord; see packages/core/verify/rekor.go). This
// mirrors the Go `verify.VerifyAnchor` verifier byte-for-byte so a stored anchor round-trips.

const ANCHOR_ALGORITHM = "ecdsa-p256-sha256";
const DEFAULT_REKOR_URL = "https://rekor.sigstore.dev";
const SUBMIT_TIMEOUT_MS = 5000;

/** Resolved anchoring config from the environment. `null` when anchoring is off/misconfigured. */
interface RekorConfig {
	rekorUrl: string;
	anchorPrivateKey: KeyObject;
	/** base64(std) of the SPKI-PEM ECDSA-P256 public key, exactly as logged + stored. */
	anchorPublicKeyB64Pem: string;
	/** the pinned Rekor log public key (for offline SET verification); null when not pinned. */
	logPublicKey: KeyObject | null;
}

/**
 * Reads the opt-in Rekor anchoring config. Anchoring runs only when
 * `ALETHIA_REKOR_ANCHOR_ENABLED=true` and a valid ECDSA-P256 anchor key
 * (`ALETHIA_RECEIPT_ANCHOR_KEY`, PEM) is present. The log instance defaults to the public good
 * server (`ALETHIA_REKOR_URL`); the log's public key (`ALETHIA_REKOR_LOG_PUBLIC_KEY`, PEM) is
 * pinned by the deployer from the Sigstore TUF trust root so a wrong/rotated key can never be
 * silently trusted. Returns `null` (→ no anchoring, honestly) on any misconfiguration.
 */
export function rekorConfig(): RekorConfig | null {
	if (process.env.ALETHIA_REKOR_ANCHOR_ENABLED !== "true") return null;
	const rawKey = process.env.ALETHIA_RECEIPT_ANCHOR_KEY?.trim();
	if (!rawKey) return null;
	try {
		const anchorPrivateKey = createPrivateKey(asPem(rawKey));
		if (anchorPrivateKey.asymmetricKeyDetails?.namedCurve !== "prime256v1") {
			// Only ECDSA-P256 is accepted by hashedrekord for a hash-only entry.
			return null;
		}
		const pubPem = createPublicKey(anchorPrivateKey).export({ type: "spki", format: "pem" }).toString();
		const anchorPublicKeyB64Pem = Buffer.from(pubPem, "utf8").toString("base64");
		const logRaw = process.env.ALETHIA_REKOR_LOG_PUBLIC_KEY?.trim();
		const logPublicKey = logRaw ? createPublicKey(asPem(logRaw)) : null;
		const rekorUrl = (process.env.ALETHIA_REKOR_URL?.trim() || DEFAULT_REKOR_URL).replace(/\/+$/, "");
		return { rekorUrl, anchorPrivateKey, anchorPublicKeyB64Pem, logPublicKey };
	} catch {
		return null;
	}
}

/**
 * Accepts a key as either raw PEM (dev convenience) or one-line base64(PEM) (the production
 * form — .env / vault values can't carry newlines), matching the OIDC-key convention.
 */
function asPem(raw: string): string {
	return raw.includes("-----BEGIN") ? raw : Buffer.from(raw, "base64").toString("utf8");
}

/** The sha256 of a receipt's canonical bytes — what the anchor signs + what the log records. */
export function anchorDigest(receipt: SignedReceipt): Buffer {
	return createHash("sha256").update(canonicalReceiptJson(receipt.receipt), "utf8").digest();
}

/** The minimal Rekor v1 `LogEntry` shape we consume from a create-entry response (zod-validated
 * because it is untrusted external input). */
const rekorLogEntrySchema = z.object({
	logID: z.string(),
	logIndex: z.number(),
	body: z.string(),
	integratedTime: z.number().optional(),
	verification: z
		.object({
			signedEntryTimestamp: z.string().optional(),
			inclusionProof: z
				.object({
					logIndex: z.number(),
					rootHash: z.string(),
					treeSize: z.number(),
					hashes: z.array(z.string()),
					checkpoint: z.string().optional(),
				})
				.optional(),
		})
		.optional(),
});
type RekorLogEntry = z.infer<typeof rekorLogEntrySchema>;

/** The subset of a logged `hashedrekord` entry body we bind against (untrusted → zod-validated). */
const hashedRekordBodySchema = z.object({
	kind: z.string().optional(),
	spec: z
		.object({
			data: z
				.object({ hash: z.object({ algorithm: z.string(), value: z.string() }).partial().optional() })
				.partial()
				.optional(),
			signature: z
				.object({
					content: z.string().optional(),
					publicKey: z.object({ content: z.string().optional() }).partial().optional(),
				})
				.partial()
				.optional(),
		})
		.partial()
		.optional(),
});

/**
 * Anchors a signed receipt in Rekor and returns a fully-assembled, offline-verified
 * `RekorAnchor` — or `null` if anchoring is disabled, misconfigured, or the log was unreachable.
 * FAIL-OPEN by contract: anchoring is additive evidence and must NEVER throw into the caller or
 * block an apply. When a log public key is pinned, the returned proof is verified before being
 * trusted; a proof that fails verification is discarded (returns `null`).
 */
export async function anchorReceipt(receipt: SignedReceipt): Promise<RekorAnchor | null> {
	const cfg = rekorConfig();
	if (!cfg) return null;
	// Only anchor receipts that carry a real signature — an unsigned receipt has nothing to attest.
	if (receipt.algorithm === "none" || !receipt.signature) return null;

	try {
		const canonical = canonicalReceiptJson(receipt.receipt);
		const digest = createHash("sha256").update(canonical, "utf8").digest();
		const anchorSig = ecSign("sha256", Buffer.from(canonical, "utf8"), cfg.anchorPrivateKey);
		const anchorSigB64 = anchorSig.toString("base64");

		const entry = await submitHashedRekord(
			cfg.rekorUrl,
			digest.toString("hex"),
			anchorSigB64,
			cfg.anchorPublicKeyB64Pem,
		);

		const anchor: RekorAnchor = {
			log_url: cfg.rekorUrl,
			log_id: entry.logID,
			log_index: entry.logIndex,
			integrated_time: entry.integratedTime,
			body: entry.body,
			inclusion_proof: {
				log_index: entry.verification?.inclusionProof?.logIndex ?? entry.logIndex,
				root_hash: entry.verification?.inclusionProof?.rootHash ?? "",
				tree_size: entry.verification?.inclusionProof?.treeSize ?? 0,
				hashes: entry.verification?.inclusionProof?.hashes ?? [],
				checkpoint: entry.verification?.inclusionProof?.checkpoint,
			},
			signed_entry_timestamp: entry.verification?.signedEntryTimestamp,
			anchor_algorithm: ANCHOR_ALGORITHM,
			anchor_signature: anchorSigB64,
			anchor_public_key: cfg.anchorPublicKeyB64Pem,
		};

		// Never store a proof we can't stand behind. Both paths verify the receipt→entry binding
		// and the Merkle inclusion; with a pinned log key we additionally verify the log's signed
		// inclusion promise (the SET) — the full offline check.
		if (cfg.logPublicKey) {
			verifyAnchorOffline(receipt, anchor, cfg.logPublicKey);
		} else {
			verifyAnchorBinding(receipt, anchor);
		}
		return anchor;
	} catch (err) {
		console.error("[rekor] anchoring failed (fail-open, receipt stays unanchored):", err);
		return null;
	}
}

/** Submits a `hashedrekord` entry to Rekor v1 and returns the created `LogEntry`. */
async function submitHashedRekord(
	rekorUrl: string,
	digestHex: string,
	signatureB64: string,
	publicKeyB64: string,
): Promise<RekorLogEntry> {
	const proposed = {
		kind: "hashedrekord",
		apiVersion: "0.0.1",
		spec: {
			data: { hash: { algorithm: "sha256", value: digestHex } },
			signature: { content: signatureB64, publicKey: { content: publicKeyB64 } },
		},
	};
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), SUBMIT_TIMEOUT_MS);
	try {
		const res = await fetch(`${rekorUrl}/api/v1/log/entries`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Accept: "application/json" },
			body: JSON.stringify(proposed),
			signal: controller.signal,
		});
		if (!res.ok) {
			throw new Error(`rekor create-entry ${res.status}: ${(await res.text()).slice(0, 200)}`);
		}
		// The response is a map keyed by entry UUID → LogEntry.
		const map = z.record(z.string(), rekorLogEntrySchema).parse(await res.json());
		const entry = Object.values(map)[0];
		if (!entry) {
			throw new Error("rekor response contained no log entry");
		}
		return entry;
	} finally {
		clearTimeout(timeout);
	}
}

// ── Offline verification (the TS mirror of Go `verify.VerifyAnchor`) ─────────────────────────

/** Thrown when an anchor fails offline verification. */
export class AnchorVerificationError extends Error {}

/**
 * Verifies everything about an anchor that needs NO log key: the anchor signature binds to this
 * receipt, the LOGGED entry binds to that signature + digest, and the RFC 6962 Merkle audit path
 * resolves to the proof's own root (plus checkpoint self-consistency). This gates storage even
 * before a log key is pinned — a bogus proof is never persisted. The one thing it cannot check
 * without the log key is the log's SIGNATURE over that root (the SET); `verifyAnchorOffline`
 * adds that. Throws on any mismatch.
 */
export function verifyAnchorBinding(receipt: SignedReceipt, anchor: RekorAnchor): void {
	const canonical = canonicalReceiptJson(receipt.receipt);
	const digest = createHash("sha256").update(canonical, "utf8").digest();

	// 1. Anchor signature binds to THIS receipt.
	const anchorPub = decodePublicKeyB64Pem(anchor.anchor_public_key);
	const anchorSig = Buffer.from(anchor.anchor_signature, "base64");
	if (!ecVerify("sha256", Buffer.from(canonical, "utf8"), anchorPub, anchorSig)) {
		throw new AnchorVerificationError("anchor signature does not verify over the receipt digest");
	}

	// 2. The logged hashedrekord entry binds to that signature + digest.
	const body = hashedRekordBodySchema.parse(
		JSON.parse(Buffer.from(anchor.body, "base64").toString("utf8")),
	);
	if (body.kind !== "hashedrekord") {
		throw new AnchorVerificationError(`unexpected rekor entry kind ${String(body.kind)}`);
	}
	if (
		body.spec?.data?.hash?.algorithm !== "sha256" ||
		body.spec?.data?.hash?.value !== digest.toString("hex")
	) {
		throw new AnchorVerificationError("logged entry hash does not match the receipt digest");
	}
	if (body.spec?.signature?.content !== anchor.anchor_signature) {
		throw new AnchorVerificationError("logged entry signature does not match the anchor signature");
	}
	if (body.spec?.signature?.publicKey?.content !== anchor.anchor_public_key) {
		throw new AnchorVerificationError("logged entry public key does not match the anchor public key");
	}

	// 3. RFC 6962 inclusion: leaf = sha256(0x00 || body) resolves through the audit path to root.
	const bodyBytes = Buffer.from(anchor.body, "base64");
	const leaf = rfc6962LeafHash(bodyBytes);
	const root = Buffer.from(anchor.inclusion_proof.root_hash, "hex");
	verifyInclusion(
		anchor.inclusion_proof.log_index,
		anchor.inclusion_proof.tree_size,
		leaf,
		anchor.inclusion_proof.hashes,
		root,
	);

	// 4. Checkpoint self-consistency (the full note-signature + cross-checkpoint consistency is
	//    the monitor/witness follow-on): its tree head must agree with the verified inclusion proof.
	if (anchor.inclusion_proof.checkpoint) {
		const { treeSize, rootHash } = parseCheckpoint(anchor.inclusion_proof.checkpoint);
		if (treeSize !== anchor.inclusion_proof.tree_size || !rootHash.equals(root)) {
			throw new AnchorVerificationError("checkpoint tree head does not match the inclusion proof");
		}
	}
}

/**
 * Fully verifies a Rekor anchor offline against a pinned log public key — the faithful mirror of
 * Go `verify.VerifyAnchor`: everything in `verifyAnchorBinding` PLUS the log's signed inclusion
 * promise (the SET). Throws on any failure (fail-closed). `logKey` is required — pass the
 * deployer-pinned Rekor log key.
 */
export function verifyAnchorOffline(
	receipt: SignedReceipt,
	anchor: RekorAnchor,
	logKey: KeyObject,
): void {
	verifyAnchorBinding(receipt, anchor);

	// The log's signed promise of inclusion (SET): log-key ECDSA over the canonical
	// {body, integratedTime, logID, logIndex}.
	if (!anchor.signed_entry_timestamp) {
		throw new AnchorVerificationError("anchor has no signed entry timestamp to verify");
	}
	const setBytes = canonicalSET(
		anchor.body,
		anchor.integrated_time ?? 0,
		anchor.log_id,
		anchor.log_index,
	);
	const setSig = Buffer.from(anchor.signed_entry_timestamp, "base64");
	if (!ecVerify("sha256", setBytes, logKey, setSig)) {
		throw new AnchorVerificationError("signed entry timestamp does not verify under the log key");
	}
}

/** Canonical SET bytes — must byte-match Go `verify.canonicalSET`. */
function canonicalSET(body: string, integratedTime: number, logID: string, logIndex: number): Buffer {
	return Buffer.from(
		`{"body":${JSON.stringify(body)},"integratedTime":${integratedTime},"logID":${JSON.stringify(logID)},"logIndex":${logIndex}}`,
		"utf8",
	);
}

function rfc6962LeafHash(leaf: Buffer): Buffer {
	return createHash("sha256").update(Buffer.concat([Buffer.from([0x00]), leaf])).digest();
}

function rfc6962NodeHash(left: Buffer, right: Buffer): Buffer {
	return createHash("sha256").update(Buffer.concat([Buffer.from([0x01]), left, right])).digest();
}

/**
 * Verifies an RFC 6962 inclusion proof (the transparency-dev/merkle chaining), 64-bit-safe via
 * BigInt so a large log index never overflows JS's 32-bit bitwise ops. Throws on any mismatch.
 */
function verifyInclusion(
	index: number,
	treeSize: number,
	leafHash: Buffer,
	hashesHex: string[],
	root: Buffer,
): void {
	if (index < 0 || treeSize < 0) {
		throw new AnchorVerificationError("negative index or tree size");
	}
	if (index >= treeSize) {
		throw new AnchorVerificationError(`index ${index} out of range for tree size ${treeSize}`);
	}
	const proof = hashesHex.map((hx) => {
		const b = Buffer.from(hx, "hex");
		if (b.length !== 32) throw new AnchorVerificationError("audit hash is not 32 bytes");
		return b;
	});

	// Bit math on plain numbers via division (safe to 2^53 — far beyond any real log index —
	// and free of JS's 32-bit bitwise coercion). `inner` = bit length of (index XOR treeSize-1),
	// `border` = popcount of (index >> inner).
	const inner = xorBitLen(index, treeSize - 1);
	const border = onesCount(Math.floor(index / 2 ** inner));
	if (proof.length !== inner + border) {
		throw new AnchorVerificationError(
			`proof has ${proof.length} hashes, want ${inner + border}`,
		);
	}

	let res = leafHash;
	for (let i = 0; i < inner; i++) {
		res = bitAt(index, i) === 0
			? rfc6962NodeHash(res, proof[i])
			: rfc6962NodeHash(proof[i], res);
	}
	for (let i = inner; i < proof.length; i++) {
		res = rfc6962NodeHash(proof[i], res);
	}
	if (!res.equals(root)) {
		throw new AnchorVerificationError("computed root does not match claimed root");
	}
}

/** Bit length of (a XOR b) — the position (1-indexed) of the highest bit where a and b differ. */
function xorBitLen(a: number, b: number): number {
	let len = 0;
	for (let i = 0; a > 0 || b > 0; i++) {
		if (a % 2 !== b % 2) len = i + 1;
		a = Math.floor(a / 2);
		b = Math.floor(b / 2);
	}
	return len;
}

/** Number of set bits in a non-negative integer. */
function onesCount(n: number): number {
	let c = 0;
	while (n > 0) {
		c += n % 2;
		n = Math.floor(n / 2);
	}
	return c;
}

/** Bit `i` (0-indexed) of a non-negative integer. */
function bitAt(n: number, i: number): number {
	return Math.floor(n / 2 ** i) % 2;
}

/** Reads tree size + root hash from a Rekor signed checkpoint (a signed note). */
function parseCheckpoint(checkpoint: string): { treeSize: number; rootHash: Buffer } {
	const sep = checkpoint.indexOf("\n\n");
	const body = sep >= 0 ? checkpoint.slice(0, sep) : checkpoint;
	const lines = body.split("\n");
	if (lines.length < 3) {
		throw new AnchorVerificationError("malformed checkpoint");
	}
	const treeSize = Number.parseInt(lines[1], 10);
	if (!Number.isFinite(treeSize)) {
		throw new AnchorVerificationError("malformed checkpoint tree size");
	}
	return { treeSize, rootHash: Buffer.from(lines[2], "base64") };
}

/** Decodes base64(std) of a PEM-encoded public key into a KeyObject. */
function decodePublicKeyB64Pem(b64: string): KeyObject {
	return createPublicKey(Buffer.from(b64, "base64").toString("utf8"));
}
