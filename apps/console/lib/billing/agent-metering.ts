// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import "server-only";
import type { AiCharge } from "@/lib/billing/ai-guard";
import { type AiUsageKind, recordAiUsage } from "@/lib/billing/ai-quota";

// Per-model metering for an agent turn. With advisor + executor orchestration (lib/config/ai.ts),
// a single turn spans MULTIPLE models — a Sonnet/Opus advisor plans step 0, then a Haiku executor
// runs the tool loop. To keep cost-of-serve honest (and the advisor-vs-executor margin visible),
// the ledger records ONE row PER MODEL with that model's own tokens, so cost_micros is priced
// correctly per model (lib/billing/model-costs.ts). The single up-front credit charge
// (assertAiAllowed) is booked once — the remaining models are cost-only rows.

/** One step's model + token usage (from streamText's onFinish `steps`). */
export interface AgentStep {
	model: string;
	usage: {
		inputTokens?: number;
		outputTokens?: number;
		cachedInputTokens?: number;
	};
}

/** Summed token usage for one distinct model across a turn's steps. */
export interface ModelUsageRecord {
	model: string;
	inputTokens: number;
	outputTokens: number;
	cachedInputTokens: number;
}

/**
 * Aggregate per-step usage into one record per DISTINCT model (sums tokens), preserving each
 * model's first-appearance order. A turn that used only one model returns a single record.
 */
export function aggregateUsageByModel(steps: AgentStep[]): ModelUsageRecord[] {
	const records: ModelUsageRecord[] = [];
	for (const step of steps) {
		const existing = records.find((r) => r.model === step.model);
		const rec = existing ?? {
			model: step.model,
			inputTokens: 0,
			outputTokens: 0,
			cachedInputTokens: 0,
		};
		rec.inputTokens += step.usage.inputTokens ?? 0;
		rec.outputTokens += step.usage.outputTokens ?? 0;
		rec.cachedInputTokens += step.usage.cachedInputTokens ?? 0;
		if (!existing) records.push(rec);
	}
	return records;
}

/**
 * Record an agent turn's usage PER MODEL (advisor vs executor visible in the ledger). The
 * single up-front credit charge (assertAiAllowed) is booked on the FIRST model row; every
 * other model is recorded as a cost-only row (credits 0) so cost_micros is correct per model
 * without double-charging the credit budget. No-ops on an empty turn.
 */
export async function recordAgentTurnUsage(input: {
	orgId: string;
	userId: string;
	kind: AiUsageKind;
	charge: AiCharge;
	refId?: string;
	steps: AgentStep[];
}): Promise<void> {
	const records = aggregateUsageByModel(input.steps);
	await Promise.all(
		records.map((rec, i) =>
			recordAiUsage({
				orgId: input.orgId,
				userId: input.userId,
				kind: input.kind,
				// Charge the credits once (first model); the rest are cost-only rows.
				credits: i === 0 ? input.charge.credits : 0,
				source: input.charge.source,
				refId: input.refId,
				model: rec.model,
				inputTokens: rec.inputTokens,
				outputTokens: rec.outputTokens,
				cachedInputTokens: rec.cachedInputTokens,
			}),
		),
	);
}
