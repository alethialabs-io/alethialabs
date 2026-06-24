// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import "server-only";
import { and, eq, gte, sum } from "drizzle-orm";
import { getServiceDb } from "@/lib/db";
import { aiCreditGrant, aiUsageLedger } from "@/lib/db/schema";
import { aiCostMicros } from "@/lib/billing/model-costs";

export type AiUsageKind = "scan" | "agent";
export type CreditSource = "included" | "purchased";

/** Sum credits an org spent from a budget source since a cutoff (service-db; trusted). */
export async function sumCredits(
	orgId: string,
	source: CreditSource,
	since: Date,
): Promise<number> {
	const [row] = await getServiceDb()
		.select({ s: sum(aiUsageLedger.credits) })
		.from(aiUsageLedger)
		.where(
			and(
				eq(aiUsageLedger.org_id, orgId),
				eq(aiUsageLedger.source, source),
				gte(aiUsageLedger.created_at, since),
			),
		);
	return Number(row?.s ?? 0);
}

/** Remaining purchased top-up credits: Σ grants − Σ purchased usage (all time). */
export async function purchasedBalance(orgId: string): Promise<number> {
	const [granted] = await getServiceDb()
		.select({ s: sum(aiCreditGrant.credits) })
		.from(aiCreditGrant)
		.where(eq(aiCreditGrant.org_id, orgId));
	const spent = await sumCredits(orgId, "purchased", new Date(0));
	return Number(granted?.s ?? 0) - spent;
}

/** Grant purchased top-up credits (idempotent on the Stripe ref — webhook-safe). */
export async function grantAiCredits(input: {
	orgId: string;
	userId: string;
	credits: number;
	stripeRef: string;
}): Promise<void> {
	await getServiceDb()
		.insert(aiCreditGrant)
		.values({
			org_id: input.orgId,
			user_id: input.userId,
			credits: input.credits,
			stripe_ref: input.stripeRef,
		})
		.onConflictDoNothing({ target: aiCreditGrant.stripe_ref });
}

/**
 * Append one metered AI action to the ledger. Records the user-facing `credits` and,
 * when token usage is supplied, the real cost-of-serve (model + tokens + snapshotted
 * USD micros via `aiCostMicros`). No-ops only when there is nothing to record — a
 * 0-credit call with no model (e.g. a legacy/self-host call before token capture).
 * A 0-credit call WITH a model is still recorded (cost row) so self-hosters and the
 * FinOps rollup get real cost visibility without affecting the credit budget.
 */
export async function recordAiUsage(input: {
	orgId: string;
	userId: string;
	kind: AiUsageKind;
	credits: number;
	source: CreditSource;
	refId?: string;
	model?: string;
	inputTokens?: number;
	outputTokens?: number;
	cachedInputTokens?: number;
}): Promise<void> {
	if (input.credits <= 0 && !input.model) return;
	const costMicros = input.model
		? aiCostMicros({
				model: input.model,
				inputTokens: input.inputTokens,
				outputTokens: input.outputTokens,
				cachedInputTokens: input.cachedInputTokens,
			})
		: null;
	await getServiceDb()
		.insert(aiUsageLedger)
		.values({
			org_id: input.orgId,
			user_id: input.userId,
			kind: input.kind,
			credits: input.credits,
			source: input.source,
			ref_id: input.refId ?? null,
			model: input.model ?? null,
			input_tokens: input.inputTokens ?? null,
			output_tokens: input.outputTokens ?? null,
			cached_input_tokens: input.cachedInputTokens ?? null,
			cost_micros: costMicros,
		});
}
