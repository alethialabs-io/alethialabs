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
import { meteringFailed, recordAiUsage } from "@/lib/billing/ai-quota";
import { getAiModel, isAiConfigured } from "@/lib/config/ai";

/**
 * The most model calls one metered colony turn may make.
 *
 * Matched to `stopWhen: stepCountIs(8)`, which every other metered AI entry point in this console
 * already uses (agent route, per-agent route, project assistant, support ask). A colony round and
 * an agent step are the same unit of spend against the same kind of hold, so they get the same
 * ceiling rather than a second number argued from scratch.
 */
const COLONY_MAX_ROUNDS = 8;

/**
 * The most objectives a colony accepts.
 *
 * Equal to COLONY_MAX_ROUNDS on purpose: the supervisor runs at most one task per round, so an
 * objective beyond this could never be reached. Accepting it would return a `SupervisorResult`
 * whose `completed` list silently omits work the caller asked for — an unreachable objective is
 * worse than a refused one, because only the refusal is visible.
 */
const COLONY_MAX_OBJECTIVES = COLONY_MAX_ROUNDS;

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
	// ── ONE metered turn is worth at most COLONY_MAX_ROUNDS model calls (#2698). ──
	//
	// `assertAiAllowed` below reserves ONE provisional hold for the whole colony. Before this cap,
	// the number of model calls that hold paid for was set by the CALLER: `runSupervisor` derives
	// `maxRounds` as `initialTasks.length * 3` when no explicit value is passed, so the ceiling was
	// computed from the very array it was supposed to bound. A caller passing 200 objectives bought
	// up to 600 model calls against a single ≈$0.10 reservation.
	//
	// This is a `"use server"` export, so the caller is anything that can reach the RPC surface —
	// and the array arrives as an unvalidated `string[]`.
	//
	// The number is not invented. Every other metered AI entry point in this console bounds its turn
	// at `stopWhen: stepCountIs(8)` — the agent route, the per-agent route, the project assistant and
	// support ask, all four. A colony round is the same unit of spend as an agent step, so it gets
	// the same budget rather than a new one argued from scratch.
	if (objectives.length > COLONY_MAX_OBJECTIVES) {
		// REFUSED, not truncated. Silently running 8 of 20 surveys and returning a result shaped like
		// a complete one is the failure this repo keeps paying for elsewhere — the caller cannot tell
		// an answer from a partial answer, and neither can the reader of the result.
		throw new Error(
			`a colony takes at most ${COLONY_MAX_OBJECTIVES} objectives (got ${objectives.length}); ` +
				"it runs as ONE metered turn under a single budget hold. Split the work across turns.",
		);
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

	// A metered turn reserved a provisional hold (assertAiAllowed) that MUST be reconciled or
	// released. Wrap the run so an error releases the hold (reconciled to 0) instead of leaving the
	// ≈$0.10 estimate stuck in the window.
	const holdId = charge.settle ? charge.holdId : undefined;
	let result: SupervisorResult;
	try {
		// EXPLICIT, not derived. Leaving `maxRounds` unset lets the supervisor compute it as
		// `initialTasks.length * 3` — the ceiling derived from the input it is meant to bound. The
		// objectives cap above and this bound are two different guarantees and both are needed: the
		// cap keeps unreachable work from being silently accepted, this keeps the spend of a single
		// hold bounded even if the cap is ever raised without the budget being revisited.
		result = await runSupervisor(tasks, runner, { maxRounds: COLONY_MAX_ROUNDS });
	} catch (e) {
		await recordAiUsage({
			orgId: actor.orgId,
			userId: actor.userId,
			kind: "agent",
			source: charge.source,
			holdId,
		});
		throw e;
	}

	// Record the colony's accumulated token cost across all sub-agent calls — reconciles the
	// reserved hold IN PLACE (holdId) so the estimate becomes the real accumulated cost.
	void recordAiUsage({
		orgId: actor.orgId,
		userId: actor.userId,
		kind: "agent",
		// Metered → omit credits; settled from the colony's accumulated real cost-of-serve.
		source: charge.source,
		holdId,
		model: resolved.key,
		inputTokens,
		outputTokens,
		cachedInputTokens,
	}).catch(meteringFailed(actor.orgId));

	return result;
}
