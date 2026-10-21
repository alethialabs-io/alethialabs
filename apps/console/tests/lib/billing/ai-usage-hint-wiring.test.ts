// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #6127: the `usage` hint is sent AFTER the AI hold's transaction has finished — never from inside
// the transaction that holds the org's AI-budget lock — and only when a hold was actually written.
// A refusal writes nothing and announces nothing.

import { beforeEach, describe, expect, it, vi } from "vitest";

const events = vi.hoisted(() => ({ log: [] as string[], sum: 0 }));

/** A transaction stand-in that records when its body runs and when it has finished. */
const fakeTx = vi.hoisted(() => ({
	execute: () => {
		events.log.push("tx:lock");
		return Promise.resolve();
	},
	select: () => ({
		from: () => ({ where: () => Promise.resolve([{ s: String(events.sum) }]) }),
	}),
	insert: () => ({
		values: () => ({
			returning: () => {
				events.log.push("tx:insert-hold");
				return Promise.resolve([{ id: "hold-1" }]);
			},
		}),
	}),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/billing/config", () => ({ isStripeConfigured: () => true }));
vi.mock("@/lib/db", () => ({
	getServiceDb: () => ({
		transaction: async (cb: (tx: typeof fakeTx) => Promise<unknown>) => {
			const out = await cb(fakeTx);
			events.log.push("tx:commit");
			return out;
		},
	}),
}));
vi.mock("@/lib/realtime/usage-hint", () => ({
	emitUsageHint: (orgId: string) => events.log.push(`hint:${orgId}`),
}));
vi.mock("@/lib/billing/ai-plan", () => ({
	AI_SESSION_WINDOW_MS: 5 * 3_600_000,
	resolveAiTier: vi.fn(),
	resolveAiPlan: vi.fn(async () => ({
		tier: "ai_plus",
		hardCap: true,
		orgWeeklyCapCredits: null,
		perUserWeeklyCapCredits: null,
	})),
	aiTierSpec: vi.fn(() => ({
		enabled: true,
		advisor: "none",
		sessionCredits: 30,
		weeklyCredits: 100,
		perUserSessionCredits: 10,
		perUserWeeklyCredits: 40,
	})),
	effectiveAiTierSpec: vi.fn((s: unknown) => s),
}));
vi.mock("@/lib/billing/ai-quota", () => ({
	sumCredits: vi.fn(() => Promise.resolve(0)),
	sumCreditsForUser: vi.fn(() => Promise.resolve(0)),
	oldestUsageSince: vi.fn(() => Promise.resolve(null)),
	oldestUsageForUserSince: vi.fn(() => Promise.resolve(null)),
	purchasedBalance: vi.fn(() => Promise.resolve(0)),
}));

import { assertAiAllowed } from "@/lib/billing/ai-guard";

beforeEach(() => {
	events.log = [];
	events.sum = 0;
});

describe("assertAiAllowed announces AI spend after the commit", () => {
	it("sends the usage hint once the hold's transaction has committed — not inside it", async () => {
		await assertAiAllowed("org-1", "agent", "user-1");
		expect(events.log).toEqual(["tx:lock", "tx:insert-hold", "tx:commit", "hint:org-1"]);
	});

	it("a refused turn writes no hold and sends no hint", async () => {
		events.sum = 1_000; // every window spent, hard cap on → refused
		await expect(assertAiAllowed("org-1", "agent", "user-1")).rejects.toThrow();
		expect(events.log.some((e) => e.startsWith("hint:"))).toBe(false);
	});
});
