// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// A JSON body reader whose FAILURE is a diagnosis rather than a symptom.
//
// `response.json()` on a body that is not JSON throws V8's SyntaxError, and that message embeds the
// first characters of the body verbatim — NUL and all. On the connector path that message became
// `cloud_identities.last_error`, and Postgres refused the UPDATE (`invalid byte sequence for encoding
// "UTF8": 0x00`), so the user got a raw SQL error instead of the probe failure (#5087, grid run
// 36611808450). The body there was a brotli stream fetch never decoded.
//
// This reader never lets body bytes into the message as text. On failure it names the source, the HTTP
// status, the content-type and content-encoding, the byte count, and the first few bytes as HEX — enough
// to tell compressed (1b… brotli, 1f8b gzip, 28b52ffd zstd) from HTML from truncated JSON, and too
// short to carry any part of a token.

/** Upper bound on a JSON body we will buffer; a larger answer is refused, not parsed. */
export const MAX_JSON_BODY_BYTES = 64 * 1024;

/** How many leading body bytes a failure message shows, as hex. Deliberately too short to hold a secret. */
const PREVIEW_BYTES = 8;

/** Longest header value quoted in a failure message. */
const MAX_HEADER_CHARS = 64;

/**
 * Reads at most `MAX_JSON_BODY_BYTES` of a response body and parses it as JSON. Throws an `Error` whose
 * message is bounded, printable, and names `source`, the status, the content-type/-encoding, the size
 * and the first bytes in hex — never the body as text, so a token in it cannot be echoed.
 */
export async function readJsonBody(
	response: Response,
	source: string,
): Promise<unknown> {
	const bytes = await readBounded(response);
	if (bytes === null) {
		throw new Error(
			`${source} returned a body larger than ${MAX_JSON_BODY_BYTES} bytes (${describeResponse(response)}).`,
		);
	}
	try {
		return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
	} catch {
		throw new Error(
			`${source} returned a body that is not JSON (${describeResponse(response)}, ${bytes.byteLength} bytes, starts ${hexPreview(bytes)}).`,
		);
	}
}

/** Buffers the body up to the cap; returns null (after cancelling the stream) once it exceeds it. */
async function readBounded(response: Response): Promise<Uint8Array | null> {
	if (!response.body) return new Uint8Array(0);
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > MAX_JSON_BODY_BYTES) {
			await reader.cancel().catch(() => undefined);
			return null;
		}
		chunks.push(value);
	}
	const out = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		out.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return out;
}

/** `HTTP <status>, content-type <v>, content-encoding <v>` with each header value made printable. */
function describeResponse(response: Response): string {
	return [
		`HTTP ${response.status}`,
		`content-type ${printableHeader(response.headers.get("content-type"))}`,
		`content-encoding ${printableHeader(response.headers.get("content-encoding"))}`,
	].join(", ");
}

/** A header value restricted to printable ASCII and capped, or `none` when absent. */
function printableHeader(value: string | null): string {
	if (value === null || value === "") return "none";
	const printable = value.replace(/[^\x20-\x7e]/g, "?");
	return printable.length > MAX_HEADER_CHARS
		? `${printable.slice(0, MAX_HEADER_CHARS)}...`
		: printable;
}

/** The first `PREVIEW_BYTES` bytes as space-separated hex (`1b a9 01 00`), or `(empty)`. */
function hexPreview(bytes: Uint8Array): string {
	if (bytes.byteLength === 0) return "(empty)";
	return Array.from(bytes.subarray(0, PREVIEW_BYTES), (b) =>
		b.toString(16).padStart(2, "0"),
	).join(" ");
}
