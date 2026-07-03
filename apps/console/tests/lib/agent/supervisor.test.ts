// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The supervisor's deterministic control flow — delegation, ledger tracking, and the
// stall→re-plan loop — tested with an injected (fake) sub-agent runner so no model is
// needed. Mirrors how RunRemediationLoop is tested.

import { describe, expect, it } from "vitest";
import {
	type SubAgentRunner,
	type Task,
	runSupervisor,
} from "@/lib/agent/supervisor";

function tasks(...ids: string[]): Task[] {
	return ids.map((id) => ({ id, objective: `do ${id}`, status: "pending" }));
}

describe("runSupervisor", () => {
	it("completes all tasks when the runner succeeds", async () => {
		const run: SubAgentRunner = async (t) => ({ ok: true, result: `${t.id} ok`, facts: [t.id] });
		const res = await runSupervisor(tasks("a", "b", "c"), run);
		expect(res.completed.map((t) => t.id)).toEqual(["a", "b", "c"]);
		expect(res.failed).toHaveLength(0);
		expect(res.ledger.facts).toEqual(["a", "b", "c"]);
	});

	it("resets the stall counter on a success", async () => {
		const seq = [false, true, false]; // fail, succeed, fail
		let i = 0;
		const run: SubAgentRunner = async () => ({ ok: seq[i++] ?? false, result: "x" });
		const res = await runSupervisor(tasks("a", "b", "c"), run, { maxStall: 2 });
		// One success in the middle keeps stall from ever exceeding 2 → no re-plan.
		expect(res.replans).toBe(0);
	});

	it("re-plans when consecutive failures exceed maxStall", async () => {
		const run: SubAgentRunner = async () => ({ ok: false, result: "always fails" });
		const res = await runSupervisor(tasks("a", "b", "c", "d"), run, {
			maxStall: 2,
			maxRounds: 20,
		});
		// 3 consecutive failures (stall>2) triggers at least one re-plan.
		expect(res.replans).toBeGreaterThanOrEqual(1);
		expect(res.completed).toHaveLength(0);
	});

	it("always terminates (bounded by maxRounds) even if the runner never succeeds", async () => {
		const run: SubAgentRunner = async () => ({ ok: false, result: "no" });
		const res = await runSupervisor(tasks("a", "b"), run, { maxRounds: 5 });
		expect(res.completed.length + res.failed.length).toBeGreaterThan(0);
	});

	it("accumulates facts from sub-agent runs onto the ledger", async () => {
		const run: SubAgentRunner = async (t) => ({
			ok: true,
			result: "ok",
			facts: [`fact:${t.id}`],
		});
		const res = await runSupervisor(tasks("x", "y"), run);
		expect(res.ledger.facts).toEqual(["fact:x", "fact:y"]);
	});

	it("honours a custom re-plan hook", async () => {
		let replanned = false;
		const run: SubAgentRunner = async () => ({ ok: false, result: "fail" });
		await runSupervisor(tasks("a", "b", "c"), run, {
			maxStall: 1,
			maxRounds: 10,
			replan: (ledger) => {
				replanned = true;
				// prune to nothing so the loop ends deterministically
				ledger.plan = [];
			},
		});
		expect(replanned).toBe(true);
	});
});
