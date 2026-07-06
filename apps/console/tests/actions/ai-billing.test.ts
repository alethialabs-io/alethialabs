// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Mocked-boundary test for getAiUsage: stub the actor + ledger reads, keep the plan/entitlement
// math real, and assert the proportions/tier the AI usage surface shows.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OrganizationBilling } from "@/lib/db/schema";

vi.mock("@/lib/authz/guard", () => ({ currentActor: vi.fn() }));
vi.mock("@/lib/billing/ai-quota", () => ({
	sumCredits: vi.fn(),
	purchasedBalance: vi.fn(),
}));
vi.mock("@/lib/billing/queries", () => ({ getOrgBilling: vi.fn() }));

import { getAiUsage } from "@/app/server/actions/ai-billing";
import { currentActor } from "@/lib/authz/guard";
import { purchasedBalance, sumCredits } from "@/lib/billing/ai-quota";
import { getOrgBilling } from "@/lib/billing/queries";

const ORIGINAL_KEY = process.env.STRIPE_SECRET_KEY;
beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(currentActor).mockResolvedValue({ orgId: "org-1", userId: "user-1" } as never);
	vi.mocked(purchasedBalance).mockResolvedValue(0);
});
afterEach(() => {
	if (ORIGINAL_KEY === undefined) delete process.env.STRIPE_SECRET_KEY;
	else process.env.STRIPE_SECRET_KEY = ORIGINAL_KEY;
});

describe("getAiUsage", () => {
	it("uses community AI entitlements when the org has no billing", async () => {
		vi.mocked(getOrgBilling).mockResolvedValue(null);
		vi.mocked(sumCredits).mockResolvedValue(0);

		const r = await getAiUsage();
		expect(r.tier).toBe("trial"); // community AI tier
		expect(r.enabled).toBe(true);
		expect(r.windowPctUsed).toBe(0);
		expect(r.weekPctUsed).toBe(0);
	});

	it("computes window/week proportions and caps at 100", async () => {
		vi.mocked(getOrgBilling).mockResolvedValue({ plan: "team", status: "active" } as OrganizationBilling);
		// Team window cap is 300, weekly 3000. Return more than the window cap → caps at 100.
		vi.mocked(sumCredits).mockResolvedValue(600);
		vi.mocked(purchasedBalance).mockResolvedValue(250);

		const r = await getAiUsage();
		expect(r.tier).toBe("standard");
		expect(r.windowPctUsed).toBe(100); // 600/300 → capped
		expect(r.weekPctUsed).toBe(20); // 600/3000
		expect(r.purchasedBalance).toBe(250);
		// Reset timestamps are valid ISO strings in the future.
		expect(new Date(r.windowResetAt).getTime()).toBeGreaterThan(Date.now());
		expect(new Date(r.weekResetAt).getTime()).toBeGreaterThan(Date.now());
	});

	it("reflects whether hosted billing is configured", async () => {
		vi.mocked(getOrgBilling).mockResolvedValue(null);
		vi.mocked(sumCredits).mockResolvedValue(0);
		process.env.STRIPE_SECRET_KEY = "sk_test_123";
		expect((await getAiUsage()).hosted).toBe(true);
	});
});
