// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import { grantEligibleFor, parseVatNumber } from "@/lib/early-access/vat-number";

describe("parseVatNumber", () => {
	it("normalises spacing, dots, dashes and case", () => {
		const r = parseVatNumber(" de 123.456-789 ");
		expect(r).toEqual({
			ok: true,
			vat: { country: "DE", viesCountryCode: "DE", number: "123456789", normalised: "DE123456789" },
		});
	});

	it("maps Greece's VAT prefix EL to the country GR, and accepts GR typed as EL", () => {
		for (const typed of ["EL123456789", "GR123456789"]) {
			const r = parseVatNumber(typed);
			expect(r.ok && r.vat).toEqual({
				country: "GR",
				viesCountryCode: "EL",
				number: "123456789",
				normalised: "EL123456789",
			});
		}
	});

	it("refuses a number with no country prefix", () => {
		expect(parseVatNumber("123456789")).toEqual({ ok: false, reason: "format" });
		expect(parseVatNumber("D")).toEqual({ ok: false, reason: "format" });
	});

	it("refuses a non-EU prefix", () => {
		expect(parseVatNumber("GB123456789")).toEqual({ ok: false, reason: "not_eu" });
		expect(parseVatNumber("US123456789")).toEqual({ ok: false, reason: "not_eu" });
	});

	it("refuses the seller's own country, which is an ordinary sale", () => {
		expect(parseVatNumber("BG123456789")).toEqual({ ok: false, reason: "seller_country" });
	});
});

describe("grantEligibleFor", () => {
	const de = parseVatNumber("DE123456789");
	if (!de.ok) throw new Error("fixture");

	it("is eligible while the seller is not VAT-registered", () => {
		expect(grantEligibleFor(de.vat, false)).toBe(true);
	});

	it("closes once the seller is registered — the business then buys like any other", () => {
		expect(grantEligibleFor(de.vat, true)).toBe(false);
	});
});
