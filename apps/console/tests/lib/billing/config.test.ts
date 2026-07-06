// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// getStripeConfig() memoizes, so each config-reading test resets the module registry and
// re-imports with a fresh env. The env-branch helpers read process.env live (no reset needed).
const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
	vi.resetModules();
});
afterEach(() => {
	process.env = { ...ORIGINAL_ENV };
});

describe("deployment + feature flags", () => {
	it("deploymentMode is hosted only when explicitly set", async () => {
		process.env.ALETHIA_DEPLOYMENT_MODE = "hosted";
		const { deploymentMode } = await import("@/lib/billing/config");
		expect(deploymentMode()).toBe("hosted");
	});

	it("deploymentMode defaults to self-managed", async () => {
		delete process.env.ALETHIA_DEPLOYMENT_MODE;
		const { deploymentMode } = await import("@/lib/billing/config");
		expect(deploymentMode()).toBe("self-managed");
	});

	it("isStripeConfigured reflects the secret key presence", async () => {
		process.env.STRIPE_SECRET_KEY = "sk_test_123";
		const a = await import("@/lib/billing/config");
		expect(a.isStripeConfigured()).toBe(true);

		vi.resetModules();
		delete process.env.STRIPE_SECRET_KEY;
		const b = await import("@/lib/billing/config");
		expect(b.isStripeConfigured()).toBe(false);
	});

	it("isStripeTaxEnabled requires the literal string 'true'", async () => {
		process.env.STRIPE_TAX_ENABLED = "true";
		const a = await import("@/lib/billing/config");
		expect(a.isStripeTaxEnabled()).toBe(true);

		vi.resetModules();
		process.env.STRIPE_TAX_ENABLED = "1";
		const b = await import("@/lib/billing/config");
		expect(b.isStripeTaxEnabled()).toBe(false);
	});
});

describe("price ↔ plan resolution", () => {
	beforeEach(() => {
		process.env.STRIPE_SECRET_KEY = "sk_test_123";
		process.env.STRIPE_WEBHOOK_SECRET = "whsec_123";
		process.env.STRIPE_PRICE_TEAM = "price_team";
		process.env.STRIPE_PRICE_ENTERPRISE = "price_ent";
		process.env.NEXT_PUBLIC_APP_URL = "http://localhost:3000";
	});

	it("priceIdForPlan returns the configured price", async () => {
		const { priceIdForPlan } = await import("@/lib/billing/config");
		expect(priceIdForPlan("team")).toBe("price_team");
	});

	it("planForPriceId is the inverse of priceIdForPlan", async () => {
		const { planForPriceId } = await import("@/lib/billing/config");
		expect(planForPriceId("price_team")).toBe("team");
		expect(planForPriceId("price_ent")).toBe("enterprise");
		expect(planForPriceId("price_unknown")).toBeNull();
	});

	it("priceIdForPlan throws for a plan with no configured price", async () => {
		delete process.env.STRIPE_PRICE_ENTERPRISE;
		vi.resetModules();
		const { priceIdForPlan } = await import("@/lib/billing/config");
		expect(() => priceIdForPlan("enterprise")).toThrow(/No Stripe price/);
	});

	it("getStripeConfig throws when required keys are missing", async () => {
		delete process.env.STRIPE_PRICE_TEAM;
		vi.resetModules();
		const { getStripeConfig } = await import("@/lib/billing/config");
		expect(() => getStripeConfig()).toThrow(/Invalid Stripe config/);
	});
});
