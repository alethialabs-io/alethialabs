// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Paddle-Signature verification (lib/billing/paddle/signature.ts): a genuine delivery verifies; a
// tampered body, a wrong secret, a stale or future timestamp, a missing or malformed header and an
// unset secret are all refused; a header carrying several h1 (Paddle's secret rotation) verifies when
// any one matches. The expected digest is computed independently here with node:crypto, so the test
// does not grade the implementation against itself.

import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
	computePaddleSignature,
	PADDLE_SIGNATURE_TOLERANCE_SECONDS,
	parsePaddleSignatureHeader,
	verifyPaddleSignature,
} from "@/lib/billing/paddle/signature";

const SECRET = "pdl_ntfset_test_secret_one";
const OTHER = "pdl_ntfset_test_secret_two";
const BODY = '{"event_id":"evt_01","event_type":"subscription.created","occurred_at":"2026-11-25T10:00:00Z","data":{}}';
const TS = 1_795_000_000;
const NOW_MS = TS * 1000;

/** The h1 Paddle would send, computed without the module under test. */
function h1(secret: string, ts: number, body: string): string {
	return createHmac("sha256", secret).update(`${ts}:${body}`).digest("hex");
}

describe("computePaddleSignature", () => {
	it("is HMAC-SHA256 of `ts:body` in lower-case hex", () => {
		expect(computePaddleSignature(SECRET, TS, BODY)).toBe(h1(SECRET, TS, BODY));
	});
});

describe("parsePaddleSignatureHeader", () => {
	it("reads ts and every h1, ignoring unknown keys", () => {
		const a = h1(SECRET, TS, BODY);
		const b = h1(OTHER, TS, BODY);
		expect(parsePaddleSignatureHeader(`ts=${TS};h1=${a};h2=zzz;h1=${b.toUpperCase()}`)).toEqual({
			timestamp: TS,
			h1: [a, b],
		});
	});

	it("refuses a header with no ts, two ts, a non-numeric ts, or no well-formed h1", () => {
		const a = h1(SECRET, TS, BODY);
		expect(parsePaddleSignatureHeader(`h1=${a}`)).toBeNull();
		expect(parsePaddleSignatureHeader(`ts=${TS};ts=${TS};h1=${a}`)).toBeNull();
		expect(parsePaddleSignatureHeader(`ts=abc;h1=${a}`)).toBeNull();
		expect(parsePaddleSignatureHeader(`ts=${TS};h1=nothex`)).toBeNull();
		expect(parsePaddleSignatureHeader("garbage")).toBeNull();
	});
});

describe("verifyPaddleSignature", () => {
	const base = { rawBody: BODY, secrets: [SECRET], nowMs: NOW_MS };

	it("accepts a genuine delivery", () => {
		const r = verifyPaddleSignature({ ...base, header: `ts=${TS};h1=${h1(SECRET, TS, BODY)}` });
		expect(r).toEqual({ ok: true, timestamp: TS });
	});

	it("refuses a tampered body", () => {
		const r = verifyPaddleSignature({
			...base,
			rawBody: BODY.replace("subscription.created", "subscription.canceled"),
			header: `ts=${TS};h1=${h1(SECRET, TS, BODY)}`,
		});
		expect(r).toEqual({ ok: false, reason: "mismatch" });
	});

	it("refuses a signature made with another secret", () => {
		const r = verifyPaddleSignature({ ...base, header: `ts=${TS};h1=${h1(OTHER, TS, BODY)}` });
		expect(r).toEqual({ ok: false, reason: "mismatch" });
	});

	it("refuses a replayed timestamp the signature does not cover", () => {
		// Same h1, the ts bumped to look fresh: the HMAC covers ts, so it no longer matches.
		const r = verifyPaddleSignature({ ...base, header: `ts=${TS + 1};h1=${h1(SECRET, TS, BODY)}` });
		expect(r).toEqual({ ok: false, reason: "mismatch" });
	});

	it("refuses a stale delivery past the tolerance, and one from the future", () => {
		const old = TS - PADDLE_SIGNATURE_TOLERANCE_SECONDS - 1;
		expect(verifyPaddleSignature({ ...base, header: `ts=${old};h1=${h1(SECRET, old, BODY)}` })).toEqual({
			ok: false,
			reason: "stale_timestamp",
		});
		const future = TS + PADDLE_SIGNATURE_TOLERANCE_SECONDS + 1;
		expect(verifyPaddleSignature({ ...base, header: `ts=${future};h1=${h1(SECRET, future, BODY)}` })).toEqual({
			ok: false,
			reason: "stale_timestamp",
		});
	});

	it("accepts a delivery at the edge of the tolerance window", () => {
		const edge = TS - PADDLE_SIGNATURE_TOLERANCE_SECONDS;
		expect(verifyPaddleSignature({ ...base, header: `ts=${edge};h1=${h1(SECRET, edge, BODY)}` }).ok).toBe(true);
	});

	it("accepts any matching h1 while Paddle rotates the secret", () => {
		const header = `ts=${TS};h1=${h1(OTHER, TS, BODY)};h1=${h1(SECRET, TS, BODY)}`;
		expect(verifyPaddleSignature({ ...base, header }).ok).toBe(true);
	});

	it("accepts a delivery signed with either of our secrets during our own rotation", () => {
		const header = `ts=${TS};h1=${h1(OTHER, TS, BODY)}`;
		expect(verifyPaddleSignature({ ...base, secrets: [SECRET, OTHER], header }).ok).toBe(true);
	});

	it("fails closed without a secret, a header, or a parseable header", () => {
		const header = `ts=${TS};h1=${h1(SECRET, TS, BODY)}`;
		expect(verifyPaddleSignature({ ...base, secrets: [], header })).toEqual({ ok: false, reason: "no_secret" });
		expect(verifyPaddleSignature({ ...base, secrets: [""], header })).toEqual({ ok: false, reason: "no_secret" });
		expect(verifyPaddleSignature({ ...base, header: null })).toEqual({ ok: false, reason: "missing_header" });
		expect(verifyPaddleSignature({ ...base, header: "nope" })).toEqual({ ok: false, reason: "malformed_header" });
	});
});
