// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The live-price action behind useLivePlanPrice. The prices are public, but each call is Stripe
// price reads (react `cache` is per-request only), so an anonymous caller must be refused BEFORE
// Stripe is asked (#5219). The AI price list moved to the read router (`billing.liveAiPrices`,
// #6127), where the route handler refuses an anonymous caller before any procedure runs —
// tests/lib/rpc/billing-procedures.test.ts holds that half. Mocks mirror billing-usage.test.ts: `ai-quota` and
// `usage-counts` import `server-only`, which throws under Vitest.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LivePlanPrice, LivePlanPriceMap } from "@/lib/billing/pricing";

vi.mock("@/lib/authz/guard", () => ({
	currentActor: vi.fn(),
	authorize: vi.fn(),
	authorizeQuiet: vi.fn(),
	authorizeInOrg: vi.fn(),
}));
vi.mock("@/lib/db", () => ({ getServiceDb: vi.fn(() => ({})) }));
vi.mock("@/lib/billing/queries", () => ({ getOrgBilling: vi.fn(), upsertOrgBilling: vi.fn() }));
vi.mock("@/lib/queries/runner-usage", () => ({
	queryJobMinutesByOrg: vi.fn(),
	queryJobMinutesSeries: vi.fn(),
}));
vi.mock("@/lib/queries/usage-counts", () => ({
	queryResourceCounts: vi.fn(),
	queryRunningJobs: vi.fn(),
}));
vi.mock("@/lib/billing/ai-quota", () => ({
	sumCredits: vi.fn(),
	oldestUsageSince: vi.fn(),
	purchasedBalance: vi.fn(),
	aiCreditsSeries: vi.fn(),
}));
// A FULL mock, not an importOriginal() spread. Measured with the partial form: run beside
// tests/lib/billing/ai-pricing.test.ts, the merged coverage of lib/billing/pricing.ts fell from 29
// statements to 0, and the full suite's lib/billing floor went red.
vi.mock("@/lib/billing/pricing", () => ({
	getAllPlanPrices: vi.fn(),
	getAllAiPrices: vi.fn(),
}));

import { getLivePlanPrices } from "@/app/server/actions/billing";
import { currentActor } from "@/lib/authz/guard";
import { getAllPlanPrices } from "@/lib/billing/pricing";

/** A live price with no known amounts — the shape is all these tests pass through. */
const price = (label: string): LivePlanPrice => ({ amounts: {}, currency: "usd", interval: "month", label });

const PLAN_PRICES: LivePlanPriceMap = {
	community: price("Free"),
	team: price("$18 / seat / mo"),
	enterprise: price("Custom"),
};

beforeEach(() => {
	vi.clearAllMocks();
});

describe("getLivePlanPrices", () => {
	it("refuses an anonymous caller without asking Stripe", async () => {
		vi.mocked(currentActor).mockRejectedValue(new Error("Unauthorized"));
		await expect(getLivePlanPrices()).rejects.toThrow("Unauthorized");
		expect(getAllPlanPrices).not.toHaveBeenCalled();
	});

	it("returns the price map to a signed-in caller", async () => {
		vi.mocked(currentActor).mockResolvedValue({ credential: "session", userId: "user-1", orgId: "user-1" });
		vi.mocked(getAllPlanPrices).mockResolvedValue(PLAN_PRICES);
		await expect(getLivePlanPrices()).resolves.toBe(PLAN_PRICES);
	});
});
