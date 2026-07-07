// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import "server-only";
import { and, eq, gte, sql, sum } from "drizzle-orm";
import { getServiceDb } from "@/lib/db";
import { aiCreditGrant, aiUsageLedger } from "@/lib/db/schema";
import { aiCostMicros } from "@/lib/billing/model-costs";
import { captureAiGeneration } from "@/lib/analytics/server";

export type AiUsageKind = "scan" | "agent" | "support";
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

/** A day's AI-credit consumption for an org (both budget sources combined). */
export type AiCreditsDayRow = { day: string; credits: number };

/**
 * Day-bucketed AI credits an org consumed over [from, to) — the AI line of the Usage
 * page's "over time" chart. Both `included` and `purchased` sources, grouped by
 * `created_at`'s day. Only active days are returned; the caller fills the axis.
 */
export async function aiCreditsSeries(
	orgId: string,
	from: Date,
	to: Date,
): Promise<AiCreditsDayRow[]> {
	// Bind the window as timestamptz casts — drizzle's raw `sql` template doesn't serialize a
	// JS Date through postgres-js (it throws), so pass the ISO string with an explicit cast.
	return getServiceDb().execute<AiCreditsDayRow>(sql`
		select
			to_char(date_trunc('day', created_at), 'YYYY-MM-DD') as day,
			coalesce(sum(credits), 0)::int as credits
		from public.ai_usage_ledger
		where org_id = ${orgId}
		  and created_at >= ${from.toISOString()}::timestamptz
		  and created_at < ${to.toISOString()}::timestamptz
		group by 1
		order by 1
	`);
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

	// Mirror the generation into PostHog LLM-analytics (cost/tokens by model + org). This is the single
	// chokepoint every AI call site funnels through, so instrumenting here covers the agent, project
	// assistant, support Ask-AI, verify-explain, and colony sub-agents at once. Fire-and-forget and
	// env-gated (no-op with no PostHog key); only when a model was actually used.
	if (input.model) {
		void captureAiGeneration({
			userId: input.userId,
			orgId: input.orgId,
			kind: input.kind,
			model: input.model,
			refId: input.refId,
			inputTokens: input.inputTokens,
			outputTokens: input.outputTokens,
			cachedInputTokens: input.cachedInputTokens,
			costMicros,
		});
	}
}
