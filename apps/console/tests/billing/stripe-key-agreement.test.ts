// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #5443: the market seam and the Stripe client must judge the SAME key.
//
// `testModeMarketOpen` waives `market_closed` only for a Stripe TEST key, and its whole safety
// argument is "a test key cannot move money". That argument is about the key the Stripe client is
// built from. Before #5443 the seam trimmed `STRIPE_SECRET_KEY` and `getStripeConfig` did not, so
// the two read different strings from one variable: a key carried with a trailing newline — what a
// secret store or a `$(cat key)` export leaves behind — was a test key to the seam and an
// untrimmed string to the client. Both now ask `stripeSecretKey`.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** The key each constructed Stripe client was given. */
const constructedWith: string[] = [];

vi.mock("stripe", () => ({
	default: vi.fn(function FakeStripe(key: string) {
		constructedWith.push(key);
	}),
}));
// eligibility.ts imports the db module; nothing in this file reaches a query.
vi.mock("@/lib/db", () => ({ getServiceDb: vi.fn() }));

import { TEST_MODE_MARKET_FLAG } from "@/lib/billing/eligibility";

/** Sets the env a hosted console needs for `getStripeConfig` to validate. */
function hostedEnv(secretKey: string, flag: string | undefined): void {
	vi.stubEnv("STRIPE_SECRET_KEY", secretKey);
	vi.stubEnv("STRIPE_WEBHOOK_SECRET", "whsec_123");
	vi.stubEnv("STRIPE_PRICE_TEAM", "price_team");
	vi.stubEnv("NEXT_PUBLIC_APP_URL", "http://localhost:3000");
	vi.stubEnv(TEST_MODE_MARKET_FLAG, flag);
}

beforeEach(() => {
	// getStripeConfig and getStripe both memoize, so every case gets fresh modules.
	vi.resetModules();
	constructedWith.length = 0;
});

afterEach(() => {
	vi.unstubAllEnvs();
});

describe("the key the waiver judges is the key the client is built from", () => {
	it.each([
		["a clean test key", "sk_test_51Example"],
		["a test key with a trailing newline", "sk_test_51Example\n"],
		["a test key padded with spaces", "  sk_test_51Example  "],
		["a live key with a trailing newline", "sk_live_51Example\n"],
	])("%s", async (_label, raw) => {
		hostedEnv(raw, "1");
		const { getStripe } = await import("@/lib/billing/stripe");
		const { testModeMarketOpen } = await import("@/lib/billing/eligibility");

		getStripe();
		expect(constructedWith).toHaveLength(1);
		const clientKey = constructedWith[0] ?? "";

		// The client gets the trimmed value — the same one the seam reads.
		expect(clientKey).toBe(raw.trim());
		// And the waiver's verdict is a statement about THAT key, not about another reading of it.
		expect(testModeMarketOpen()).toBe(clientKey.startsWith("sk_test_"));
	});
});

describe("stripeSecretKey is the one reading", () => {
	it("trims, and answers empty for an unset or blank key", async () => {
		const { stripeSecretKey } = await import("@/lib/billing/stripe-key");
		expect(stripeSecretKey({ STRIPE_SECRET_KEY: " sk_test_1\n" })).toBe("sk_test_1");
		expect(stripeSecretKey({})).toBe("");
		expect(stripeSecretKey({ STRIPE_SECRET_KEY: "  \n" })).toBe("");
	});

	it("a blank key does not count as Stripe being configured", async () => {
		vi.stubEnv("STRIPE_SECRET_KEY", "  \n");
		const { isStripeConfigured } = await import("@/lib/billing/config");
		expect(isStripeConfigured()).toBe(false);
	});

	it("the flag's name can never be inlined into a client bundle", () => {
		// Next inlines only NEXT_PUBLIC_* names (and next.config `env`, which the guard
		// scripts/check-billing-test-market-flag.mjs keeps the name out of). This pins the half of
		// eligibility.ts's JSDoc that a rename could falsify.
		expect(TEST_MODE_MARKET_FLAG.startsWith("NEXT_PUBLIC_")).toBe(false);
	});
});
