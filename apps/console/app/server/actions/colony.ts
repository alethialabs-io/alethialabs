"use server";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { generateText } from "ai";
import { createLlmSubAgentRunner } from "@/lib/agent/llm-subagent";
import {
	type SupervisorResult,
	type Task,
	runSupervisor,
} from "@/lib/agent/supervisor";
import { currentActor } from "@/lib/authz/guard";
import { AiBudgetError, assertAiAllowed } from "@/lib/billing/ai-guard";
import { recordAiUsage } from "@/lib/billing/ai-quota";
import { getAiModel, isAiConfigured } from "@/lib/config/ai";

/**
 * Run a small colony: delegate each objective to an LLM-backed sub-agent under the
 * deterministic supervisor (Magentic ledger + stall→re-plan). The supervisor decides
 * control flow; the model only does each task. Intended for breadth-first READ
 * fan-out (drift/cost/security surveys) — keep write/converge work single-threaded.
 *
 * This is the live wiring of the supervisor + LLM sub-agent runner. The control-flow
 * and parsing logic are unit-tested with injected fakes (lib/agent/supervisor +
 * llm-subagent); here the runner binds the real direct-to-provider call, mirroring the
 * agent route. Returns the supervisor result.
 */
export async function runColonyTasks(
	objectives: string[],
): Promise<SupervisorResult> {
	const actor = await currentActor();
	if (!isAiConfigured()) {
		throw new Error("AI is not configured (set ANTHROPIC_API_KEY)");
	}
	if (objectives.length === 0) {
		throw new Error("at least one objective is required");
	}

	// Budget-gate the run. Surface a clean budget message (never a raw AiBudgetError) so the
	// caller can toast "You're out of AI usage…" with the reset time instead of a stack.
	const charge = await assertAiAllowed(actor.orgId, "agent", actor.userId).catch((e: unknown) => {
		if (e instanceof AiBudgetError) throw new Error(e.message);
		throw e;
	});

	const resolved = getAiModel();
	let inputTokens = 0;
	let outputTokens = 0;
	let cachedInputTokens = 0;
	const runner = createLlmSubAgentRunner(async (prompt) => {
		const { text, usage } = await generateText({ model: resolved.model, prompt });
		inputTokens += usage.inputTokens ?? 0;
		outputTokens += usage.outputTokens ?? 0;
		cachedInputTokens += usage.cachedInputTokens ?? 0;
		return text;
	});

	const tasks: Task[] = objectives.map((objective, i) => ({
		id: `t${i + 1}`,
		objective,
		status: "pending",
	}));

	const result = await runSupervisor(tasks, runner);

	// Record the colony's accumulated token cost across all sub-agent calls.
	void recordAiUsage({
		orgId: actor.orgId,
		userId: actor.userId,
		kind: "agent",
		// Metered → omit credits; settled from the colony's accumulated real cost-of-serve.
		source: charge.source,
		model: resolved.key,
		inputTokens,
		outputTokens,
		cachedInputTokens,
	});

	return result;
}
