// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The AI-tier ladder — the source of truth for the STANDALONE AI product (repo-scanner
// + agent + Ask AI). AI is metered SEPARATELY from the org plan (Hobby/Pro/Enterprise):
// every org gets a usable free daily/weekly allowance (`ai_free`), and `ai_plus`/`ai_max`
// are their own Stripe subscription (separate price IDs) that raise the caps + upgrade the
// advisor model. Credit packs (lib/billing/ai-credits.ts) stack on top of ANY tier.
//
// All AI spends **AI credits** from one budget (a scan is heavy, a message is light —
// see ai-credits.ts). Two FIXED epoch buckets scaled by the tier: a **daily** cap and a
// **weekly** cap. Burn freely until empty, then wait for the reset, upgrade, or buy
// top-up credits (NO silent overage). Numbers are placeholders — tune here.
//
// Pure data + a thin DB read (resolveAiTier). NOT marked `server-only` so the schema can
// type-import `AiTier`; the client display copy lives in @repo/plan-catalog, so client
// components never need to import this module.

import { isBillingActive } from "@/lib/billing/plan";
import { getOrgBilling } from "@/lib/billing/queries";
import type { BillingStatus } from "@/lib/db/schema/enums";

/** An org's standalone AI subscription tier. `ai_free` is the implicit default. */
export type AiTier = "ai_free" | "ai_plus" | "ai_max";

/** Which advisor (planning/review) model a tier unlocks. `none` = executor-only. */
export type AiAdvisor = "none" | "sonnet" | "opus";

/** What one AI tier grants: whether AI is on, its advisor model, and its credit caps. */
export interface AiTierSpec {
	/** AI usable at all on this tier (always true today; future-proofs a disabled tier). */
	enabled: boolean;
	/** Advisor (planning) model — `none` on free (executor-only), Sonnet on Plus, Opus on Max. */
	advisor: AiAdvisor;
	/** Included AI credits per fixed calendar day (the daily-% denominator). */
	dailyCredits: number;
	/** Included AI credits per fixed 7-day week (the weekly-% denominator). */
	weeklyCredits: number;
}

/**
 * The AI-tier ladder (PLACEHOLDER allowances — tunable here; credits: message=1, scan=20):
 *  - ai_free → everyone: a usable daily/weekly allowance, Haiku executor only (no advisor).
 *  - ai_plus → paid AI subscription: bigger caps + a Sonnet advisor.
 *  - ai_max  → top AI subscription: the largest caps + an Opus advisor.
 */
export const AI_TIERS: Record<AiTier, AiTierSpec> = {
	ai_free: { enabled: true, advisor: "none", dailyCredits: 25, weeklyCredits: 100 },
	ai_plus: { enabled: true, advisor: "sonnet", dailyCredits: 200, weeklyCredits: 1_500 },
	ai_max: { enabled: true, advisor: "opus", dailyCredits: 1_000, weeklyCredits: 8_000 },
};

/** The spec for a tier (never throws — every AiTier has an entry). */
export function aiTierSpec(tier: AiTier): AiTierSpec {
	return AI_TIERS[tier];
}

/**
 * The effective AI tier from a stored tier + its AI-subscription status: a paid tier only
 * counts while its subscription is live (active/trialing); a lapsed/cancelled paid tier
 * falls back to `ai_free` (everyone always keeps the free allowance). `ai_free` is inert.
 */
export function effectiveAiTier(tier: AiTier, status: BillingStatus): AiTier {
	if (tier === "ai_free") return "ai_free";
	return isBillingActive(status) ? tier : "ai_free";
}

/**
 * Resolve an org's effective AI tier from its billing record (INDEPENDENT of the org
 * plan). No row, or a lapsed AI subscription, → `ai_free`. The single place the guard +
 * usage surfaces read the AI tier from.
 */
export async function resolveAiTier(orgId: string): Promise<AiTier> {
	const billing = await getOrgBilling(orgId).catch(() => null);
	if (!billing) return "ai_free";
	return effectiveAiTier(
		billing.aiTier ?? "ai_free",
		billing.aiSubscriptionStatus ?? "none",
	);
}
