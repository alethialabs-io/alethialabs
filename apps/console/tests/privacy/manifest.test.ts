// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The export manifest is the only thing that makes an export verifiable (#2373). These pin the
// three properties a recipient actually relies on: the signature covers what it claims to, an
// unsigned manifest says so rather than looking signed, and a truncated download is detectable.

import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
	archiveMatchesManifest,
	buildManifest,
	canonicalManifestBytes,
	sha256Hex,
	signManifest,
	verifyManifest,
} from "@/lib/privacy/manifest";

const AT = new Date("2026-08-24T12:00:00.000Z");
const enc = (s: string) => new TextEncoder().encode(s);

function keys() {
	const { privateKey, publicKey } = generateKeyPairSync("ed25519");
	return {
		privatePem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
		publicPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
	};
}

const PARTS = [
	{ path: "account/profile.json", describes: "Your account", rows: 1, content: enc('{"a":1}') },
	{ path: "account/jobs.json", describes: "Deploys you ran", rows: 12, content: enc("[]") },
];

describe("building a manifest", () => {
	it("describes every part with its own digest and row count", () => {
		const archive = enc("ARCHIVE");
		const m = buildManifest(PARTS, archive, AT);
		expect(m.version).toBe(1);
		expect(m.archiveSha256).toBe(sha256Hex(archive));
		expect(m.archiveBytes).toBe(archive.byteLength);
		expect(m.parts).toHaveLength(2);
		expect(m.parts[0].sha256).toBe(sha256Hex(PARTS[0].content));
		// Zero rows is a real answer — "we hold none of this" — and must survive into the manifest
		// rather than being dropped as falsy.
		const empty = buildManifest(
			[{ path: "a.json", describes: "Nothing", rows: 0, content: enc("[]") }],
			archive,
			AT,
		);
		expect(empty.parts[0].rows).toBe(0);
	});

	// The manifest is read by the subject, so each part has to say what it is in words they can use.
	it("carries a plain-language description for every part", () => {
		for (const p of buildManifest(PARTS, enc("x"), AT).parts) {
			expect(p.describes.length).toBeGreaterThan(3);
		}
	});
});

describe("canonical bytes", () => {
	// THE property the signature depends on. If canonicalisation followed property order, a later
	// refactor that reordered a literal would invalidate every previously-signed manifest — silently,
	// because nothing would fail until someone tried to verify an old export.
	it("does not depend on the order the fields were written in", () => {
		const a = buildManifest(PARTS, enc("A"), AT);
		const reordered = {
			parts: a.parts,
			archiveBytes: a.archiveBytes,
			version: a.version,
			archiveSha256: a.archiveSha256,
			generatedAt: a.generatedAt,
		};
		expect(canonicalManifestBytes(reordered)).toEqual(canonicalManifestBytes(a));
	});

	it("does depend on the content", () => {
		const a = buildManifest(PARTS, enc("A"), AT);
		const b = buildManifest(PARTS, enc("B"), AT);
		expect(canonicalManifestBytes(a)).not.toEqual(canonicalManifestBytes(b));
	});

	// Array order is content, not incidental: two exports listing the same files in a different
	// order are different manifests, and sorting them would hide a reordered archive.
	it("preserves the order of the parts", () => {
		const a = buildManifest(PARTS, enc("A"), AT);
		const b = buildManifest([PARTS[1], PARTS[0]], enc("A"), AT);
		expect(canonicalManifestBytes(a)).not.toEqual(canonicalManifestBytes(b));
	});
});

describe("signing", () => {
	it("produces a signature that verifies against the public key", () => {
		const { privatePem, publicPem } = keys();
		const signed = signManifest(buildManifest(PARTS, enc("A"), AT), privatePem, "key-1");
		expect(signed.signature).toBeTruthy();
		expect(signed.signingKeyId).toBe("key-1");
		expect(verifyManifest(signed, publicPem)).toBe(true);
	});

	// The point of signing: a manifest edited after the fact stops verifying.
	it("fails verification when any described fact is altered", () => {
		const { privatePem, publicPem } = keys();
		const signed = signManifest(buildManifest(PARTS, enc("A"), AT), privatePem, "key-1");
		for (const tampered of [
			{ ...signed, archiveSha256: sha256Hex(enc("B")) },
			{ ...signed, archiveBytes: signed.archiveBytes + 1 },
			{ ...signed, generatedAt: "2020-01-01T00:00:00.000Z" },
			{ ...signed, parts: signed.parts.map((p) => ({ ...p, rows: p.rows + 1 })) },
		]) {
			expect(verifyManifest(tampered, publicPem)).toBe(false);
		}
	});

	it("does not verify against a different key", () => {
		const a = keys();
		const b = keys();
		const signed = signManifest(buildManifest(PARTS, enc("A"), AT), a.privatePem, "key-1");
		expect(verifyManifest(signed, b.publicPem)).toBe(false);
	});

	// A self-hosted instance with no key must still be able to answer a statutory request. Refusing
	// the export over our own configuration would deny a right the person is entitled to.
	it("returns an honestly unsigned manifest when there is no key", () => {
		const m = signManifest(buildManifest(PARTS, enc("A"), AT), null, null);
		expect(m.signature).toBeNull();
		expect(m.signingKeyId).toBeNull();
		// And the parts are all still there — unsigned is not degraded.
		expect(m.parts).toHaveLength(2);
	});

	it("returns an unsigned manifest rather than throwing on an unusable key", () => {
		const m = signManifest(buildManifest(PARTS, enc("A"), AT), "not a pem", "key-1");
		expect(m.signature).toBeNull();
	});

	// "Not signed" must never read as "verified" — otherwise stripping the signature is a bypass.
	it("refuses to verify an unsigned manifest", () => {
		const { publicPem } = keys();
		const m = signManifest(buildManifest(PARTS, enc("A"), AT), null, null);
		expect(verifyManifest(m, publicPem)).toBe(false);
	});

	it("refuses a signature that is not valid base64 rather than throwing", () => {
		const { publicPem } = keys();
		const m = { ...buildManifest(PARTS, enc("A"), AT), signature: "!!!", signingKeyId: "k" };
		expect(verifyManifest(m, publicPem)).toBe(false);
	});
});

describe("checking an archive against its manifest", () => {
	it("accepts the archive it describes", () => {
		const archive = enc("ARCHIVE-BYTES");
		const m = signManifest(buildManifest(PARTS, archive, AT), null, null);
		expect(archiveMatchesManifest(m, archive)).toEqual({ ok: true });
	});

	// A truncated download has the right prefix and the wrong length. Reporting the length gives a
	// clearer answer than a digest mismatch, which reads as corruption.
	it("names truncation as truncation", () => {
		const archive = enc("ARCHIVE-BYTES");
		const m = signManifest(buildManifest(PARTS, archive, AT), null, null);
		const r = archiveMatchesManifest(m, archive.slice(0, 5));
		expect(r.ok).toBe(false);
		expect(r.ok === false && r.reason).toMatch(/incomplete/);
	});

	it("rejects a same-length archive with different bytes", () => {
		const m = signManifest(buildManifest(PARTS, enc("AAAA"), AT), null, null);
		const r = archiveMatchesManifest(m, enc("BBBB"));
		expect(r.ok).toBe(false);
		expect(r.ok === false && r.reason).toMatch(/digest/);
	});
});
