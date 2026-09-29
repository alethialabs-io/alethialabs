// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

import { brotliCompressSync, gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { MAX_JSON_BODY_BYTES, readJsonBody } from "@/lib/net/read-json-body";

/** A broker-shaped JSON body carrying a token that must never be echoed. */
const TOKEN = "eyJhbGciOiJSUzI1NiJ9.secret-payload.secret-signature";
const JSON_BODY = JSON.stringify({ assertion: TOKEN, issuer: "https://issuer.example.test" });

/** Builds a response whose body is exactly `bytes`, as an un-decoded fetch hands it over. */
function rawResponse(bytes: Uint8Array, headers: Record<string, string>, status = 200): Response {
	return new Response(new Uint8Array(bytes), { status, headers });
}

/** Asserts a message is printable ASCII (no control bytes, no replacement characters). */
function expectPrintable(message: string): void {
	expect(message).toMatch(/^[\x20-\x7e]+$/);
}

describe("readJsonBody", () => {
	it("parses a JSON body", async () => {
		const body = await readJsonBody(
			rawResponse(new TextEncoder().encode(JSON_BODY), { "content-type": "application/json" }),
			"E2E assertion broker",
		);
		expect(body).toEqual(JSON.parse(JSON_BODY));
	});

	it("names a brotli body it was handed un-decoded — status, type, encoding, size and hex, never the bytes", async () => {
		// Exactly what grid run 36611808450 saw: Cloudflare's brotli stream, content-encoding stripped
		// by the transport, handed to the JSON parser as-is.
		const compressed = brotliCompressSync(Buffer.from(JSON_BODY));
		const firstByte = compressed[0]?.toString(16).padStart(2, "0") ?? "";
		const err = await readJsonBody(
			rawResponse(compressed, { "content-type": "application/json" }),
			"E2E assertion broker",
		).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(Error);
		const message = err instanceof Error ? err.message : "";
		expect(message).toContain("E2E assertion broker returned a body that is not JSON");
		expect(message).toContain("HTTP 200");
		expect(message).toContain("content-type application/json");
		expect(message).toContain("content-encoding none");
		expect(message).toContain(`${compressed.byteLength} bytes`);
		expect(message).toMatch(new RegExp(`starts ${firstByte}( [0-9a-f]{2}){7}\\)`));
		expect(message).not.toContain("Unexpected token");
		expectPrintable(message);
	});

	it("names a gzip body and the encoding header it arrived with", async () => {
		const err = await readJsonBody(
			rawResponse(gzipSync(Buffer.from(JSON_BODY)), {
				"content-type": "application/json",
				"content-encoding": "gzip",
			}),
			"GitHub OIDC",
		).catch((e: unknown) => e);
		const message = err instanceof Error ? err.message : "";
		expect(message).toMatch(/^GitHub OIDC returned a body that is not JSON \(HTTP 200, content-type application\/json, content-encoding gzip, \d+ bytes, starts 1f 8b /);
		expectPrintable(message);
	});

	it("shows at most eight bytes, so truncated JSON cannot leak the token it carried", async () => {
		const truncated = new TextEncoder().encode(JSON_BODY.slice(0, 40));
		const err = await readJsonBody(
			rawResponse(truncated, { "content-type": "application/json" }),
			"E2E assertion broker",
		).catch((e: unknown) => e);
		const message = err instanceof Error ? err.message : "";
		expect(message).not.toContain("eyJ");
		expect(message).not.toContain("secret");
		expect(message).not.toContain('"assertion"');
		expect(message).toContain("starts 7b 22 61 73 73 65 72 74)");
	});

	it("refuses an oversized body without buffering it", async () => {
		const huge = new Uint8Array(MAX_JSON_BODY_BYTES + 1).fill(0x20);
		await expect(
			readJsonBody(rawResponse(huge, { "content-type": "text/html" }), "GitHub OIDC"),
		).rejects.toThrow(
			`GitHub OIDC returned a body larger than ${MAX_JSON_BODY_BYTES} bytes (HTTP 200, content-type text/html, content-encoding none).`,
		);
	});

	it("reports an empty body as empty", async () => {
		await expect(
			readJsonBody(new Response(null, { status: 200 }), "GitHub OIDC"),
		).rejects.toThrow("0 bytes, starts (empty))");
	});
});
