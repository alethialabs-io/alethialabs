// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// A random UUID that works in every browser context, including a self-host served over plain HTTP.
//
// `crypto.randomUUID` is defined only in a secure context (HTTPS, or localhost). On any other origin
// it is `undefined`, so calling it throws. `crypto.getRandomValues` is defined in every context, so
// the id is built from it here, in the RFC 9562 version-4 layout `crypto.randomUUID` itself returns:
// the same 122 random bits, and the same shape for any column or schema that validates a UUID.
//
// Server code does not need this: it imports `randomUUID` from `node:crypto`.
// `scripts/check-secure-context-apis.mjs` keeps `crypto.randomUUID` out of browser code.

/** The 256 two-digit hex strings, indexed by byte value. */
const HEX = Array.from({ length: 256 }, (_, b) => b.toString(16).padStart(2, "0"));

/**
 * Formats 16 bytes as a version-4 UUID, setting the version and variant bits. Exported so a test can
 * pin the layout with fixed bytes; production callers use {@link randomUuid}.
 */
export function formatUuidV4(bytes: Uint8Array): string {
	if (bytes.length !== 16) throw new RangeError(`a UUID needs 16 bytes, got ${bytes.length}`);
	const b = Uint8Array.from(bytes);
	b[6] = (b[6] & 0x0f) | 0x40; // version 4
	b[8] = (b[8] & 0x3f) | 0x80; // variant 10
	const h = Array.from(b, (x) => HEX[x]);
	return `${h.slice(0, 4).join("")}-${h.slice(4, 6).join("")}-${h.slice(6, 8).join("")}-${h.slice(8, 10).join("")}-${h.slice(10).join("")}`;
}

/** A fresh random version-4 UUID from `crypto.getRandomValues`, safe in an insecure context. */
export function randomUuid(): string {
	return formatUuidV4(crypto.getRandomValues(new Uint8Array(16)));
}
