"use server";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { generateText } from "ai";
import { createLlmSubAgentRunner } from "@/lib/agent/llm-subagent";
import {
	type SupervisorResult,
	type Task,
	runSupervisor,
} from "@/lib/agent/supervisor";
import { requireOwner } from "@/lib/auth/owner";
import { getAiModel, isAiConfigured } from "@/lib/config/ai";

/**
 * Run a small colony: delegate each objective to an LLM-backed sub-agent under the
 * deterministic supervisor (Magentic ledger + stall→re-plan). The supervisor decides
 * control flow; the model only does each task. Intended for breadth-first READ
 * fan-out (drift/cost/security surveys) — keep write/converge work single-threaded.
 *
 * This is the live wiring of the supervisor + LLM sub-agent runner. The control-flow
 * and parsing logic are unit-tested with injected fakes (lib/agent/supervisor +
 * llm-subagent); here the runner binds the real AI-gateway call, mirroring the agent
 * route. Returns the supervisor result.
 */
export async function runColonyTasks(
	objectives: string[],
): Promise<SupervisorResult> {
	await requireOwner();
	if (!isAiConfigured()) {
		throw new Error("AI is not configured (set AI_GATEWAY_API_KEY)");
	}
	if (objectives.length === 0) {
		throw new Error("at least one objective is required");
	}

	const modelId = getAiModel();
	const runner = createLlmSubAgentRunner(async (prompt) => {
		const { text } = await generateText({ model: modelId, prompt });
		return text;
	});

	const tasks: Task[] = objectives.map((objective, i) => ({
		id: `t${i + 1}`,
		objective,
		status: "pending",
	}));

	return runSupervisor(tasks, runner);
}
