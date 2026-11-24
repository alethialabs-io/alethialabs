// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The provider seam's selection (Paddle Billing L1): new sales follow BILLING_PROVIDER and FAIL CLOSED;
// an existing subscription follows its own billing row, whatever BILLING_PROVIDER says.

import { afterEach, describe, expect, it, vi } from "vitest";
import {
	isProviderKeyConfigured,
	isSalesProviderConfigured,
	type ProviderRoutingRow,
	providerById,
	providerForOrg,
	salesProvider,
} from "@/lib/billing/provider/select";
import { BILLING_PROVIDERS } from "@/lib/db/schema/billing-provider";

/** A billing row with no provider and no subscription, overridden by `over`. */
function row(over: Partial<ProviderRoutingRow> = {}): ProviderRoutingRow {
	return {
		billingProvider: null,
		stripeSubscriptionId: null,
		aiStripeSubscriptionId: null,
		paddleSubscriptionId: null,
		aiPaddleSubscriptionId: null,
		...over,
	};
}

describe("salesProvider — fails closed", () => {
	it.each([
		["unset", {}],
		["blank", { BILLING_PROVIDER: "  " }],
		["unknown", { BILLING_PROVIDER: "braintree" }],
		["wrong case", { BILLING_PROVIDER: "Stripe" }],
	])("is null when BILLING_PROVIDER is %s", (_label, env) => {
		expect(salesProvider(env)).toBeNull();
	});

	it("is null even where Stripe keys are present — no inference from secrets", () => {
		expect(salesProvider({ STRIPE_SECRET_KEY: "sk_test_123" })).toBeNull();
		expect(isSalesProviderConfigured({ STRIPE_SECRET_KEY: "sk_test_123" })).toBe(false);
	});

	it.each(BILLING_PROVIDERS)("reads %s (trimmed)", (id) => {
		expect(salesProvider({ BILLING_PROVIDER: ` ${id}\n` })).toBe(id);
	});

	it("defaults to process.env", () => {
		vi.stubEnv("BILLING_PROVIDER", "paddle");
		expect(salesProvider()).toBe("paddle");
	});

	afterEach(() => {
		vi.unstubAllEnvs();
	});
});

describe("isSalesProviderConfigured", () => {
	it("needs the selected provider's OWN key", () => {
		expect(isSalesProviderConfigured({ BILLING_PROVIDER: "stripe", STRIPE_SECRET_KEY: "sk_test_1" })).toBe(true);
		expect(isSalesProviderConfigured({ BILLING_PROVIDER: "paddle", STRIPE_SECRET_KEY: "sk_test_1" })).toBe(false);
		expect(isSalesProviderConfigured({ BILLING_PROVIDER: "paddle", PADDLE_API_KEY: "pdl_sdbx_apikey_x" })).toBe(true);
		expect(isSalesProviderConfigured({ BILLING_PROVIDER: "stripe", PADDLE_API_KEY: "pdl_sdbx_apikey_x" })).toBe(false);
	});

	it("treats a blank key as no key", () => {
		expect(isProviderKeyConfigured("stripe", { STRIPE_SECRET_KEY: " \n" })).toBe(false);
		expect(isProviderKeyConfigured("paddle", { PADDLE_API_KEY: "" })).toBe(false);
	});
});

describe("providerForOrg — the row wins", () => {
	it("follows the row's billing_provider over BILLING_PROVIDER", () => {
		expect(providerForOrg(row({ billingProvider: "stripe" }), { BILLING_PROVIDER: "paddle" })).toBe("stripe");
		expect(providerForOrg(row({ billingProvider: "paddle" }), { BILLING_PROVIDER: "stripe" })).toBe("paddle");
	});

	it("keeps a legacy Stripe subscriber (NULL provider) on Stripe after the sales provider moves", () => {
		expect(providerForOrg(row({ stripeSubscriptionId: "sub_1" }), { BILLING_PROVIDER: "paddle" })).toBe("stripe");
		expect(providerForOrg(row({ aiStripeSubscriptionId: "sub_ai" }), { BILLING_PROVIDER: "paddle" })).toBe("stripe");
	});

	it("routes a row with no subscription, or no row, to the sales provider", () => {
		expect(providerForOrg(row(), { BILLING_PROVIDER: "paddle" })).toBe("paddle");
		expect(providerForOrg(null, { BILLING_PROVIDER: "stripe" })).toBe("stripe");
	});

	it("fails closed when nothing answers", () => {
		expect(providerForOrg(row(), {})).toBeNull();
		expect(providerForOrg(null, { BILLING_PROVIDER: "nope" })).toBeNull();
	});
});

describe("providerById", () => {
	it("has no adapter for any provider yet (they land in later lanes)", () => {
		for (const id of BILLING_PROVIDERS) expect(providerById(id)).toBeNull();
	});
});
