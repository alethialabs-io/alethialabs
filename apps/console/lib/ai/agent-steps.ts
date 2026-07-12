// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Orchestration step markers: the agent route streams a `data-agent-step` UIMessage part
// at each model boundary of a turn (the tier advisor PLANS step 0, the cheap executor
// runs the tool loop) so the transcript can show WHO is doing WHAT. Shared client+server
// (zod SSOT, no provider imports — safe in the browser bundle).

import { z } from "zod";

/** UIMessage part type for orchestration step markers (`data-*` custom data part). */
export const AGENT_STEP_PART_TYPE = "data-agent-step";

export const agentStepDataSchema = z.object({
	/** The streamText step index the marker precedes. */
	step: z.number(),
	/** plan = the advisor's planning step; execute = the executor's tool loop. */
	phase: z.enum(["plan", "execute"]),
	/** Canonical `provider/native-id` model key (the ledger key). */
	model: z.string(),
	/** Human display name, e.g. "Claude Sonnet 4.6". */
	label: z.string(),
});

export type AgentStepData = z.infer<typeof agentStepDataSchema>;

/**
 * Human label for a canonical `provider/native-id` model key without importing the
 * provider config (client-safe): "anthropic/claude-sonnet-4-6" → "Claude Sonnet 4.6".
 * Trailing numeric segments join as a dotted version; "gpt" upper-cases.
 */
export function modelLabel(key: string): string {
	const native = key.includes("/") ? key.slice(key.indexOf("/") + 1) : key;
	const words = native.split("-").filter(Boolean);
	const version: string[] = [];
	while (words.length > 0 && /^\d+$/.test(words[words.length - 1] ?? "")) {
		const v = words.pop();
		if (v) version.unshift(v);
	}
	const name = words
		.map((w) => (w === "gpt" ? "GPT" : w.charAt(0).toUpperCase() + w.slice(1)))
		.join(" ");
	return version.length > 0 ? `${name} ${version.join(".")}` : name || key;
}

export interface AgentStepMarkerParams {
	/** The streamText step about to run. */
	stepNumber: number;
	/** True when the user force-picked a model (single-model run, no orchestration). */
	clientPick: boolean;
	/** Canonical key of the planning-step advisor model. */
	advisorKey: string;
	/** Canonical key of the tool-loop executor model. */
	executorKey: string;
	/** Canonical key of the run's base model (the pick, or the executor). */
	baseKey: string;
}

/**
 * The marker-emission rule, pure so it's unit-testable: emit at step 0 (the advisor's
 * planning step — or a single `execute` marker for a forced-pick run) and at the first
 * executor step when the model actually changes; never on subsequent loop steps, so a
 * turn shows at most two separators.
 */
export function agentStepMarker(
	params: AgentStepMarkerParams,
): AgentStepData | null {
	const { stepNumber, clientPick, advisorKey, executorKey, baseKey } = params;
	if (clientPick) {
		if (stepNumber !== 0) return null;
		return {
			step: 0,
			phase: "execute",
			model: baseKey,
			label: modelLabel(baseKey),
		};
	}
	if (stepNumber === 0) {
		return {
			step: 0,
			phase: "plan",
			model: advisorKey,
			label: modelLabel(advisorKey),
		};
	}
	if (stepNumber === 1 && advisorKey !== executorKey) {
		return {
			step: 1,
			phase: "execute",
			model: executorKey,
			label: modelLabel(executorKey),
		};
	}
	return null;
}
