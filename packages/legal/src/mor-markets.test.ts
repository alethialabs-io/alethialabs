// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import { EU_MEMBER_STATES, PAYER_CAPACITIES, SELLER_COUNTRY } from "./commerce";
import { MOR_MARKETS, type MorMarketCell, matchMorMarketCell, morMarketEnabled } from "./mor-markets";

describe("MOR_MARKETS", () => {
	// Opening a merchant-of-record cell is the maintainer's go-live decision, taken in its own PR
	// after the VAT registration takes effect. Until then the list is empty, and a change here that
	// adds a cell must also change this test — which is the point.
	it("is empty", () => {
		expect(MOR_MARKETS).toEqual([]);
	});

	it("refuses every buyer while it is empty", () => {
		for (const country of [SELLER_COUNTRY, ...EU_MEMBER_STATES, "US", "GB", "CH"]) {
			for (const capacity of PAYER_CAPACITIES) {
				expect(morMarketEnabled(country, capacity)).toBe(false);
			}
		}
		expect(morMarketEnabled(null, "organization")).toBe(false);
		expect(morMarketEnabled("BG", null)).toBe(false);
	});
});

describe("matchMorMarketCell", () => {
	const cells: readonly MorMarketCell[] = [
		{ country: "DE", capacity: "organization", evidence: "test" },
	];

	it("matches on country (case-insensitive) and capacity", () => {
		expect(matchMorMarketCell(cells, "de", "organization")).toBe(cells[0]);
		expect(matchMorMarketCell(cells, " DE ", "organization")).toBe(cells[0]);
	});

	it("fails closed on a different capacity, a missing or malformed country, or no capacity", () => {
		expect(matchMorMarketCell(cells, "DE", "consumer")).toBeUndefined();
		expect(matchMorMarketCell(cells, "FR", "organization")).toBeUndefined();
		expect(matchMorMarketCell(cells, "DEU", "organization")).toBeUndefined();
		expect(matchMorMarketCell(cells, "", "organization")).toBeUndefined();
		expect(matchMorMarketCell(cells, undefined, "organization")).toBeUndefined();
		expect(matchMorMarketCell(cells, "DE", undefined)).toBeUndefined();
		expect(matchMorMarketCell([], "DE", "organization")).toBeUndefined();
	});
});
