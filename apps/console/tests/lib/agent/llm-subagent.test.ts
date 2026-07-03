// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import {
	buildSubAgentPrompt,
	createLlmSubAgentRunner,
	parseSubAgentResult,
} from "@/lib/agent/llm-subagent";
import { runSupervisor, type Task } from "@/lib/agent/supervisor";

const ledger = { facts: ["region=eu-central-1"], plan: [], tasks: [], stall: 0, replans: 0 };
const task: Task = { id: "t1", objective: "audit prod IAM", status: "pending" };

describe("buildSubAgentPrompt", () => {
	it("includes the objective and ledger facts", () => {
		const p = buildSubAgentPrompt(task, ledger);
		expect(p).toContain("audit prod IAM");
		expect(p).toContain("region=eu-central-1");
		expect(p).toMatch(/JSON/);
	});
});

describe("parseSubAgentResult", () => {
	it("parses a structured success", () => {
		const r = parseSubAgentResult('{"ok":true,"result":"clean","facts":["no admin roles"]}');
		expect(r).toEqual({ ok: true, result: "clean", facts: ["no admin roles"] });
	});

	it("treats unparseable output as failure", () => {
		expect(parseSubAgentResult("i could not do it").ok).toBe(false);
	});

	it("tolerates surrounding prose", () => {
		const r = parseSubAgentResult('done: {"ok":true,"result":"x"}');
		expect(r.ok).toBe(true);
		expect(r.result).toBe("x");
	});
});

describe("createLlmSubAgentRunner + supervisor", () => {
	it("drives the supervisor to completion with a fake model", async () => {
		// Fake model: always reports success for the asked task.
		const runner = createLlmSubAgentRunner(async () =>
			JSON.stringify({ ok: true, result: "ok", facts: ["checked"] }),
		);
		const res = await runSupervisor(
			[
				{ id: "a", objective: "scan a", status: "pending" },
				{ id: "b", objective: "scan b", status: "pending" },
			],
			runner,
		);
		expect(res.completed.map((t) => t.id)).toEqual(["a", "b"]);
		expect(res.ledger.facts).toContain("checked");
	});
});
