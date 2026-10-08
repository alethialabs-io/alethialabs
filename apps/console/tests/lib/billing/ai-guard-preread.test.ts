// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// assertAiAllowed hands reserveAiHold the plan and the clock it ALREADY read (`{ plan, now }`), so
// its metered gate runs on exactly the values it computed before opening the transaction. Two
// observable consequences, each pinned here against a fake transaction:
//  - the plan is read ONCE, on the pool. Without the preread reserveAiHold reads it again on `tx`,
//    and a plan that differs there decides the gate instead.
//  - the week window is anchored to the OUTER clock. Without the preread reserveAiHold reads
//    Date.now() again, and a turn that straddles the weekly boundary reports the wrong reset.
// The real-Postgres side of reserveAiHold is in tests/integration/ai-hold-tx.test.ts.

import { beforeEach, describe, expect, it, vi } from "vitest";

/** The window sum every ledger/grant read on the fake transaction returns. */
const db = vi.hoisted(() => ({ sum: 0 }));

/** A transaction stand-in: the lock, the window sums and the hold insert, with fixed answers. */
const fakeTx = vi.hoisted(() => ({
	execute: () => Promise.resolve(),
	select: () => ({
		from: () => ({ where: () => Promise.resolve([{ s: String(db.sum) }]) }),
	}),
	insert: () => ({
		values: () => ({ returning: () => Promise.resolve([{ id: "hold-1" }]) }),
	}),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/billing/config", () => ({ isStripeConfigured: () => true }));
vi.mock("@/lib/db", () => ({
	getServiceDb: () => ({
		transaction: (cb: (tx: typeof fakeTx) => Promise<unknown>) => cb(fakeTx),
	}),
}));
vi.mock("@/lib/billing/ai-plan", () => ({
	AI_SESSION_WINDOW_MS: 5 * 3_600_000,
	resolveAiTier: vi.fn(),
	resolveAiPlan: vi.fn(),
	aiTierSpec: vi.fn(),
	effectiveAiTierSpec: vi.fn((s: unknown) => s),
}));
vi.mock("@/lib/billing/ai-quota", () => ({
	sumCredits: vi.fn(() => Promise.resolve(0)),
	sumCreditsForUser: vi.fn(() => Promise.resolve(0)),
	oldestUsageSince: vi.fn(),
	oldestUsageForUserSince: vi.fn(),
	purchasedBalance: vi.fn(),
}));

import { AiBudgetError, assertAiAllowed } from "@/lib/billing/ai-guard";
import { aiTierSpec, resolveAiPlan } from "@/lib/billing/ai-plan";

const WEEK_MS = 7 * 24 * 3_600_000;

/** A plan context for `tier`, with no admin limits and no hard cap. */
const planFor = (tier: "ai_free" | "ai_plus") => ({
	tier,
	hardCap: false,
	orgWeeklyCapCredits: null,
	perUserWeeklyCapCredits: null,
});

beforeEach(() => {
	vi.clearAllMocks();
	vi.restoreAllMocks();
	db.sum = 0;
	// AI is ON for ai_plus only, so a plan read that answers ai_free refuses the turn.
	vi.mocked(aiTierSpec).mockImplementation((tier) => ({
		enabled: tier === "ai_plus",
		advisor: "none",
		sessionCredits: 30,
		weeklyCredits: 100,
		perUserSessionCredits: 10,
		perUserWeeklyCredits: 40,
	}));
});

describe("assertAiAllowed → reserveAiHold preread", () => {
	it("decides the metered gate on the plan it read on the pool — never a second read on tx", async () => {
		// The pooled read answers ai_plus; any further read (on tx) would answer ai_free (AI off).
		vi.mocked(resolveAiPlan)
			.mockResolvedValueOnce(planFor("ai_plus"))
			.mockResolvedValue(planFor("ai_free"));

		const charge = await assertAiAllowed("org-1", "agent", "user-1");

		expect(charge).toEqual({ source: "included", settle: true, holdId: "hold-1" });
		expect(resolveAiPlan).toHaveBeenCalledTimes(1);
		expect(vi.mocked(resolveAiPlan).mock.calls[0]).toEqual(["org-1"]);
	});

	it("anchors the week window to the clock it read BEFORE the transaction", async () => {
		vi.mocked(resolveAiPlan).mockResolvedValue(planFor("ai_plus"));
		db.sum = 1_000; // every window is spent and purchased is 0 → a weekly org refusal
		const boundary = 3_000 * WEEK_MS;
		// The outer read is 1ms before a week boundary; any later read is 1ms after it.
		vi.spyOn(Date, "now")
			.mockReturnValueOnce(boundary - 1)
			.mockReturnValue(boundary + 1);

		const err = await assertAiAllowed("org-1", "agent", "user-1").catch((e: unknown) => e);

		expect(err).toBeInstanceOf(AiBudgetError);
		if (!(err instanceof AiBudgetError)) return;
		expect(err.reason).toBe("weekly");
		// The week that contains the OUTER clock resets exactly at the boundary.
		expect(err.resetAt).toBe(new Date(boundary).toISOString());
	});
});
