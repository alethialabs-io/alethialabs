"use server";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { currentActor } from "@/lib/authz/guard";
import { purchasedBalance, sumCredits } from "@/lib/billing/ai-quota";
import { isStripeConfigured } from "@/lib/billing/config";
import { resolvePlanEntitlements } from "@/lib/billing/plan";
import { getOrgBilling } from "@/lib/billing/queries";

const HOUR_MS = 3_600_000;
const WEEK_MS = 7 * 24 * HOUR_MS;

/**
 * AI usage for the active org's usage surface — PROPORTIONS + resets only (never raw
 * included credit counts; the multiplier tier is the only "amount" shown). The purchased
 * balance is surfaced because it's a thing the user bought.
 */
export interface AiUsageSummary {
	hosted: boolean;
	enabled: boolean;
	/** Display multiplier tier — trial / standard / 5× / 20×. */
	tier: "trial" | "standard" | "plus" | "max";
	/** Short-window usage, 0–100, + when it resets. */
	windowPctUsed: number;
	windowResetAt: string;
	/** Weekly usage, 0–100, + when it resets. */
	weekPctUsed: number;
	weekResetAt: string;
	/** Remaining purchased top-up credits. */
	purchasedBalance: number;
}

export async function getAiUsage(): Promise<AiUsageSummary> {
	const actor = await currentActor();
	const billing = await getOrgBilling(actor.orgId).catch(() => null);
	const ai = resolvePlanEntitlements(
		billing?.plan ?? "community",
		billing?.status ?? "none",
	).ai;

	const now = Date.now();
	const windowMs = ai.windowHours * HOUR_MS;
	const windowStart = new Date(Math.floor(now / windowMs) * windowMs);
	const weekStart = new Date(Math.floor(now / WEEK_MS) * WEEK_MS);

	const [windowUsed, weekUsed, purchased] = await Promise.all([
		sumCredits(actor.orgId, "included", windowStart),
		sumCredits(actor.orgId, "included", weekStart),
		purchasedBalance(actor.orgId),
	]);

	const pct = (used: number, cap: number) =>
		cap > 0 ? Math.min(100, Math.round((used / cap) * 100)) : 0;

	return {
		hosted: isStripeConfigured(),
		enabled: ai.enabled,
		tier: ai.tier,
		windowPctUsed: pct(windowUsed, ai.windowCredits),
		windowResetAt: new Date(windowStart.getTime() + windowMs).toISOString(),
		weekPctUsed: pct(weekUsed, ai.weeklyCredits),
		weekResetAt: new Date(weekStart.getTime() + WEEK_MS).toISOString(),
		purchasedBalance: purchased,
	};
}
