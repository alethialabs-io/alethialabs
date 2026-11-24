// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The billing-provider list is the single source for the `billing_provider` CHECK constraints and the
// TypeScript type. These pin the guard that narrows untrusted input (a webhook payload, an env var)
// to that list, and the SQL rendering the CHECKs are built from.

import { describe, expect, it } from "vitest";
import {
	BILLING_PROVIDERS,
	billingProviderSqlList,
	isBillingProviderId,
} from "@/lib/db/schema/billing-provider";

describe("billing provider list", () => {
	it("accepts exactly the listed providers", () => {
		for (const id of BILLING_PROVIDERS) expect(isBillingProviderId(id)).toBe(true);
	});

	it("refuses anything else, including near misses and non-strings", () => {
		for (const value of ["", "Stripe", "PADDLE", "paypal", " stripe", null, undefined, 1, {}]) {
			expect(isBillingProviderId(value)).toBe(false);
		}
	});

	it("renders the SQL list the CHECK constraints use", () => {
		expect(billingProviderSqlList()).toBe("'stripe', 'paddle'");
	});
});
