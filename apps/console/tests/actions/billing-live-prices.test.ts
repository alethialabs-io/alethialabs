// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The live-price actions behind useLivePlanPrice / useLiveAiPrice. The prices are public, but each
// call is Stripe price reads (react `cache` is per-request only), so an anonymous caller must be
// refused BEFORE Stripe is asked (#5219). Mocks mirror billing-usage.test.ts: `ai-quota` and
// `usage-counts` import `server-only`, which throws under Vitest.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LiveAiPriceMap, LivePlanPrice, LivePlanPriceMap } from "@/lib/billing/pricing";

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
vi.mock("@/lib/billing/pricing", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/billing/pricing")>()),
	getAllPlanPrices: vi.fn(),
	getAllAiPrices: vi.fn(),
}));

import { getLiveAiPrices, getLivePlanPrices } from "@/app/server/actions/billing";
import { currentActor } from "@/lib/authz/guard";
import { getAllAiPrices, getAllPlanPrices } from "@/lib/billing/pricing";

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
		vi.mocked(currentActor).mockResolvedValue({ userId: "user-1", orgId: "user-1" });
		vi.mocked(getAllPlanPrices).mockResolvedValue(PLAN_PRICES);
		await expect(getLivePlanPrices()).resolves.toBe(PLAN_PRICES);
	});
});

describe("getLiveAiPrices", () => {
	it("refuses an anonymous caller without asking Stripe", async () => {
		vi.mocked(currentActor).mockRejectedValue(new Error("Unauthorized"));
		await expect(getLiveAiPrices()).rejects.toThrow("Unauthorized");
		expect(getAllAiPrices).not.toHaveBeenCalled();
	});

	it("returns the AI price map to a signed-in caller", async () => {
		const aiPrices: LiveAiPriceMap = {
			ai_free: price("Free"),
			ai_plus: price("$20 / mo"),
			ai_max: price("$100 / mo"),
		};
		vi.mocked(currentActor).mockResolvedValue({ userId: "user-1", orgId: "user-1" });
		vi.mocked(getAllAiPrices).mockResolvedValue(aiPrices);
		await expect(getLiveAiPrices()).resolves.toBe(aiPrices);
	});
});
