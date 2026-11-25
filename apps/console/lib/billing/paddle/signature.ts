// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Paddle Billing webhook signature verification. Paddle signs every notification with the
// destination's secret key and sends the result in one header:
//
//   Paddle-Signature: ts=1671552777;h1=eb4d0dc8853be92b7f063b9f3ba5233eb920a09459b6e6b2c26705b4364db151
//
// `h1` is HMAC-SHA256(secret, `${ts}:${rawBody}`) in lower-case hex. While a secret is being rotated
// Paddle sends one `h1` per active secret, so the header may carry several — a delivery is genuine
// when ANY of them matches. The body must be the bytes Paddle sent (never a re-serialised parse), and
// `ts` must be recent: a captured delivery replayed later carries its old `ts`, and the HMAC covers
// it, so the window below is what makes a replay useless.
//
// Pure (no I/O, no env): the route passes the secret and the clock, and the tests drive both.

import { createHmac, timingSafeEqual } from "node:crypto";

/** How far `ts` may be from now, either way, before a delivery is refused as stale. */
export const PADDLE_SIGNATURE_TOLERANCE_SECONDS = 5 * 60;

/** Why a delivery was refused. Safe to log: never carries the secret, the body or a signature. */
export type PaddleSignatureFailure =
	| "missing_header"
	| "malformed_header"
	| "stale_timestamp"
	| "no_secret"
	| "mismatch";

/** The outcome of verifying one delivery. */
export type PaddleSignatureResult = { ok: true; timestamp: number } | { ok: false; reason: PaddleSignatureFailure };

/** What to verify: the raw body and header as received, the secret(s), and the clock. */
export interface PaddleSignatureInput {
	rawBody: string;
	header: string | null;
	/** The destination's secret key(s). Several only while WE hold an old and a new one. */
	secrets: readonly string[];
	/** Now, in ms since the epoch. */
	nowMs: number;
	toleranceSeconds?: number;
}

/** The parsed header: one timestamp and every `h1` it carries. */
interface ParsedHeader {
	timestamp: number;
	h1: string[];
}

const HEX_SHA256 = /^[0-9a-f]{64}$/;

/**
 * Parses `ts=…;h1=…[;h1=…]`. Null when there is no single integer `ts` or no well-formed `h1`; an
 * unknown key (a future scheme) is ignored rather than refused.
 */
export function parsePaddleSignatureHeader(header: string): ParsedHeader | null {
	let timestamp: number | null = null;
	const h1: string[] = [];
	for (const part of header.split(";")) {
		const eq = part.indexOf("=");
		if (eq <= 0) continue;
		const key = part.slice(0, eq).trim();
		const value = part.slice(eq + 1).trim();
		if (key === "ts") {
			if (timestamp !== null || !/^\d{1,12}$/.test(value)) return null;
			timestamp = Number(value);
		} else if (key === "h1") {
			const lower = value.toLowerCase();
			if (HEX_SHA256.test(lower)) h1.push(lower);
		}
	}
	if (timestamp === null || h1.length === 0) return null;
	return { timestamp, h1 };
}

/** HMAC-SHA256(secret, `${ts}:${rawBody}`) as lower-case hex — what Paddle puts in `h1`. */
export function computePaddleSignature(secret: string, timestamp: number, rawBody: string): string {
	return createHmac("sha256", secret).update(`${timestamp}:${rawBody}`, "utf8").digest("hex");
}

/** Constant-time equality of two lower-case hex digests of the same length. */
function digestEquals(a: string, b: string): boolean {
	const ab = Buffer.from(a, "hex");
	const bb = Buffer.from(b, "hex");
	return ab.length === bb.length && ab.length > 0 && timingSafeEqual(ab, bb);
}

/**
 * Verifies a delivery. Fails closed: no secret configured, no header, a malformed header, a `ts`
 * outside the tolerance window or no matching `h1` are all refusals. Every (secret, h1) pair is
 * compared, without an early exit, so the time taken does not say which one matched.
 */
export function verifyPaddleSignature(input: PaddleSignatureInput): PaddleSignatureResult {
	const secrets = input.secrets.filter((s) => s.length > 0);
	if (secrets.length === 0) return { ok: false, reason: "no_secret" };
	if (!input.header) return { ok: false, reason: "missing_header" };
	const parsed = parsePaddleSignatureHeader(input.header);
	if (!parsed) return { ok: false, reason: "malformed_header" };

	const tolerance = input.toleranceSeconds ?? PADDLE_SIGNATURE_TOLERANCE_SECONDS;
	const nowSeconds = Math.floor(input.nowMs / 1000);
	if (Math.abs(nowSeconds - parsed.timestamp) > tolerance) return { ok: false, reason: "stale_timestamp" };

	let matched = false;
	for (const secret of secrets) {
		const expected = computePaddleSignature(secret, parsed.timestamp, input.rawBody);
		for (const candidate of parsed.h1) {
			if (digestEquals(expected, candidate)) matched = true;
		}
	}
	return matched ? { ok: true, timestamp: parsed.timestamp } : { ok: false, reason: "mismatch" };
}
