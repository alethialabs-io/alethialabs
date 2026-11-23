// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import { EU_MEMBER_STATES, SELLER_COUNTRY } from "./commerce";
import {
	BG_REGISTRATION_THRESHOLD,
	DEFAULT_WARN_MARGIN,
	EU_CROSS_BORDER_THRESHOLD,
	US_STATE_THRESHOLDS,
	assessThreshold,
	bgThresholdAssessment,
	euCrossBorderThresholdAssessment,
	thresholdCountersForSale,
	usStateThreshold,
	usStateThresholdAssessment,
} from "./thresholds";

/** The 50 US states by USPS code. */
const US_STATES = [
	"AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "FL", "GA", "HI", "ID", "IL", "IN", "IA", "KS",
	"KY", "LA", "ME", "MD", "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ", "NM", "NY",
	"NC", "ND", "OH", "OK", "OR", "PA", "RI", "SC", "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV",
	"WI", "WY",
];

describe("the threshold figures", () => {
	// Pinned in minor units, so a slip of a zero is a failing test and not a quiet ten-fold error.
	it("hold EUR 51,130 for Bulgaria and EUR 10,000 for EU cross-border sales, in euro cents", () => {
		expect(BG_REGISTRATION_THRESHOLD.limit).toBe(5_113_000);
		expect(BG_REGISTRATION_THRESHOLD.currency).toBe("EUR");
		expect(BG_REGISTRATION_THRESHOLD.period).toBe("calendar_year");
		expect(BG_REGISTRATION_THRESHOLD.crossing).toBe("exceeds");
		expect(EU_CROSS_BORDER_THRESHOLD.limit).toBe(1_000_000);
		expect(EU_CROSS_BORDER_THRESHOLD.currency).toBe("EUR");
		expect(EU_CROSS_BORDER_THRESHOLD.period).toBe("calendar_year_and_previous");
		expect(EU_CROSS_BORDER_THRESHOLD.crossing).toBe("exceeds");
		expect(DEFAULT_WARN_MARGIN).toBe(0.8);
	});

	it("cover every US state, DC and Puerto Rico, and nothing else", () => {
		expect(Object.keys(US_STATE_THRESHOLDS).sort()).toEqual([...US_STATES, "DC", "PR"].sort());
	});

	it("give the lowest US thresholds as USD 100,000 or 200 transactions", () => {
		expect(usStateThreshold("GA")).toEqual({
			kind: "revenue_or_transactions",
			revenueUsdMinor: 10_000_000,
			transactions: 200,
		});
		expect(usStateThreshold("CT")?.kind).toBe("revenue_and_transactions");
		expect(usStateThreshold("NY")).toEqual({
			kind: "revenue_and_transactions",
			revenueUsdMinor: 50_000_000,
			transactions: 100,
		});
		expect(usStateThreshold("CA")).toEqual({ kind: "revenue", revenueUsdMinor: 50_000_000 });
		expect(usStateThreshold("AL")).toEqual({ kind: "revenue", revenueUsdMinor: 25_000_000 });
		for (const state of ["DE", "MT", "NH", "OR"]) {
			expect(usStateThreshold(state)).toEqual({ kind: "no_sales_tax" });
		}
	});

	it("find a state case-insensitively and refuse an unknown or missing one", () => {
		expect(usStateThreshold(" ga ")).toEqual(usStateThreshold("GA"));
		for (const state of [null, undefined, "", "XX", "GEO", "toString"]) {
			expect(usStateThreshold(state)).toBeNull();
		}
	});
});

describe("the one rule", () => {
	const limit = { limit: 1_000, crossing: "exceeds" as const };

	it("is ok below the margin, warns at it, and stops past the limit", () => {
		expect(assessThreshold({ totalBefore: 0, sale: 100, threshold: limit }).verdict).toBe("ok");
		expect(assessThreshold({ totalBefore: 700, sale: 99, threshold: limit }).verdict).toBe("ok");
		expect(assessThreshold({ totalBefore: 700, sale: 100, threshold: limit }).verdict).toBe(
			"warn",
		);
		expect(assessThreshold({ totalBefore: 1_001, sale: 0, threshold: limit }).verdict).toBe(
			"stop",
		);
	});

	// THE rule (TAX_MARKET_PRECONDITIONS §3.5): the sale that crosses is refused BEFORE it is taken,
	// not counted afterwards. A total just under the limit with a sale that would carry it over stops.
	it("stops before the sale that would cross, not after it", () => {
		expect(assessThreshold({ totalBefore: 999, sale: 2, threshold: limit }).verdict).toBe("stop");
		expect(assessThreshold({ totalBefore: 999, sale: 1, threshold: limit }).verdict).toBe("warn");
		expect(assessThreshold({ totalBefore: 999, sale: 0, threshold: limit }).verdict).toBe("warn");
	});

	it("treats a total exactly at an `exceeds` limit as under it, and at a `reaches` limit as over", () => {
		expect(assessThreshold({ totalBefore: 1_000, sale: 0, threshold: limit }).verdict).toBe(
			"warn",
		);
		const reaches = { limit: 1_000, crossing: "reaches" as const };
		expect(assessThreshold({ totalBefore: 999, sale: 1, threshold: reaches }).verdict).toBe(
			"stop",
		);
		expect(assessThreshold({ totalBefore: 998, sale: 1, threshold: reaches }).verdict).toBe(
			"warn",
		);
	});

	it("takes a configurable margin, clamped, and warns always on an unreadable one", () => {
		const at = (warnMargin: number) =>
			assessThreshold({ totalBefore: 500, sale: 0, threshold: limit, warnMargin }).verdict;
		expect(at(0.5)).toBe("warn");
		expect(at(0.51)).toBe("ok");
		expect(at(0)).toBe("warn");
		expect(at(-3)).toBe("warn");
		expect(at(7)).toBe("ok");
		expect(at(Number.NaN)).toBe("warn");
	});

	it("reports how far along the total is after the sale", () => {
		expect(assessThreshold({ totalBefore: 250, sale: 250, threshold: limit }).usage).toBe(0.5);
	});

	// A broken counter must not read as room to sell.
	it("stops on an unreadable total, sale or limit", () => {
		for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
			expect(assessThreshold({ totalBefore: bad, sale: 0, threshold: limit }).verdict).toBe(
				"stop",
			);
			expect(assessThreshold({ totalBefore: 0, sale: bad, threshold: limit }).verdict).toBe(
				"stop",
			);
		}
		for (const badLimit of [0, -5, Number.NaN]) {
			const threshold = { limit: badLimit, crossing: "exceeds" as const };
			expect(assessThreshold({ totalBefore: 0, sale: 0, threshold }).verdict).toBe("stop");
		}
	});
});

describe("Bulgaria: EUR 51,130", () => {
	it("allows the sale that lands exactly on the threshold and stops the one that exceeds it", () => {
		expect(
			bgThresholdAssessment({ calendarYearEurMinor: 5_112_000, saleEurMinor: 1_000 }).verdict,
		).toBe("warn");
		expect(
			bgThresholdAssessment({ calendarYearEurMinor: 5_112_000, saleEurMinor: 1_001 }).verdict,
		).toBe("stop");
	});

	it("warns at 80% by default, and reads the total alone when no sale is given", () => {
		expect(bgThresholdAssessment({ calendarYearEurMinor: 4_090_399 }).verdict).toBe("ok");
		expect(bgThresholdAssessment({ calendarYearEurMinor: 4_090_400 }).verdict).toBe("warn");
		expect(
			bgThresholdAssessment({ calendarYearEurMinor: 4_090_400, warnMargin: 0.9 }).verdict,
		).toBe("ok");
	});
});

describe("EU cross-border sales to buyers with no VAT number: EUR 10,000", () => {
	it("stops before the sale that would take this year over EUR 10,000", () => {
		const base = { currentYearEurMinor: 999_000, previousYearEurMinor: 0 };
		expect(euCrossBorderThresholdAssessment({ ...base, saleEurMinor: 1_000 }).verdict).toBe(
			"warn",
		);
		expect(euCrossBorderThresholdAssessment({ ...base, saleEurMinor: 1_001 }).verdict).toBe(
			"stop",
		);
	});

	// Art. 20b(1): the exception needs BOTH years at or under EUR 10,000.
	it("stops every sale this year when last year exceeded EUR 10,000", () => {
		const verdict = euCrossBorderThresholdAssessment({
			currentYearEurMinor: 0,
			previousYearEurMinor: 1_000_001,
			saleEurMinor: 100,
		});
		expect(verdict.verdict).toBe("stop");
		expect(
			euCrossBorderThresholdAssessment({
				currentYearEurMinor: 0,
				previousYearEurMinor: 1_000_000,
				saleEurMinor: 100,
			}).verdict,
		).toBe("ok");
	});

	it("does not warn about this year because of last year, but reports the larger fraction", () => {
		const verdict = euCrossBorderThresholdAssessment({
			currentYearEurMinor: 100_000,
			previousYearEurMinor: 900_000,
		});
		expect(verdict.verdict).toBe("ok");
		expect(verdict.usage).toBe(0.9);
	});

	it("stops on an unreadable previous year", () => {
		expect(
			euCrossBorderThresholdAssessment({ currentYearEurMinor: 0, previousYearEurMinor: -1 })
				.verdict,
		).toBe("stop");
	});
});

describe("US states", () => {
	const georgia = { state: "GA", revenueUsdMinor: 0, transactions: 0 };

	// A monthly plan reaches 200 transactions long before USD 100,000 (§2.3).
	it("stops an either-part state on the sale that would be the 200th transaction", () => {
		expect(
			usStateThresholdAssessment({ ...georgia, transactions: 198, saleUsdMinor: 5_000 }).verdict,
		).toBe("warn");
		expect(
			usStateThresholdAssessment({ ...georgia, transactions: 199, saleUsdMinor: 5_000 }).verdict,
		).toBe("stop");
		expect(usStateThresholdAssessment({ ...georgia, transactions: 199 }).verdict).toBe("warn");
	});

	it("stops an either-part state on revenue alone", () => {
		expect(
			usStateThresholdAssessment({
				...georgia,
				revenueUsdMinor: 9_999_000,
				saleUsdMinor: 1_000,
			}).verdict,
		).toBe("stop");
	});

	it("stops a both-parts state only when both would be reached", () => {
		const connecticut = { state: "CT", revenueUsdMinor: 0, transactions: 500 };
		expect(usStateThresholdAssessment({ ...connecticut, saleUsdMinor: 5_000 }).verdict).toBe("ok");
		expect(
			usStateThresholdAssessment({
				...connecticut,
				revenueUsdMinor: 9_999_000,
				saleUsdMinor: 1_000,
			}).verdict,
		).toBe("stop");
	});

	it("reads a revenue-only state on revenue and ignores the transaction count", () => {
		const california = { state: "CA", revenueUsdMinor: 0, transactions: 10_000 };
		expect(usStateThresholdAssessment({ ...california, saleUsdMinor: 5_000 }).verdict).toBe("ok");
	});

	it("never stops a state with no sales tax, but still refuses a broken counter there", () => {
		const oregon = { state: "OR", revenueUsdMinor: 1e12, transactions: 1e6, saleUsdMinor: 1 };
		expect(usStateThresholdAssessment(oregon)).toEqual({ verdict: "ok", usage: 0 });
		expect(usStateThresholdAssessment({ ...oregon, transactions: -1 }).verdict).toBe("stop");
	});

	// A sale that cannot be attributed to a state cannot be counted against any threshold.
	it("stops a sale with a missing or unknown state", () => {
		for (const state of [null, undefined, "", "XX"]) {
			expect(
				usStateThresholdAssessment({ state, revenueUsdMinor: 0, transactions: 0 }).verdict,
			).toBe("stop");
		}
	});

	it("reports the deciding part's fraction, so states sort by the nearest threshold", () => {
		const either = usStateThresholdAssessment({
			...georgia,
			revenueUsdMinor: 1_000_000,
			transactions: 100,
		});
		expect(either.usage).toBe(0.5);
		const both = usStateThresholdAssessment({
			state: "CT",
			revenueUsdMinor: 1_000_000,
			transactions: 100,
		});
		expect(both.usage).toBe(0.1);
	});
});

describe("which counters a sale counts toward", () => {
	const others = EU_MEMBER_STATES.filter((country) => country !== SELLER_COUNTRY);

	it("counts every Bulgarian sale toward the Bulgarian total only", () => {
		for (const capacity of ["consumer", "organization"] as const) {
			for (const vatIdGiven of [true, false, null]) {
				expect(thresholdCountersForSale({ country: "bg", capacity, vatIdGiven })).toEqual([
					{ id: "bg_place_of_supply" },
				]);
			}
		}
	});

	it("counts a no-VAT-number EU sale toward both EU totals, and a VAT-number one toward neither", () => {
		const both = [{ id: "eu_cross_border_no_vat_id" }, { id: "bg_place_of_supply" }];
		for (const country of others) {
			expect(
				thresholdCountersForSale({ country, capacity: "organization", vatIdGiven: false }),
			).toEqual(both);
			expect(thresholdCountersForSale({ country, capacity: "consumer", vatIdGiven: null })).toEqual(
				both,
			);
			// Undeclared errs safe: counted as if no VAT number was given.
			expect(
				thresholdCountersForSale({ country, capacity: "organization", vatIdGiven: null }),
			).toEqual(both);
			expect(
				thresholdCountersForSale({ country, capacity: "organization", vatIdGiven: true }),
			).toEqual([]);
		}
	});

	it("counts a US sale toward its state, and keeps a missing state visible as null", () => {
		expect(
			thresholdCountersForSale({
				country: "US",
				capacity: "organization",
				vatIdGiven: null,
				state: "ga",
			}),
		).toEqual([{ id: "us_state", state: "GA" }]);
		expect(
			thresholdCountersForSale({ country: "US", capacity: "organization", vatIdGiven: null }),
		).toEqual([{ id: "us_state", state: null }]);
	});

	it("counts nothing elsewhere or on an unreadable buyer", () => {
		for (const country of ["CA", "GB", "MX", null, "", "DEU"]) {
			expect(
				thresholdCountersForSale({ country, capacity: "organization", vatIdGiven: false }),
			).toEqual([]);
		}
		expect(thresholdCountersForSale({ country: "BG", capacity: null, vatIdGiven: null })).toEqual(
			[],
		);
	});
});
