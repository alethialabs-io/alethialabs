// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The free AI pool (lib/abuse/free-ai-pool.ts, REL-L11 #6912): the operator's kill switch, the
// global daily ceiling read from the typed table, the per-process cache, and the two platform
// alerts (fail-open, ceiling reached). Here the read is injected so each decision is pinned on its
// own. Which organizations the count includes is `sumFreeAiPoolUsed` (pinned below, #7348); the
// per-organization SQL around it is NOT executed by any test in this repo — ai-guard.test.ts mocks
// `readFreeAiPoolUsed` too.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({
	getServiceDb: () => {
		throw new Error("no pooled read in a unit test");
	},
}));
vi.mock("@/lib/abuse/platform-alert", () => ({
	COST_GUARD_FAILED_OPEN_EVENT: "system.platform.cost_guard_failed_open",
	FREE_AI_PAUSED_EVENT: "system.platform.free_ai_paused",
	raisePlatformAbuseAlert: vi.fn(() => true),
}));

import { raisePlatformAbuseAlert } from "@/lib/abuse/platform-alert";
import { ABUSE_LIMITS } from "@/lib/abuse/limits";
import {
	decideFreeAiPool,
	FREE_AI_POOL_CACHE_MS,
	freeAiPoolState,
	isFreeAiSwitchedOff,
	resetFreeAiPoolCache,
	sumFreeAiPoolUsed,
	utcDayStart,
} from "@/lib/abuse/free-ai-pool";
import type { AiTierBillingFields } from "@/lib/billing/ai-plan";

/** 2026-11-21 15:30 UTC, and the midnight that ends that day. */
const NOW = Date.UTC(2026, 10, 21, 15, 30);
const NEXT_MIDNIGHT = "2026-11-22T00:00:00.000Z";
const CEILING = ABUSE_LIMITS.free_ai_global_daily_credits.defaultValue;

beforeEach(() => {
	vi.clearAllMocks();
	resetFreeAiPoolCache();
});

describe("isFreeAiSwitchedOff", () => {
	it.each(["1", "true", "TRUE", " on ", "yes"])("treats %j as on", (v) => {
		expect(isFreeAiSwitchedOff({ ALETHIA_FREE_AI_PAUSED: v })).toBe(true);
	});

	it.each([undefined, "", "0", "false", "off", "no", "paused"])("treats %j as off", (v) => {
		expect(isFreeAiSwitchedOff({ ALETHIA_FREE_AI_PAUSED: v })).toBe(false);
	});
});

describe("decideFreeAiPool", () => {
	it("the switch pauses with no reset time, whatever the count", () => {
		expect(decideFreeAiPool({ switchedOff: true, used: 0, ceiling: 10, now: NOW })).toEqual({
			open: false,
			cause: "switch",
			resetAt: null,
		});
	});

	it("is open below the ceiling and paused until the next UTC midnight at it", () => {
		expect(decideFreeAiPool({ switchedOff: false, used: 9, ceiling: 10, now: NOW })).toEqual({ open: true });
		expect(decideFreeAiPool({ switchedOff: false, used: 10, ceiling: 10, now: NOW })).toEqual({
			open: false,
			cause: "ceiling",
			resetAt: NEXT_MIDNIGHT,
		});
	});

	it("an unreadable count is open (fail-open)", () => {
		expect(decideFreeAiPool({ switchedOff: false, used: null, ceiling: 10, now: NOW })).toEqual({ open: true });
	});

	it("utcDayStart is 00:00 UTC of the same day", () => {
		expect(utcDayStart(NOW).toISOString()).toBe("2026-11-21T00:00:00.000Z");
	});
});

describe("freeAiPoolState", () => {
	it("the kill switch pauses without reading the count, so it works with the database down", async () => {
		const read = vi.fn(async () => 0);
		const state = await freeAiPoolState({ now: NOW, read, env: { ALETHIA_FREE_AI_PAUSED: "1" } });
		expect(state).toEqual({ open: false, cause: "switch", resetAt: null });
		expect(read).not.toHaveBeenCalled();
		expect(raisePlatformAbuseAlert).not.toHaveBeenCalled();
	});

	it("counts from 00:00 UTC and is open below the table's default ceiling", async () => {
		const read = vi.fn(async () => CEILING - 1);
		expect(await freeAiPoolState({ now: NOW, read, env: {} })).toEqual({ open: true });
		expect(read).toHaveBeenCalledWith(new Date("2026-11-21T00:00:00.000Z"));
	});

	it("pauses at the default ceiling and raises the ceiling alert once per UTC day", async () => {
		const read = vi.fn(async () => CEILING);
		const first = await freeAiPoolState({ now: NOW, read, env: {} });
		expect(first).toEqual({ open: false, cause: "ceiling", resetAt: NEXT_MIDNIGHT });
		await freeAiPoolState({ now: NOW + 60_000, read, env: {} });
		expect(raisePlatformAbuseAlert).toHaveBeenCalledTimes(1);
		expect(vi.mocked(raisePlatformAbuseAlert).mock.calls[0]?.[0]).toMatchObject({
			event: "system.platform.free_ai_paused",
			subject: "free_ai_pool",
		});
	});

	it("reads the ceiling's env override (a second value, so the default is not what decides)", async () => {
		const read = vi.fn(async () => 600);
		const env = { ALETHIA_FREE_AI_GLOBAL_DAILY_CREDITS: "500" };
		expect(await freeAiPoolState({ now: NOW, read, env })).toMatchObject({ open: false, cause: "ceiling" });
		resetFreeAiPoolCache();
		expect(await freeAiPoolState({ now: NOW, read, env: { ALETHIA_FREE_AI_GLOBAL_DAILY_CREDITS: "700" } })).toEqual({
			open: true,
		});
	});

	it("reuses an open count within the cache window and re-reads after it", async () => {
		const read = vi.fn(async () => 10);
		await freeAiPoolState({ now: NOW, read, env: {} });
		await freeAiPoolState({ now: NOW + FREE_AI_POOL_CACHE_MS - 1, read, env: {} });
		expect(read).toHaveBeenCalledTimes(1);
		await freeAiPoolState({ now: NOW + FREE_AI_POOL_CACHE_MS, read, env: {} });
		expect(read).toHaveBeenCalledTimes(2);
	});

	it("a spent pool stays spent for the rest of the day without re-reading, and reopens the next day", async () => {
		const read = vi.fn(async () => CEILING);
		await freeAiPoolState({ now: NOW, read, env: {} });
		const later = await freeAiPoolState({ now: NOW + 3 * 3_600_000, read, env: {} });
		expect(later).toMatchObject({ open: false, cause: "ceiling" });
		expect(read).toHaveBeenCalledTimes(1);

		read.mockResolvedValue(0);
		const tomorrow = await freeAiPoolState({ now: NOW + 9 * 3_600_000, read, env: {} });
		expect(tomorrow).toEqual({ open: true });
		expect(read).toHaveBeenCalledTimes(2);
	});

	it("fails open on a count error and raises the fail-open platform alert", async () => {
		const read = vi.fn(async () => {
			throw new Error("connection refused");
		});
		expect(await freeAiPoolState({ now: NOW, read, env: {} })).toEqual({ open: true });
		expect(raisePlatformAbuseAlert).toHaveBeenCalledTimes(1);
		const alert = vi.mocked(raisePlatformAbuseAlert).mock.calls[0]?.[0];
		expect(alert).toMatchObject({
			event: "system.platform.cost_guard_failed_open",
			subject: "free_ai_pool",
			severity: "critical",
		});
		expect(alert?.summary).toContain("connection refused");
	});
});

describe("sumFreeAiPoolUsed — who counts as free is billingAiTier's answer (#7348)", () => {
	const at = new Date(NOW);
	const dayAgo = new Date(NOW - 24 * 3_600_000);
	const dayAhead = new Date(NOW + 24 * 3_600_000);

	/** A billing row with a live paid AI tier; override what the case is about. */
	const billing = (over: Partial<AiTierBillingFields> = {}): AiTierBillingFields => ({
		aiTier: "ai_plus",
		aiSubscriptionStatus: "active",
		aiStripeSubscriptionId: null,
		aiPaddleSubscriptionId: null,
		stripeSubscriptionId: null,
		paddleSubscriptionId: null,
		currentPeriodEnd: null,
		...over,
	});

	it("counts an EXPIRED off-Stripe AI grant as free", () => {
		expect(sumFreeAiPoolUsed([{ credits: "40", billing: billing({ currentPeriodEnd: dayAgo }) }], at)).toBe(40);
	});

	it("does not count an off-Stripe AI grant still inside its term, or an open-ended one", () => {
		expect(
			sumFreeAiPoolUsed(
				[
					{ credits: "40", billing: billing({ currentPeriodEnd: dayAhead }) },
					{ credits: "7", billing: billing({ currentPeriodEnd: null }) },
				],
				at,
			),
		).toBe(0);
	});

	it("never lapses a Stripe-backed AI tier on the term end (the webhook owns its status)", () => {
		const row = billing({ aiStripeSubscriptionId: "sub_ai", currentPeriodEnd: dayAgo });
		expect(sumFreeAiPoolUsed([{ credits: "40", billing: row }], at)).toBe(0);
	});

	it("counts no billing row, ai_free, and a lapsed paid subscription; sums them", () => {
		expect(
			sumFreeAiPoolUsed(
				[
					{ credits: "5", billing: null },
					{ credits: 6, billing: billing({ aiTier: "ai_free" }) },
					{ credits: "7", billing: billing({ aiStripeSubscriptionId: "sub_ai", aiSubscriptionStatus: "canceled" }) },
					{ credits: null, billing: null },
				],
				at,
			),
		).toBe(18);
	});
});
