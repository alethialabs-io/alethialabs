// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #4096, made mechanical. `@repo/plan-catalog`'s `formatPriceLabel` divides by a hardcoded 100,
// and that is CORRECT for every input its type admits — `SupportedCurrency` is `"usd" | "eur"`
// and both are two-decimal for a Stripe CHARGE. The doc that stood there until #4176's part (b)
// claimed the opposite ("carries #3581's divisor defect, unfixed"), which was false when written:
// it described a `string` parameter the signature does not have.
//
// WHY A TEST AND NOT A COMMENT. The claim is true of TODAY'S union and nothing held it there.
// The maintainer's step-6 ruling on #4176 is "render any currency Stripe returns as-is with its
// correct minor-unit decimals", which points at widening the union, and the commit that widens it
// is not going to be the commit that remembers a formatter in another package. This file fails on
// THAT commit rather than on the invoice that renders 100x wrong three weeks later.
//
// IT LIVES IN THE CONSOLE because the console is the only workspace that depends on both packages.
// `@repo/plan-catalog` has no runtime dependencies at all — deliberately, see `formatPriceLabel`'s
// doc — so it cannot import `stripeChargeDivisor` to assert this about itself, and `@repo/format`
// does not know the catalog exists. The edge only exists here.
//
// IT RANGES OVER THE EXPORTED ARRAY, not a list retyped here. `SUPPORTED_CURRENCIES` is the single
// literal `SupportedCurrency` is derived from, so a third member reaches this loop automatically;
// a hand-written `["usd", "eur"]` in this file would go green on the currency it had never heard
// of, which is the failure mode that makes a derived guard over a hand-written domain worthless.

import { describe, expect, it } from "vitest";
import { formatMoney, stripeChargeDivisor, STRIPE_ZERO_DECIMAL_CHARGE } from "@repo/format";
import {
	asSupportedCurrency,
	formatPriceLabel,
	SUPPORTED_CURRENCIES,
} from "@repo/plan-catalog";

describe("SupportedCurrency vs Stripe's charge divisor", () => {
	it("every currency the product sells in is two-decimal for a Stripe charge", () => {
		// A non-empty domain is half the assertion: a loop over an empty array passes silently,
		// and this one's whole job is to be exhaustive.
		expect(SUPPORTED_CURRENCIES.length).toBeGreaterThan(0);
		for (const code of SUPPORTED_CURRENCIES) {
			expect(stripeChargeDivisor(code)).toBe(100);
			expect(STRIPE_ZERO_DECIMAL_CHARGE).not.toContain(code.toUpperCase());
		}
	});

	it("so formatPriceLabel and formatMoney agree on the amount for every one of them", () => {
		// The two formatters differ in REGISTER — `$20` vs `$20.00` — and must not differ in
		// VALUE. Comparing the digits rather than the strings is what makes that a divisor test
		// and not a formatting test: `formatMoney` asks `stripeChargeDivisor`, `formatPriceLabel`
		// hardcodes 100, and this is the assertion that notices when those two stop agreeing.
		for (const code of SUPPORTED_CURRENCIES) {
			const label = formatPriceLabel(124037, code);
			const full = formatMoney(124037, code);
			expect(label).toContain("1240.37");
			expect(full.replace(/,/g, "")).toContain("1240.37");
		}
	});

	// THE DOMAIN'S OWN NARROWING, pinned in both directions so the array and the narrowing
	// function cannot drift apart — `asSupportedCurrency` reads `SUPPORTED_CURRENCIES` now, and
	// this is what says so rather than the reader having to go and check.
	it("asSupportedCurrency admits exactly the listed currencies and nothing else", () => {
		for (const code of SUPPORTED_CURRENCIES) {
			expect(asSupportedCurrency(code)).toBe(code);
		}
		// `jpy` is the specific refusal that matters: a zero-decimal code is the one whose
		// admission would make `formatPriceLabel`'s hardcoded 100 render 100x too small.
		expect(asSupportedCurrency("jpy")).toBeNull();
		expect(asSupportedCurrency("USD")).toBeNull(); // Stripe's spelling is lower case
		expect(asSupportedCurrency("")).toBeNull();
	});
});
