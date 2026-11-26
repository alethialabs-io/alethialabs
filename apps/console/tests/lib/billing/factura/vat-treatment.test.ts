// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// L6b: the VAT treatment of a business фактура. An unregistered supplier gets the Stripe path's
// Art. 113(9) ground for every buyer; a registered one charges 20% in Bulgaria, applies the reverse
// charge to an EU business with a VAT number of its own state, and prints the outside-scope ground for
// a business outside the EU (Paddle.com Market Ltd, UK).

import { describe, expect, it } from "vitest";
import {
	decideVatTreatment,
	GROUND_EU_REVERSE_CHARGE,
	GROUND_OUTSIDE_SCOPE,
	vatAmountMinor,
} from "@/lib/billing/factura/vat-treatment";

const REGISTERED = { vatRegistered: true, vatNumber: "BG208913663" };

describe("decideVatTreatment", () => {
	it("an unregistered supplier: Art. 113(9), no VAT, whoever the buyer is", () => {
		for (const country of ["BG", "DE", "GB"]) {
			expect(decideVatTreatment({ vatRegistered: false, vatNumber: null }, { country, vatNumber: null })).toEqual({
				ok: true,
				vat: { treatment: "unregistered", ratePercent: 0, ground: "чл. 113, ал. 9 ЗДДС" },
			});
		}
	});

	it("a registered supplier without its VAT number is refused", () => {
		expect(decideVatTreatment({ vatRegistered: true, vatNumber: " " }, { country: "GB", vatNumber: null })).toMatchObject({
			ok: false,
			reason: "supplier_vat_number_missing",
		});
	});

	it("a Bulgarian buyer: domestic, 20%, no ground", () => {
		expect(decideVatTreatment(REGISTERED, { country: "bg", vatNumber: null })).toEqual({
			ok: true,
			vat: { treatment: "domestic", ratePercent: 20, ground: null },
		});
	});

	it("an EU business with its own state's VAT number: reverse charge (Greece's EL prefix included)", () => {
		expect(decideVatTreatment(REGISTERED, { country: "DE", vatNumber: "DE123456789" })).toEqual({
			ok: true,
			vat: { treatment: "eu_reverse_charge", ratePercent: 0, ground: GROUND_EU_REVERSE_CHARGE },
		});
		expect(decideVatTreatment(REGISTERED, { country: "GR", vatNumber: "EL123456789" })).toMatchObject({
			ok: true,
			vat: { treatment: "eu_reverse_charge" },
		});
	});

	it("an EU buyer without a VAT number, or with another state's, is refused", () => {
		expect(decideVatTreatment(REGISTERED, { country: "DE", vatNumber: null })).toMatchObject({
			ok: false,
			reason: "eu_buyer_without_vat_number",
		});
		expect(decideVatTreatment(REGISTERED, { country: "GR", vatNumber: "DE123456789" })).toMatchObject({
			ok: false,
			reason: "eu_buyer_without_vat_number",
			detail: expect.stringContaining("EL-prefixed"),
		});
	});

	it("a business outside the EU (the UK): outside scope under Art. 21(2)", () => {
		expect(decideVatTreatment(REGISTERED, { country: "GB", vatNumber: "GB123456789" })).toEqual({
			ok: true,
			vat: { treatment: "outside_scope", ratePercent: 0, ground: GROUND_OUTSIDE_SCOPE },
		});
		expect(GROUND_OUTSIDE_SCOPE).toContain("чл. 21, ал. 2 ЗДДС");
	});
});

describe("vatAmountMinor", () => {
	it("rounds half away from zero, symmetrically for credits, with no negative zero", () => {
		expect(vatAmountMinor(100000, 20)).toBe(20000);
		expect(vatAmountMinor(10003, 20)).toBe(2001);
		expect(vatAmountMinor(10002, 20)).toBe(2000);
		expect(vatAmountMinor(-10003, 20)).toBe(-2001);
		expect(Object.is(vatAmountMinor(-500, 0), 0)).toBe(true);
	});
});
