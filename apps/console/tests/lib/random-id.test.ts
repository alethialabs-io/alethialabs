// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// randomUuid: a version-4 UUID built from crypto.getRandomValues, so it works where
// crypto.randomUUID does not exist (a console served over plain HTTP).

import { afterEach, describe, expect, it, vi } from "vitest";
import { formatUuidV4, randomUuid } from "@/lib/random-id";

const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("formatUuidV4", () => {
	it("lays out 16 bytes as a UUID and sets the version and variant bits", () => {
		expect(formatUuidV4(new Uint8Array(16).fill(0xff))).toBe("ffffffff-ffff-4fff-bfff-ffffffffffff");
		expect(formatUuidV4(new Uint8Array(16))).toBe("00000000-0000-4000-8000-000000000000");
		expect(formatUuidV4(Uint8Array.from({ length: 16 }, (_, i) => i))).toBe(
			"00010203-0405-4607-8809-0a0b0c0d0e0f",
		);
	});

	it("does not modify the bytes it was given", () => {
		const bytes = new Uint8Array(16).fill(0xff);
		formatUuidV4(bytes);
		expect([...bytes]).toEqual(new Array(16).fill(0xff));
	});

	it("refuses anything but 16 bytes", () => {
		expect(() => formatUuidV4(new Uint8Array(15))).toThrow(RangeError);
	});
});

describe("randomUuid", () => {
	it("returns a version-4 UUID, a new one each call", () => {
		const a = randomUuid();
		const b = randomUuid();
		expect(a).toMatch(V4);
		expect(b).toMatch(V4);
		expect(a).not.toBe(b);
	});

	it("works where crypto.randomUUID does not exist (an insecure context)", () => {
		// What a plain-HTTP page has: getRandomValues, and no randomUUID.
		const getRandomValues = vi.fn(<T extends ArrayBufferView | null>(array: T): T => {
			if (array instanceof Uint8Array) array.fill(0xab);
			return array;
		});
		vi.stubGlobal("crypto", { getRandomValues });
		expect(randomUuid()).toBe("abababab-abab-4bab-abab-abababababab");
		expect(getRandomValues).toHaveBeenCalledOnce();
	});
});
