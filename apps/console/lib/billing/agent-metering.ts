// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import "server-only";
import type { AiMessage } from "@/lib/analytics/server";
import type { AiCharge } from "@/lib/billing/ai-guard";
import { type AiUsageKind, recordAiUsage } from "@/lib/billing/ai-quota";

/**
 * Turn-level LLM-observability enrichment (PostHog `$ai_generation`). A turn spans multiple per-model
 * rows, but the conversation content/tools/latency describe the turn as a whole — so they're attached
 * to the PRIMARY (row 0) generation, while `sessionId` goes on every row so they group as one session.
 */
export interface AgentTurnObservability {
	sessionId?: string;
	input?: AiMessage[];
	outputChoices?: AiMessage[];
	tools?: string[];
	latencyMs?: number;
	stopReason?: string;
	isError?: boolean;
	error?: string;
}

// Per-model metering for an agent turn. With advisor + executor orchestration (lib/config/ai.ts),
// a single turn spans MULTIPLE models — a Sonnet/Opus advisor plans step 0, then a Haiku executor
// runs the tool loop. To keep cost-of-serve honest (and the advisor-vs-executor margin visible),
// the ledger records ONE row PER MODEL with that model's own tokens, so cost_micros is priced
// correctly per model (lib/billing/model-costs.ts). With cost-weighted credits (the settle path),
// EACH model row books its own cost-derived credits — the whole turn is summed from real cost, no
// "first row only" special-case. A FIXED charge (if ever used here) is booked once, on row 0.

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
 * Record an agent turn's usage PER MODEL (advisor vs executor visible in the ledger).
 *  - **settle** charge (metered, the norm): each model row books its OWN cost-derived credits
 *    — `credits` is omitted so `recordAiUsage` derives it from that row's `cost_micros`. The
 *    turn's total is the sum of the per-row real cost — correctly priced, no double-charge.
 *  - **fixed** charge (reservation, if ever used here): the credit charge is booked once on the
 *    FIRST model row; the rest are cost-only rows (credits 0).
 * No-ops on an empty turn.
 */
export async function recordAgentTurnUsage(input: {
	orgId: string;
	userId: string;
	kind: AiUsageKind;
	charge: AiCharge;
	refId?: string;
	steps: AgentStep[];
	/** Optional PostHog LLM-observability enrichment for the turn (content/tools/latency/session). */
	turn?: AgentTurnObservability;
}): Promise<void> {
	const records = aggregateUsageByModel(input.steps);
	const charge = input.charge;
	const turn = input.turn;
	await Promise.all(
		records.map((rec, i) => {
			// Enrichment only when the caller supplied turn context — otherwise the metering call stays
			// byte-identical to the un-enriched contract. sessionId groups the turn's per-model
			// generations into one PostHog session; the heavier content/tools/latency ride the primary
			// (row 0) generation to avoid duplicating a long transcript across every model row.
			const enrich = turn
				? {
						sessionId: turn.sessionId,
						stream: true,
						input: i === 0 ? turn.input : undefined,
						outputChoices: i === 0 ? turn.outputChoices : undefined,
						tools: i === 0 ? turn.tools : undefined,
						latencyMs: i === 0 ? turn.latencyMs : undefined,
						stopReason: i === 0 ? turn.stopReason : undefined,
						isError: i === 0 ? turn.isError : undefined,
						error: i === 0 ? turn.error : undefined,
					}
				: {};
			return recordAiUsage({
				orgId: input.orgId,
				userId: input.userId,
				kind: input.kind,
				// Settle → derive per row from cost_micros (omit); fixed → book once on row 0.
				credits: charge.settle ? undefined : i === 0 ? charge.credits : 0,
				source: charge.source,
				refId: input.refId,
				model: rec.model,
				inputTokens: rec.inputTokens,
				outputTokens: rec.outputTokens,
				cachedInputTokens: rec.cachedInputTokens,
				...enrich,
			});
		}),
	);
}
