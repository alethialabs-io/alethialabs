// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The colony's fan-out is bounded, and the bound is not derived from the thing it bounds (#2698).
//
// `runColonyTasks` is a `"use server"` export reserving ONE provisional budget hold for the whole
// run. Before the cap, the number of model calls that hold paid for was chosen by the CALLER:
// `runSupervisor` derives `maxRounds` as `initialTasks.length * 3` when none is passed, so the
// ceiling was computed from the very array it was supposed to bound.
//
// These tests assert the two guarantees separately, because they fail in different ways:
//   1. an over-long objective list is REFUSED, not truncated
//   2. an accepted list runs under an EXPLICIT maxRounds, never the derived default
//
// The model boundary is mocked; nothing here needs a key, a database, or a network.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/authz/guard", () => ({ currentActor: vi.fn() }));
vi.mock("@/lib/config/ai", () => ({ getAiModel: vi.fn(), isAiConfigured: vi.fn() }));
vi.mock("@/lib/billing/ai-guard", () => ({
	assertAiAllowed: vi.fn(),
	AiBudgetError: class AiBudgetError extends Error {},
}));
vi.mock("@/lib/billing/ai-quota", () => ({
	recordAiUsage: vi.fn(async () => {}),
	meteringFailed: vi.fn(() => () => {}),
}));
vi.mock("@/lib/agent/llm-subagent", () => ({ createLlmSubAgentRunner: vi.fn(() => async () => ({ ok: true, result: "done" })) }));
vi.mock("@/lib/agent/supervisor", () => ({ runSupervisor: vi.fn() }));
vi.mock("ai", () => ({ generateText: vi.fn(async () => ({ text: "", usage: {} })) }));

import { runColonyTasks } from "@/app/server/actions/colony";
import { runSupervisor } from "@/lib/agent/supervisor";
import { assertAiAllowed } from "@/lib/billing/ai-guard";
import { currentActor } from "@/lib/authz/guard";
import { getAiModel, isAiConfigured } from "@/lib/config/ai";

/** The cap the action enforces. Mirrored here so a change to it must be a deliberate, visible edit. */
const MAX = 8;

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(currentActor).mockResolvedValue({ userId: "u1", orgId: "o1" } as never);
	vi.mocked(isAiConfigured).mockReturnValue(true);
	vi.mocked(getAiModel).mockReturnValue({ key: "test", model: {} } as never);
	vi.mocked(assertAiAllowed).mockResolvedValue({ settle: true, holdId: "h1", source: "metered" } as never);
	vi.mocked(runSupervisor).mockResolvedValue({ completed: [], failed: [], replans: 0, ledger: {} } as never);
});

const objectives = (n: number) => Array.from({ length: n }, (_, i) => `survey ${i}`);

describe("runColonyTasks fan-out", () => {
	it("refuses more objectives than one metered turn can reach", async () => {
		await expect(runColonyTasks(objectives(MAX + 1))).rejects.toThrow(/at most 8 objectives/);
	});

	it("refuses a very large list — the shape that bought 600 model calls on one hold", async () => {
		await expect(runColonyTasks(objectives(200))).rejects.toThrow(/at most 8 objectives/);
	});

	// REFUSED, NOT TRUNCATED. Running 8 of 20 and returning a result shaped like a complete one is
	// the failure this cap exists to avoid — the caller cannot tell a full answer from a partial.
	it("does not silently truncate: an over-long list never reaches the supervisor", async () => {
		await expect(runColonyTasks(objectives(20))).rejects.toThrow();
		expect(runSupervisor).not.toHaveBeenCalled();
	});

	// And it must not have SPENT anything either — a refusal after the hold is taken would leak the
	// reservation on every rejected call.
	it("...and takes no budget hold when it refuses", async () => {
		await expect(runColonyTasks(objectives(20))).rejects.toThrow();
		expect(assertAiAllowed).not.toHaveBeenCalled();
	});

	it("accepts a list at the cap", async () => {
		await expect(runColonyTasks(objectives(MAX))).resolves.toBeDefined();
		expect(runSupervisor).toHaveBeenCalledOnce();
	});

	// THE REGRESSION. Passing no `maxRounds` lets the supervisor derive `tasks.length * 3` — the
	// ceiling computed from the input it is meant to bound.
	it("passes an EXPLICIT maxRounds rather than letting the supervisor derive one", async () => {
		await runColonyTasks(objectives(3));
		const opts = vi.mocked(runSupervisor).mock.calls[0][2];
		expect(opts?.maxRounds).toBe(MAX);
	});

	it("...and the bound does not grow with the objective count", async () => {
		await runColonyTasks(objectives(1));
		const small = vi.mocked(runSupervisor).mock.calls[0][2]?.maxRounds;
		vi.mocked(runSupervisor).mockClear();
		await runColonyTasks(objectives(MAX));
		const large = vi.mocked(runSupervisor).mock.calls[0][2]?.maxRounds;
		// BOTH must be real numbers before their equality means anything. Asserting only
		// `small === large` passes when the option is omitted entirely and both read `undefined` —
		// which is precisely the unfixed behaviour this test exists to reject. (Checked: without
		// these two lines this assertion goes green against the derived-maxRounds code.)
		expect(small).toBe(MAX);
		expect(large).toBe(MAX);
		expect(small).toBe(large);
	});

	// The pre-existing contract, kept: an empty list is still refused, and for its own reason.
	it("still refuses an empty list", async () => {
		await expect(runColonyTasks([])).rejects.toThrow(/at least one objective/);
	});
});
