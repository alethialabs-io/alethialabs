// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import "server-only";
import { and, eq, gte, min, sql, sum } from "drizzle-orm";
import { getServiceDb } from "@/lib/db";
import { aiCreditGrant, aiUsageLedger } from "@/lib/db/schema";
import { aiCostMicros } from "@/lib/billing/model-costs";
import { costToCredits } from "@/lib/billing/ai-credits";
import { type AiMessage, captureAiGeneration } from "@/lib/analytics/server";
import { checkAiSpendThreshold } from "@/lib/billing/ai-spend-alert";

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

/**
 * Sum credits ONE user spent from a budget source in an org since a cutoff — the per-seat
 * variant of {@link sumCredits}, filtered by `user_id` (served by `idx_ai_usage_user`).
 * Drives the guard's per-user daily/weekly sub-caps so a single seat can't drain the org.
 */
export async function sumCreditsForUser(
	orgId: string,
	userId: string,
	source: CreditSource,
	since: Date,
): Promise<number> {
	const [row] = await getServiceDb()
		.select({ s: sum(aiUsageLedger.credits) })
		.from(aiUsageLedger)
		.where(
			and(
				eq(aiUsageLedger.org_id, orgId),
				eq(aiUsageLedger.user_id, userId),
				eq(aiUsageLedger.source, source),
				gte(aiUsageLedger.created_at, since),
			),
		);
	return Number(row?.s ?? 0);
}

/**
 * Oldest usage timestamp an org has from a budget source since a cutoff — `null` when the
 * window is empty. Drives the rolling 5-hour session's reset display: the session fully
 * clears at `oldest + window` (same WHERE shape as {@link sumCredits}, index-served).
 */
export async function oldestUsageSince(
	orgId: string,
	source: CreditSource,
	since: Date,
): Promise<Date | null> {
	const [row] = await getServiceDb()
		.select({ m: min(aiUsageLedger.created_at) })
		.from(aiUsageLedger)
		.where(
			and(
				eq(aiUsageLedger.org_id, orgId),
				eq(aiUsageLedger.source, source),
				gte(aiUsageLedger.created_at, since),
			),
		);
	// Aggregates can decode as raw strings depending on the driver — normalize to Date.
	return row?.m ? new Date(row.m) : null;
}

/**
 * Per-seat variant of {@link oldestUsageSince} — the oldest usage ONE user has in the
 * window (served by `idx_ai_usage_user`). Drives the per-seat session-cap reset display.
 */
export async function oldestUsageForUserSince(
	orgId: string,
	userId: string,
	source: CreditSource,
	since: Date,
): Promise<Date | null> {
	const [row] = await getServiceDb()
		.select({ m: min(aiUsageLedger.created_at) })
		.from(aiUsageLedger)
		.where(
			and(
				eq(aiUsageLedger.org_id, orgId),
				eq(aiUsageLedger.user_id, userId),
				eq(aiUsageLedger.source, source),
				gte(aiUsageLedger.created_at, since),
			),
		);
	return row?.m ? new Date(row.m) : null;
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

/**
 * Sum AI credits attributable to ONE **project** since a cutoff. `ai_usage_ledger` has no
 * `project_id`, so attribution is best-effort via `ref_id`: a `scan` row's ref_id is a
 * `jobs.id` (→ `jobs.project_id`) and an `agent` row's ref_id is an `agent_threads.id`
 * (→ `agent_threads.project_id`). Rows whose ref_id matches neither (support Ask-AI, legacy
 * rows with a NULL ref_id, or a ref that no longer resolves) are EXCLUDED — the project view
 * notes this coverage caveat. `ref_id` is `text`, so it's compared against `id::text` to avoid
 * a uuid-cast error on non-uuid refs. Service path (trusted; the caller scopes the project).
 */
export async function sumCreditsByProject(
	projectId: string,
	source: CreditSource,
	since: Date,
): Promise<number> {
	const [row] = await getServiceDb().execute<{ credits: number }>(sql`
		select coalesce(sum(l.credits), 0)::int as credits
		from public.ai_usage_ledger l
		where l.source = ${source}
		  and l.created_at >= ${since.toISOString()}::timestamptz
		  and (
			(l.kind = 'scan' and exists (
				select 1 from public.jobs j
				where j.id::text = l.ref_id and j.project_id = ${projectId}
			))
			or (l.kind = 'agent' and exists (
				select 1 from public.agent_threads t
				where t.id::text = l.ref_id and t.project_id = ${projectId}
			))
		  )
	`);
	return Number(row?.credits ?? 0);
}

/**
 * Day-bucketed AI credits attributable to one **project** over [from, to) — the project
 * analogue of {@link aiCreditsSeries}. Both budget sources combined, grouped by `created_at`'s
 * day. Attribution is best-effort via `ref_id` (scan→jobs.project_id, agent→agent_threads.
 * project_id); rows matching neither are excluded (see {@link sumCreditsByProject}). Only
 * active days are returned; the caller zero-fills the axis. Service path.
 */
export async function aiCreditsSeriesByProject(
	projectId: string,
	from: Date,
	to: Date,
): Promise<AiCreditsDayRow[]> {
	return getServiceDb().execute<AiCreditsDayRow>(sql`
		select
			to_char(date_trunc('day', l.created_at), 'YYYY-MM-DD') as day,
			coalesce(sum(l.credits), 0)::int as credits
		from public.ai_usage_ledger l
		where l.created_at >= ${from.toISOString()}::timestamptz
		  and l.created_at < ${to.toISOString()}::timestamptz
		  and (
			(l.kind = 'scan' and exists (
				select 1 from public.jobs j
				where j.id::text = l.ref_id and j.project_id = ${projectId}
			))
			or (l.kind = 'agent' and exists (
				select 1 from public.agent_threads t
				where t.id::text = l.ref_id and t.project_id = ${projectId}
			))
		  )
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
 * Append one metered AI action to the ledger. When `credits` is supplied it's booked
 * verbatim (the FIXED path — e.g. a scan's nominal charge, or an explicit 0-credit
 * cost-only row). When `credits` is OMITTED (the metered settle path), the row's
 * cost-weighted credits are DERIVED from its real cost-of-serve — `costToCredits(cost_micros)`
 * — so each model row is priced by its own tokens. Always records the model + tokens +
 * snapshotted USD micros (via `aiCostMicros`) when a model is present. On the INSERT path it
 * no-ops only when there is nothing to record — 0 credits AND no model (e.g. a legacy/self-host
 * call before token capture); a 0-credit call WITH a model is still recorded (cost row) so
 * self-hosters and the FinOps rollup get real cost visibility without affecting the credit budget.
 * When `holdId` is set it RECONCILES that provisional hold row in place (always, even to 0) rather
 * than inserting — see the field doc — so a metered turn's ≈$0.10 hold never leaks.
 */
export async function recordAiUsage(input: {
	orgId: string;
	userId: string;
	kind: AiUsageKind;
	/** Credits to book. Omit on a metered (settle) turn — derived from `cost_micros`. */
	credits?: number;
	source: CreditSource;
	/**
	 * Id of the provisional hold row this turn reserved (from `assertAiAllowed`'s settle charge).
	 * When set, that row is reconciled/released IN PLACE (updated to this call's real cost, even 0)
	 * instead of appending a new ledger row — so a settled, errored, or empty turn never leaks its
	 * ≈$0.10 hold. Without it the classic append-only insert path is used.
	 */
	holdId?: string;
	refId?: string;
	model?: string;
	inputTokens?: number;
	outputTokens?: number;
	cachedInputTokens?: number;
	/**
	 * Optional LLM-observability enrichment — forwarded verbatim to the PostHog `$ai_generation`
	 * mirror only (never touches the billing ledger). Lets call sites light up Traces / Sessions /
	 * Tools / Errors / Sentiment without changing the metering contract.
	 */
	cacheCreationInputTokens?: number;
	latencyMs?: number;
	sessionId?: string;
	input?: AiMessage[];
	outputChoices?: AiMessage[];
	tools?: string[];
	isError?: boolean;
	error?: string;
	stopReason?: string;
	stream?: boolean;
	temperature?: number;
	maxTokens?: number;
}): Promise<void> {
	const costMicros = input.model
		? aiCostMicros({
				model: input.model,
				inputTokens: input.inputTokens,
				outputTokens: input.outputTokens,
				cachedInputTokens: input.cachedInputTokens,
			})
		: null;
	// Settle path: no explicit credits → cost-weighted from the row's real cost-of-serve.
	const credits =
		input.credits ?? (costMicros != null ? costToCredits(costMicros) : 0);
	if (input.holdId) {
		// Reconcile a provisional hold IN PLACE: overwrite the reserved estimate with this turn's
		// real cost. ALWAYS runs (even 0 credits / no model) so an errored or empty turn RELEASES
		// the hold instead of leaving the reserve estimate stuck in the window (no leaked headroom).
		await getServiceDb()
			.update(aiUsageLedger)
			.set({
				credits,
				ref_id: input.refId ?? null,
				model: input.model ?? null,
				input_tokens: input.inputTokens ?? null,
				output_tokens: input.outputTokens ?? null,
				cached_input_tokens: input.cachedInputTokens ?? null,
				cost_micros: costMicros,
			})
			.where(eq(aiUsageLedger.id, input.holdId));
	} else {
		if (credits <= 0 && !input.model) return;
		await getServiceDb()
			.insert(aiUsageLedger)
			.values({
				org_id: input.orgId,
				user_id: input.userId,
				kind: input.kind,
				credits,
				source: input.source,
				ref_id: input.refId ?? null,
				model: input.model ?? null,
				input_tokens: input.inputTokens ?? null,
				output_tokens: input.outputTokens ?? null,
				cached_input_tokens: input.cachedInputTokens ?? null,
				cost_micros: costMicros,
			});
	}

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
			// Optional observability enrichment (undefined at unenriched call sites → same as before).
			cacheCreationInputTokens: input.cacheCreationInputTokens,
			latencyMs: input.latencyMs,
			sessionId: input.sessionId,
			input: input.input,
			outputChoices: input.outputChoices,
			tools: input.tools,
			isError: input.isError,
			error: input.error,
			stopReason: input.stopReason,
			stream: input.stream,
			temperature: input.temperature,
			maxTokens: input.maxTokens,
		});
	}

	// Spend-threshold alert (deliverable 3): from the same chokepoint, check whether this
	// included spend pushed the org across a % of its weekly allowance and, if so, enqueue a
	// `system.cost.budget_threshold` alert. Fire-and-forget — must never slow/fail the AI call.
	if (credits > 0 && input.source === "included") {
		void checkAiSpendThreshold(input.orgId).catch(() => {
			/* alerting must never break an AI call */
		});
	}
}
