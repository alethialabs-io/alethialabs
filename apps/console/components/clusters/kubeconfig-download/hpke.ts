// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The BROWSER's half of the kubeconfig mint seal (#5285): HPKE base-mode open, RFC 9180, for the one
// suite the runner seals with — DHKEM(X25519, HKDF-SHA256) / HKDF-SHA256 / AES-256-GCM
// (0x0020 / 0x0001 / 0x0002). The Go half is packages/core/kubeaccess/seal.go and its package comment
// is the construction this must reproduce exactly:
//
//   info = "alethia/kubeconfig-mint/v1"
//   aad  = info || 0x00 || mint_id || 0x00 || cluster_id   (canonical lowercase UUIDs)
//   wire = base64url, unpadded, of enc (32 bytes) || ciphertext (plaintext + 16-byte tag)
//
// Built from WebCrypto primitives only — X25519 `deriveBits`, HMAC-SHA256 and AES-GCM. No KEM, KDF or
// AEAD is implemented here: what IS written by hand is the RFC 9180 glue between them (the labelled
// HKDF steps, the KEM context and the key schedule). That glue is exactly what a test vector catches,
// so tests/components/clusters/kubeconfig-download/hpke.test.ts checks it against BOTH vectors in
// packages/core/kubeaccess/testdata/seal_vectors.json: the CFRG vector for this suite (every
// intermediate value) and a blob Go's own `Seal` produced. Passing both is the proof the browser and
// the runner agree.
//
// No polyfill. Where the browser has no X25519 in WebCrypto, {@link x25519Supported} says so and the
// card points at the CLI: a JavaScript curve implementation would put the private scalar in ordinary
// memory, which is the one thing a non-extractable WebCrypto key avoids.

/** HPKE `info` for every mint seal. Mirrors `kubeaccess.SealInfo`; changing it is a wire break. */
export const SEAL_INFO = "alethia/kubeconfig-mint/v1";

const KEM_ID = 0x0020;
const KDF_ID = 0x0001;
const AEAD_ID = 0x0002;
/** Nenc for DHKEM(X25519). */
const ENC_LEN = 32;
/** Nt for AES-256-GCM. */
const TAG_LEN = 16;
/** Nk for AES-256-GCM. */
const KEY_LEN = 32;
/** Nn for AES-256-GCM. */
const NONCE_LEN = 12;
/** Nh / Nsecret for HKDF-SHA256 and DHKEM(X25519, HKDF-SHA256). */
const HASH_LEN = 32;
/** mode_base (RFC 9180 §5). */
const MODE_BASE = 0x00;

/** The only id spelling `MintAAD` accepts on the Go side. */
const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A byte array backed by a plain ArrayBuffer — the form WebCrypto's `BufferSource` takes. */
type Bytes = Uint8Array<ArrayBuffer>;

/** One error for every way an open fails. A wrong key, a wrong AAD and a tampered blob are
 *  deliberately indistinguishable (as on the Go side): the answer to all three is "mint again". */
export class SealOpenError extends Error {
	/** Builds the error; the message never carries key or ciphertext material. */
	constructor(message = "The sealed kubeconfig does not open for this key, mint and cluster.") {
		super(message);
		this.name = "SealOpenError";
	}
}

/** The ASCII bytes of `s`. */
function ascii(s: string): Bytes {
	const out = new Uint8Array(new ArrayBuffer(s.length));
	for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
	return out;
}

/** Concatenates byte arrays into a fresh buffer. */
function concat(...parts: Uint8Array[]): Bytes {
	const out = new Uint8Array(new ArrayBuffer(parts.reduce((n, p) => n + p.length, 0)));
	let off = 0;
	for (const p of parts) {
		out.set(p, off);
		off += p.length;
	}
	return out;
}

/** I2OSP(n, 2): a big-endian 16-bit integer. */
function u16(n: number): Bytes {
	return concat(new Uint8Array([(n >> 8) & 0xff, n & 0xff]));
}

/** Copies `bytes` into a buffer WebCrypto accepts. */
function own(bytes: Uint8Array): Bytes {
	return concat(bytes);
}

/** Decodes unpadded base64url (the Go side's `base64.RawURLEncoding.Strict()`); throws on anything else. */
export function fromBase64Url(s: string): Bytes {
	if (!/^[A-Za-z0-9_-]*$/.test(s) || s.length % 4 === 1) {
		throw new SealOpenError("The sealed kubeconfig is not unpadded base64url.");
	}
	const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4);
	const bin = atob(b64);
	const out = new Uint8Array(new ArrayBuffer(bin.length));
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}

/** Encodes bytes as unpadded base64url — the wire form of the client public key. */
export function toBase64Url(bytes: Uint8Array): string {
	let bin = "";
	for (const b of bytes) bin += String.fromCharCode(b);
	return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** HMAC-SHA256(key, data). A zero-length key is the same HMAC as 32 zero bytes (RFC 2104 pads the
 *  key with zeros to the block size), and WebCrypto refuses a zero-length HMAC key, so HKDF's empty
 *  salt is passed as zeros — RFC 5869 §2.2's own default. */
async function hmac(key: Uint8Array, data: Uint8Array): Promise<Bytes> {
	const k = await crypto.subtle.importKey(
		"raw",
		key.length === 0 ? new Uint8Array(new ArrayBuffer(HASH_LEN)) : own(key),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	return new Uint8Array(await crypto.subtle.sign("HMAC", k, own(data)));
}

/** HKDF-Expand (RFC 5869 §2.3) over HMAC-SHA256. */
async function hkdfExpand(prk: Uint8Array, info: Uint8Array, length: number): Promise<Bytes> {
	const out = new Uint8Array(new ArrayBuffer(length));
	let t: Uint8Array = new Uint8Array(0);
	let off = 0;
	for (let i = 1; off < length; i++) {
		t = await hmac(prk, concat(t, info, new Uint8Array([i])));
		out.set(t.subarray(0, Math.min(t.length, length - off)), off);
		off += t.length;
	}
	return out;
}

/** RFC 9180 §4 LabeledExtract. */
function labeledExtract(suiteId: Uint8Array, salt: Uint8Array, label: string, ikm: Uint8Array): Promise<Bytes> {
	return hmac(salt, concat(ascii("HPKE-v1"), suiteId, ascii(label), ikm));
}

/** RFC 9180 §4 LabeledExpand. */
function labeledExpand(
	suiteId: Uint8Array,
	prk: Uint8Array,
	label: string,
	info: Uint8Array,
	length: number,
): Promise<Bytes> {
	return hkdfExpand(prk, concat(u16(length), ascii("HPKE-v1"), suiteId, ascii(label), info), length);
}

/** suite_id for the KEM's own HKDF calls: "KEM" || I2OSP(kem_id, 2). */
const KEM_SUITE_ID = concat(ascii("KEM"), u16(KEM_ID));
/** suite_id for the key schedule: "HPKE" || kem_id || kdf_id || aead_id. */
const HPKE_SUITE_ID = concat(ascii("HPKE"), u16(KEM_ID), u16(KDF_ID), u16(AEAD_ID));

/** The X25519 recipient: a private key (non-extractable where it was generated) and its raw public key. */
export interface RecipientKey {
	privateKey: CryptoKey;
	/** The 32-byte RFC 7748 public key — `pkRm`, which the KEM context binds. */
	publicKey: Uint8Array;
}

/**
 * DHKEM(X25519, HKDF-SHA256) Decap (RFC 9180 §4.1): the shared secret for `enc` under `recipient`.
 * WebCrypto refuses an all-zero X25519 output, so a low-order `enc` fails here, as Go refuses it.
 */
export async function decap(enc: Uint8Array, recipient: RecipientKey): Promise<Bytes> {
	let pkE: CryptoKey;
	let dh: Bytes;
	try {
		pkE = await crypto.subtle.importKey("raw", own(enc), { name: "X25519" }, true, []);
		dh = new Uint8Array(
			await crypto.subtle.deriveBits({ name: "X25519", public: pkE }, recipient.privateKey, 256),
		);
	} catch {
		throw new SealOpenError();
	}
	const kemContext = concat(enc, recipient.publicKey);
	const eaePrk = await labeledExtract(KEM_SUITE_ID, new Uint8Array(0), "eae_prk", dh);
	dh.fill(0);
	return labeledExpand(KEM_SUITE_ID, eaePrk, "shared_secret", kemContext, HASH_LEN);
}

/** The base-mode key schedule's outputs (RFC 9180 §5.1). */
export interface KeySchedule {
	keyScheduleContext: Bytes;
	secret: Bytes;
	key: Bytes;
	baseNonce: Bytes;
}

/** RFC 9180 §5.1 KeySchedule for mode_base (empty psk and psk_id). */
export async function keySchedule(sharedSecret: Uint8Array, info: Uint8Array): Promise<KeySchedule> {
	const empty = new Uint8Array(0);
	const pskIdHash = await labeledExtract(HPKE_SUITE_ID, empty, "psk_id_hash", empty);
	const infoHash = await labeledExtract(HPKE_SUITE_ID, empty, "info_hash", info);
	const keyScheduleContext = concat(new Uint8Array([MODE_BASE]), pskIdHash, infoHash);
	const secret = await labeledExtract(HPKE_SUITE_ID, sharedSecret, "secret", empty);
	const key = await labeledExpand(HPKE_SUITE_ID, secret, "key", keyScheduleContext, KEY_LEN);
	const baseNonce = await labeledExpand(HPKE_SUITE_ID, secret, "base_nonce", keyScheduleContext, NONCE_LEN);
	return { keyScheduleContext, secret, key, baseNonce };
}

/** AES-256-GCM open with the context's nonce for sequence number `seq` (base_nonce XOR seq). */
export async function aeadOpen(
	schedule: KeySchedule,
	seq: number,
	aad: Uint8Array,
	ciphertext: Uint8Array,
): Promise<Bytes> {
	const nonce = own(schedule.baseNonce);
	for (let i = 0, s = seq; s > 0 && i < NONCE_LEN; i++, s = Math.floor(s / 256)) {
		nonce[NONCE_LEN - 1 - i] ^= s & 0xff;
	}
	try {
		const k = await crypto.subtle.importKey("raw", schedule.key, { name: "AES-GCM" }, false, ["decrypt"]);
		return new Uint8Array(
			await crypto.subtle.decrypt(
				{ name: "AES-GCM", iv: nonce, additionalData: own(aad), tagLength: TAG_LEN * 8 },
				k,
				own(ciphertext),
			),
		);
	} catch {
		throw new SealOpenError();
	}
}

/** Single-shot HPKE base-mode open of `enc || ct` under the fixed suite, with an explicit info and aad. */
export async function openWith(
	recipient: RecipientKey,
	info: Uint8Array,
	aad: Uint8Array,
	blob: Uint8Array,
): Promise<Bytes> {
	if (blob.length < ENC_LEN + TAG_LEN) throw new SealOpenError();
	const sharedSecret = await decap(blob.subarray(0, ENC_LEN), recipient);
	const schedule = await keySchedule(sharedSecret, info);
	sharedSecret.fill(0);
	try {
		return await aeadOpen(schedule, 0, aad, blob.subarray(ENC_LEN));
	} finally {
		schedule.key.fill(0);
		schedule.secret.fill(0);
	}
}

/** The AAD binding a sealed credential to one mint on one cluster — `kubeaccess.MintAAD`. */
export function mintAad(mintId: string, clusterId: string): Bytes {
	if (!CANONICAL_UUID.test(mintId) || !CANONICAL_UUID.test(clusterId)) {
		throw new SealOpenError("The mint and cluster ids must be canonical lowercase UUIDs.");
	}
	return concat(ascii(SEAL_INFO), new Uint8Array([0]), ascii(mintId), new Uint8Array([0]), ascii(clusterId));
}

/**
 * Opens the wire form of a sealed credential minted for (mintId, clusterId) — the browser's
 * `(*ClientKey).Open`. Returns the plaintext BYTES so the caller can zero them once decoded.
 */
export async function openSealed(
	recipient: RecipientKey,
	sealedB64Url: string,
	mintId: string,
	clusterId: string,
): Promise<Bytes> {
	return openWith(recipient, ascii(SEAL_INFO), mintAad(mintId, clusterId), fromBase64Url(sealedB64Url));
}

/** Whether `value` is a WebCrypto key pair (generateKey's union narrowed without a cast). */
function isKeyPair(value: CryptoKey | CryptoKeyPair): value is CryptoKeyPair {
	return "privateKey" in value && "publicKey" in value;
}

/**
 * A fresh ephemeral X25519 key for ONE mint. The private key is generated NON-extractable: script
 * on the page can use it to derive, never read it out. The public half is always extractable.
 * Throws when the browser has no X25519 — call {@link x25519Supported} first.
 */
export async function generateRecipientKey(): Promise<RecipientKey> {
	const pair = await crypto.subtle.generateKey({ name: "X25519" }, false, ["deriveBits"]);
	if (!isKeyPair(pair)) throw new Error("X25519 key generation did not return a key pair");
	const publicKey = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
	return { privateKey: pair.privateKey, publicKey };
}

/** Whether this browser's WebCrypto can generate an X25519 key (Chrome 133+, Firefox 130+,
 *  Safari 17+). Probed by doing it, not by sniffing a user agent. */
export async function x25519Supported(): Promise<boolean> {
	if (typeof crypto === "undefined" || !crypto.subtle) return false;
	try {
		await generateRecipientKey();
		return true;
	} catch {
		return false;
	}
}
