// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	canonicalJson,
	signSnapshot,
	verifySnapshot,
} from "@/lib/runners/snapshot-sig";

const KEY = "ALETHIA_SNAPSHOT_HMAC_KEY";

describe("snapshot-sig", () => {
	let prev: string | undefined;
	beforeEach(() => {
		prev = process.env[KEY];
	});
	afterEach(() => {
		if (prev === undefined) delete process.env[KEY];
		else process.env[KEY] = prev;
	});

	it("canonicalJson is stable regardless of key order, but arrays keep order", () => {
		expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
		expect(canonicalJson({ a: { y: 1, x: 2 } })).toBe('{"a":{"x":2,"y":1}}');
		expect(canonicalJson([2, 1])).not.toBe(canonicalJson([1, 2]));
	});

	it("sign→verify round-trips a snapshot", () => {
		process.env[KEY] = "test-key";
		const snap = { provider: "aws", cluster: { node_min_size: 2 } };
		const sig = signSnapshot(snap);
		expect(sig).toMatch(/^[0-9a-f]{64}$/);
		expect(verifySnapshot(snap, sig)).toBe(true);
		// Same content, different key order → still verifies (canonicalization).
		expect(verifySnapshot({ cluster: { node_min_size: 2 }, provider: "aws" }, sig)).toBe(true);
	});

	it("rejects a tampered snapshot", () => {
		process.env[KEY] = "test-key";
		const snap = { provider: "aws", region: "eu-west-1" };
		const sig = signSnapshot(snap);
		expect(verifySnapshot({ provider: "aws", region: "us-east-1" }, sig)).toBe(false);
		expect(verifySnapshot({ ...snap, injected: true }, sig)).toBe(false);
	});

	it("is a no-op when no key is configured (feature off / legacy)", () => {
		delete process.env[KEY];
		expect(signSnapshot({ a: 1 })).toBeNull();
		// Verify passes for any input when signing is off, and for a null sig regardless.
		expect(verifySnapshot({ a: 1 }, null)).toBe(true);
		process.env[KEY] = "test-key";
		expect(verifySnapshot({ a: 1 }, null)).toBe(true); // legacy row (null sig) not rejected
	});

	it("a different key does not verify another key's signature", () => {
		process.env[KEY] = "key-1";
		const sig = signSnapshot({ a: 1 });
		process.env[KEY] = "key-2";
		expect(verifySnapshot({ a: 1 }, sig)).toBe(false);
	});
});
