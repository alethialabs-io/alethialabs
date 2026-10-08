// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// recordAgentTurnUsage's two additions for ADR 0003 slice 3 (§8.1, §5.3):
//  - `floorCredits`: the least the ATTEMPT costs. It is compared with the SUM of the attempt's
//    rows (row 0, the hold, plus every appended model row), and a shortfall raises row 0 alone, so
//    the attempt costs max(floor, total) however a multi-model turn spreads its cost.
//  - `tx`: every row is written on the caller's transaction, and the side effects of every row are
//    returned as ONE after-commit function instead of running.
// recordAiUsage is mocked; its own tx behaviour is pinned in ai-quota-tx.test.ts. aiCostMicros is
// mocked to fixed per-model costs (the real costToCredits turns them into credits) so the floor
// arithmetic is legible; tests/integration/ai-hold-tx.test.ts checks the floor against real rows.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/billing/ai-quota", () => ({ recordAiUsage: vi.fn() }));
vi.mock("@/lib/billing/model-costs", () => ({ aiCostMicros: vi.fn() }));

import { recordAgentTurnUsage } from "@/lib/billing/agent-metering";
import { recordAiUsage } from "@/lib/billing/ai-quota";
import { aiCostMicros } from "@/lib/billing/model-costs";
import type { Tx } from "@/lib/db";

const HAIKU = "anthropic/claude-haiku-4-5";
const SONNET = "anthropic/claude-sonnet-4-6";

/** Per-model cost for these tests, in USD micros: Sonnet rows settle 30 credits, Haiku rows 20. */
const MICROS: Record<string, number> = { [SONNET]: 30_000, [HAIKU]: 20_000 };

const SETTLE = { source: "included" as const, settle: true as const, holdId: "hold-1" };

/** A two-model attempt: row 0 (Sonnet, 30) + one appended row (Haiku, 20) → total 50. */
const TWO_MODEL_STEPS = [
	{ model: SONNET, usage: { inputTokens: 100, outputTokens: 40 } },
	{ model: HAIKU, usage: { inputTokens: 300, outputTokens: 80 } },
];

/** The `credits` recordAiUsage was called with for row `i` of this call. */
function creditsOfRow(i: number): number | undefined {
	return vi.mocked(recordAiUsage).mock.calls[i][0].credits;
}

/** A transaction stand-in: recordAgentTurnUsage only forwards it, never calls it. */
const TX = {} as unknown as Tx;

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(recordAiUsage).mockResolvedValue(() => {});
	vi.mocked(aiCostMicros).mockImplementation((u) => MICROS[u.model] ?? 0);
});

describe("recordAgentTurnUsage — floorCredits against the attempt's SUM", () => {
	it("raises row 0 by the shortfall of the WHOLE attempt (multi-row): 30 + 20 under a floor of 100", async () => {
		await recordAgentTurnUsage({
			orgId: "org-1",
			userId: "user-1",
			kind: "agent",
			charge: SETTLE,
			steps: TWO_MODEL_STEPS,
			floorCredits: 100,
		});
		expect(recordAiUsage).toHaveBeenCalledTimes(2);
		// Row 0 books 30 + (100 - 50) = 80; the appended row keeps deriving its own 20.
		expect(creditsOfRow(0)).toBe(80);
		expect(creditsOfRow(1)).toBeUndefined();
		expect(vi.mocked(recordAiUsage).mock.calls[0][0].holdId).toBe("hold-1");
	});

	it("does NOT raise row 0 when the sum already meets the floor, though row 0 alone is below it", async () => {
		// Row 0 costs 30 < floor 40, but 30 + 20 = 50 ≥ 40: the attempt is above its floor.
		await recordAgentTurnUsage({
			orgId: "org-1",
			userId: "user-1",
			kind: "agent",
			charge: SETTLE,
			steps: TWO_MODEL_STEPS,
			floorCredits: 40,
		});
		expect(creditsOfRow(0)).toBeUndefined();
		expect(creditsOfRow(1)).toBeUndefined();
	});

	it("settles an attempt with NO completed step AT the floor (the hold is its only row)", async () => {
		await recordAgentTurnUsage({
			orgId: "org-1",
			userId: "user-1",
			kind: "agent",
			charge: SETTLE,
			refId: "thread-1",
			steps: [],
			floorCredits: 100,
		});
		expect(recordAiUsage).toHaveBeenCalledTimes(1);
		expect(recordAiUsage).toHaveBeenCalledWith({
			orgId: "org-1",
			userId: "user-1",
			kind: "agent",
			source: "included",
			refId: "thread-1",
			holdId: "hold-1",
			credits: 100,
		});
	});

	it("a fixed charge counts its booked credits toward the sum (row 0 = charge + shortfall)", async () => {
		await recordAgentTurnUsage({
			orgId: "org-1",
			userId: "user-1",
			kind: "agent",
			charge: { source: "included", credits: 10 },
			steps: TWO_MODEL_STEPS,
			floorCredits: 25,
		});
		// Fixed rows book 10 and 0 → total 10; row 0 is raised to 10 + 15 = 25.
		expect(creditsOfRow(0)).toBe(25);
		expect(creditsOfRow(1)).toBe(0);
	});

	it("a floor of 0 or none changes nothing: settle rows still omit credits", async () => {
		await recordAgentTurnUsage({
			orgId: "org-1",
			userId: "user-1",
			kind: "agent",
			charge: SETTLE,
			steps: TWO_MODEL_STEPS,
			floorCredits: 0,
		});
		expect(creditsOfRow(0)).toBeUndefined();
		expect(creditsOfRow(1)).toBeUndefined();
		expect(aiCostMicros).not.toHaveBeenCalled();
	});

	it("refuses a floor that is not a non-negative integer, before writing anything", async () => {
		for (const floorCredits of [-1, 1.5, Number.NaN]) {
			await expect(
				recordAgentTurnUsage({
					orgId: "org-1",
					userId: "user-1",
					kind: "agent",
					charge: SETTLE,
					steps: TWO_MODEL_STEPS,
					floorCredits,
				}),
			).rejects.toThrow(/floorCredits/);
		}
		expect(recordAiUsage).not.toHaveBeenCalled();
	});
});

describe("recordAgentTurnUsage — on a caller's tx", () => {
	it("passes the tx to EVERY row's write", async () => {
		await recordAgentTurnUsage(
			{
				orgId: "org-1",
				userId: "user-1",
				kind: "agent",
				charge: SETTLE,
				steps: TWO_MODEL_STEPS,
			},
			TX,
		);
		expect(recordAiUsage).toHaveBeenCalledTimes(2);
		for (const call of vi.mocked(recordAiUsage).mock.calls) {
			expect(call[1]).toBe(TX);
		}
	});

	it("passes the tx to the release of an empty turn's hold", async () => {
		await recordAgentTurnUsage(
			{ orgId: "org-1", userId: "user-1", kind: "agent", charge: SETTLE, steps: [] },
			TX,
		);
		expect(vi.mocked(recordAiUsage).mock.calls[0][1]).toBe(TX);
	});

	it("returns ONE after-commit that runs every row's side effects, and runs none itself", async () => {
		const row0 = vi.fn();
		const row1 = vi.fn();
		vi.mocked(recordAiUsage).mockResolvedValueOnce(row0).mockResolvedValueOnce(row1);
		const afterCommit = await recordAgentTurnUsage(
			{
				orgId: "org-1",
				userId: "user-1",
				kind: "agent",
				charge: SETTLE,
				steps: TWO_MODEL_STEPS,
			},
			TX,
		);
		expect(row0).not.toHaveBeenCalled();
		expect(row1).not.toHaveBeenCalled();
		afterCommit();
		expect(row0).toHaveBeenCalledTimes(1);
		expect(row1).toHaveBeenCalledTimes(1);
	});

	it("without a tx, calls recordAiUsage with ONE argument (the pooled call, unchanged) and returns a no-op", async () => {
		const rowEffects = vi.fn();
		vi.mocked(recordAiUsage).mockResolvedValue(rowEffects);
		const afterCommit = await recordAgentTurnUsage({
			orgId: "org-1",
			userId: "user-1",
			kind: "agent",
			charge: SETTLE,
			steps: TWO_MODEL_STEPS,
		});
		for (const call of vi.mocked(recordAiUsage).mock.calls) {
			expect(call).toHaveLength(1);
		}
		afterCommit();
		expect(rowEffects).not.toHaveBeenCalled();
	});
});
