// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// `settle()`'s decision, pinned (#4980). Two equal reads used to BE the answer, and a
// `keepPreviousData` placeholder is precisely a list that holds still: F8 on `~/runners` and
// `~/alerts` passed or failed on how long the filtered fetch took. A read the page marked
// `aria-busy` is a stand-in by the page's own account and can never close a pair.

import { describe, expect, it } from "vitest";
import { isSettledPair, type ListRead } from "../../e2e/audit/filters";

/** One read of `value` rows from the count pill, busy or not. */
function read(value: number, busy = false): ListRead {
	return { count: { source: "count-pill", value }, busy };
}

describe("isSettledPair", () => {
	it("accepts two equal, answered reads", () => {
		expect(isSettledPair(read(3), read(3))).toBe(true);
	});

	it("refuses two equal reads when either was taken while the page said busy — the placeholder", () => {
		expect(isSettledPair(read(3, true), read(3, true))).toBe(false);
		expect(isSettledPair(read(3, true), read(3))).toBe(false);
		expect(isSettledPair(read(3), read(3, true))).toBe(false);
	});

	it("refuses a list still moving, and a first read with nothing to pair it with", () => {
		expect(isSettledPair(read(3), read(2))).toBe(false);
		expect(isSettledPair(null, read(2))).toBe(false);
	});

	it("refuses the same number read from a different source", () => {
		expect(isSettledPair(read(3), { count: { source: "rows", value: 3 }, busy: false })).toBe(false);
	});
});
