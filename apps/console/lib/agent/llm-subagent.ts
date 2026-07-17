// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { asRecord } from "@/lib/records";
import type { GenerateText } from "@/lib/ai/explain-findings";
import type { Ledger, SubAgentRunner, Task } from "@/lib/agent/supervisor";

/**
 * LLM-backed implementation of the supervisor's injected SubAgentRunner (elench A4).
 * It runs ONE delegated task by prompting the model with the task objective + the
 * shared ledger facts and parsing a structured outcome. The model call is injected
 * (GenerateText) so the prompt-building and result-parsing are unit-tested without a
 * live model; the real factory binds the AI-gateway call. The supervisor —
 * deterministic — decides what to do with the outcome (success / stall / re-plan);
 * the model only does the task.
 */

/** Build the prompt for a single delegated task, grounded in the ledger facts. */
export function buildSubAgentPrompt(task: Task, ledger: Ledger): string {
	const facts = ledger.facts.length
		? ledger.facts.map((f) => `  - ${f}`).join("\n")
		: "  (none yet)";
	return [
		"You are a focused sub-agent. Complete EXACTLY this one task and nothing else.",
		`Task: ${task.objective}`,
		"",
		"Known facts so far:",
		facts,
		"",
		'Respond ONLY as JSON: {"ok": boolean, "result": string, "facts": string[]}.',
		"`ok` is whether you completed the task; `result` is a one-line summary;",
		"`facts` are any new facts to share with the team (may be empty).",
	].join("\n");
}

/** Parse a sub-agent model response; a non-JSON or malformed reply is a failure. */
export function parseSubAgentResult(raw: string): {
	ok: boolean;
	result: string;
	facts?: string[];
} {
	try {
		const match = raw.match(/\{[\s\S]*\}/);
		const parsed: unknown = JSON.parse(match ? match[0] : raw);
		if (parsed && typeof parsed === "object") {
			const o = asRecord(parsed);
			const facts = Array.isArray(o.facts)
				? o.facts.filter((f): f is string => typeof f === "string")
				: undefined;
			return {
				ok: o.ok === true,
				result: typeof o.result === "string" ? o.result : "",
				facts,
			};
		}
	} catch {
		// fall through
	}
	return { ok: false, result: "sub-agent returned an unparseable response" };
}

/** Build a SubAgentRunner from an injected model call. */
export function createLlmSubAgentRunner(generate: GenerateText): SubAgentRunner {
	return async (task: Task, ledger: Ledger) => {
		const raw = await generate(buildSubAgentPrompt(task, ledger));
		return parseSubAgentResult(raw);
	};
}
