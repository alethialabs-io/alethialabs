// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import { DEFAULT_TAX_ID_TYPE, TAX_ID_TYPES, taxIdOption } from "@/lib/billing/tax-ids";

describe("taxIdOption", () => {
	it("looks up an option by its Stripe type", () => {
		expect(taxIdOption("us_ein")).toMatchObject({ value: "us_ein", label: "US EIN" });
		expect(taxIdOption("gb_vat").value).toBe("gb_vat");
	});

	it("falls back to the first option (eu_vat) for an unknown type", () => {
		expect(taxIdOption("zz_bogus" as never).value).toBe("eu_vat");
	});
});

describe("TAX_ID_TYPES catalog", () => {
	it("defaults to eu_vat at index 0", () => {
		expect(DEFAULT_TAX_ID_TYPE).toBe("eu_vat");
		expect(TAX_ID_TYPES[0].value).toBe("eu_vat");
	});

	it("every option has a value, label, and example placeholder", () => {
		for (const o of TAX_ID_TYPES) {
			expect(o.value).toBeTruthy();
			expect(o.label).toBeTruthy();
			expect(o.example).toBeTruthy();
		}
		expect(new Set(TAX_ID_TYPES.map((o) => o.value)).size).toBe(TAX_ID_TYPES.length); // unique
	});
});
