// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The signed manifest that ships inside a data-subject export (#2373).
//
// An archive with no manifest is a bag of files the recipient has to take on trust: they cannot
// tell whether it is complete, whether it was truncated in transit, or whether it is the archive we
// say we sent. The manifest answers all three — what is inside, how many rows each part holds, and
// the digest of the archive it describes — and the signature makes it something we cannot quietly
// revise afterwards either.
//
// Everything here is PURE. Building a manifest, canonicalising it, hashing it and verifying a
// signature are all decidable from their inputs, which is what lets the format be tested exactly
// rather than approximately. The signing itself takes a key as an argument rather than reaching for
// the environment, so the one impure step stays at the edge.

import { createHash, sign as nodeSign, verify as nodeVerify, createPrivateKey, createPublicKey } from "node:crypto";
import type { PrivacyExportManifest } from "@/types/jsonb.types";

/** One file to be described in the manifest. */
export interface ExportPart {
	/** Path inside the archive, e.g. `account/profile.json`. */
	path: string;
	/** What it holds, in plain language — the manifest is read by the SUBJECT, not by us. */
	describes: string;
	/** How many records it contains. Zero is meaningful: "we hold none of this". */
	rows: number;
	/** The file's bytes. Hashed here; never retained. */
	content: Uint8Array;
}

/** SHA-256 as lower-case hex. */
export function sha256Hex(bytes: Uint8Array | string): string {
	return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Canonical bytes of a manifest, for signing and verification.
 *
 * The signature must cover a byte sequence both sides can reproduce, so field ORDER cannot come
 * from `JSON.stringify` of an object literal — that would make the signature depend on the order
 * someone happened to write the properties in, and a later refactor would silently invalidate every
 * previously-signed manifest. Keys are emitted sorted, recursively.
 *
 * `signature` and `signingKeyId` are excluded: a signature cannot cover itself.
 */
export function canonicalManifestBytes(
	manifest: Omit<PrivacyExportManifest, "signature" | "signingKeyId">,
): Uint8Array {
	return new TextEncoder().encode(canonicalJson(manifest));
}

/** Deterministic JSON: object keys sorted, arrays in order, no incidental whitespace. */
function canonicalJson(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	// Object.entries already narrows an object to [string, unknown][] — no assertion needed once the
	// two branches above have excluded null, primitives and arrays.
	const entries = Object.entries(value)
		.filter(([, v]) => v !== undefined)
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
	return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

/**
 * Builds the unsigned manifest for an archive.
 *
 * `generatedAt` is a parameter rather than `new Date()` so the result is a function of its inputs —
 * a manifest whose content depends on the wall clock cannot be asserted byte-for-byte, and the one
 * thing this file has to get exactly right is its bytes.
 */
export function buildManifest(
	parts: ExportPart[],
	archive: Uint8Array,
	generatedAt: Date,
): Omit<PrivacyExportManifest, "signature" | "signingKeyId"> {
	return {
		version: 1,
		generatedAt: generatedAt.toISOString(),
		archiveSha256: sha256Hex(archive),
		archiveBytes: archive.byteLength,
		parts: parts.map((p) => ({
			path: p.path,
			describes: p.describes,
			rows: p.rows,
			sha256: sha256Hex(p.content),
		})),
	};
}

/**
 * Signs a manifest with an ed25519 key, or returns it honestly unsigned.
 *
 * UNSIGNED IS A REAL OUTCOME, not a failure to hide. A self-hosted instance with no signing key
 * configured must still be able to answer a data-subject request — refusing the export because we
 * could not sign the receipt would deny a statutory right over an internal detail. So the manifest
 * says `signature: null` and the recipient can see that it is unsigned, rather than being handed
 * something that looks signed and is not.
 *
 * `privateKeyPem` is passed in; this module never reads the environment.
 */
export function signManifest(
	body: Omit<PrivacyExportManifest, "signature" | "signingKeyId">,
	privateKeyPem: string | null,
	signingKeyId: string | null,
): PrivacyExportManifest {
	if (!privateKeyPem || !signingKeyId) {
		return { ...body, signature: null, signingKeyId: null };
	}
	try {
		const key = createPrivateKey(privateKeyPem);
		// ed25519 signs the message directly — the algorithm argument must be null, not a digest name.
		const sig = nodeSign(null, canonicalManifestBytes(body), key);
		return { ...body, signature: sig.toString("base64"), signingKeyId };
	} catch {
		// An unusable key produces an honestly-unsigned manifest rather than a thrown export. The
		// alternative is refusing a statutory right because of our own misconfiguration.
		return { ...body, signature: null, signingKeyId: null };
	}
}

/**
 * Verifies a manifest's signature against a public key.
 *
 * Returns false for an unsigned manifest — "not signed" is not "verified". A caller that wants to
 * accept unsigned manifests has to say so explicitly, which is the right way round.
 */
export function verifyManifest(
	manifest: PrivacyExportManifest,
	publicKeyPem: string,
): boolean {
	if (!manifest.signature) return false;
	const { signature: _sig, signingKeyId: _kid, ...body } = manifest;
	try {
		return nodeVerify(
			null,
			canonicalManifestBytes(body),
			createPublicKey(publicKeyPem),
			Buffer.from(manifest.signature, "base64"),
		);
	} catch {
		return false;
	}
}

/**
 * Whether an archive matches the manifest that describes it.
 *
 * The check a RECIPIENT runs, and the reason the digest and the byte length are both recorded: a
 * truncated download has the right prefix and the wrong length, and catching it on length gives a
 * clearer answer than a digest mismatch alone.
 */
export function archiveMatchesManifest(
	manifest: PrivacyExportManifest,
	archive: Uint8Array,
): { ok: true } | { ok: false; reason: string } {
	if (archive.byteLength !== manifest.archiveBytes) {
		return {
			ok: false,
			reason: `archive is ${archive.byteLength} bytes; the manifest describes ${manifest.archiveBytes} — the download is incomplete`,
		};
	}
	const digest = sha256Hex(archive);
	if (digest !== manifest.archiveSha256) {
		return {
			ok: false,
			reason: `archive digest ${digest} does not match the manifest's ${manifest.archiveSha256}`,
		};
	}
	return { ok: true };
}
