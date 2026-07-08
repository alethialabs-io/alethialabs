"use server";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { currentActor } from "@/lib/authz/guard";
import { type AiTier, aiTierSpec, resolveAiTier } from "@/lib/billing/ai-plan";
import { purchasedBalance, sumCredits } from "@/lib/billing/ai-quota";
import { isStripeConfigured } from "@/lib/billing/config";

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;

/**
 * AI usage for the active org's usage surface — PROPORTIONS + resets only (never raw
 * included credit counts; the AI tier is the only "amount" shown). The purchased balance
 * is surfaced because it's a thing the user bought. Computed on the SAME fixed daily +
 * weekly buckets the guard (ai-guard.ts) enforces, so display never diverges from the cap.
 */
export interface AiUsageSummary {
	hosted: boolean;
	enabled: boolean;
	/** The org's standalone AI tier (independent of the org plan). */
	tier: AiTier;
	/** Daily usage, 0–100, + when it resets. */
	dailyPctUsed: number;
	dailyResetAt: string;
	/** Weekly usage, 0–100, + when it resets. */
	weeklyPctUsed: number;
	weeklyResetAt: string;
	/** Remaining purchased top-up credits. */
	purchasedBalance: number;
}

export async function getAiUsage(): Promise<AiUsageSummary> {
	const actor = await currentActor();
	const tier = await resolveAiTier(actor.orgId).catch(() => "ai_free" as const);
	const spec = aiTierSpec(tier);

	const now = Date.now();
	const dayStart = new Date(Math.floor(now / DAY_MS) * DAY_MS);
	const weekStart = new Date(Math.floor(now / WEEK_MS) * WEEK_MS);

	const [dayUsed, weekUsed, purchased] = await Promise.all([
		sumCredits(actor.orgId, "included", dayStart),
		sumCredits(actor.orgId, "included", weekStart),
		purchasedBalance(actor.orgId),
	]);

	const pct = (used: number, cap: number) =>
		cap > 0 ? Math.min(100, Math.round((used / cap) * 100)) : 0;

	return {
		hosted: isStripeConfigured(),
		enabled: spec.enabled,
		tier,
		dailyPctUsed: pct(dayUsed, spec.dailyCredits),
		dailyResetAt: new Date(dayStart.getTime() + DAY_MS).toISOString(),
		weeklyPctUsed: pct(weekUsed, spec.weeklyCredits),
		weeklyResetAt: new Date(weekStart.getTime() + WEEK_MS).toISOString(),
		purchasedBalance: purchased,
	};
}
