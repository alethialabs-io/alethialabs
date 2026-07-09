// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The AI-tier ladder — the source of truth for the STANDALONE AI product (repo-scanner
// + agent + Ask AI). AI is metered SEPARATELY from the org plan (Hobby/Pro/Enterprise):
// every org gets a usable free daily/weekly allowance (`ai_free`), and `ai_plus`/`ai_max`
// are their own Stripe subscription (separate price IDs) that raise the caps + upgrade the
// advisor model. Credit packs (lib/billing/ai-credits.ts) stack on top of ANY tier.
//
// All AI spends **AI credits** from one budget. A credit is a slice of real cost-of-serve
// ($0.001 each — see ai-credits.ts), NOT a message: a metered chat turn settles its actual
// token cost, so the caps are a true $ ceiling, not a message count. Two FIXED epoch buckets
// scaled by the tier: a **weekly** cap (the real governor) and a **daily** cap (≈45% of
// weekly — a loose burst rail). Burn freely until empty, then wait for the reset, upgrade, or
// buy top-up credits (NO silent overage). These allowances are final (maintainer-approved) —
// tune here.
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
	/** Advisor (planning) model — `none` on free (executor-only), Sonnet on Plus and Max
	 *  (Max upgrades to Opus per-message via the deep-reasoning opt-in). */
	advisor: AiAdvisor;
	/** Included AI credits per fixed calendar day (the daily-% denominator). */
	dailyCredits: number;
	/** Included AI credits per fixed 7-day week (the weekly-% denominator). */
	weeklyCredits: number;
	/**
	 * Per-USER daily sub-cap — the most included credits ONE seat may burn in a fixed day,
	 * so a single member can't drain the shared org allowance. A fraction of `dailyCredits`.
	 * The guard enforces this on top of the org cap when a `userId` is supplied.
	 */
	perUserDailyCredits: number;
	/** Per-USER weekly sub-cap — the same fairness bound over the fixed 7-day week. */
	perUserWeeklyCredits: number;
}

/**
 * The AI-tier ladder (final maintainer-approved allowances). Credits are cost-of-serve
 * slices ($0.001 each — see ai-credits.ts), NOT messages. The **weekly** cap is the real
 * ceiling; the **daily** cap (≈45% of weekly) is a loose burst rail. Each cap is annotated
 * with its dollar value.
 *  - ai_free → everyone: a usable daily/weekly allowance, Haiku executor only (no advisor).
 *  - ai_plus → paid AI subscription: bigger caps + a Sonnet advisor.
 *  - ai_max  → top AI subscription: the largest caps + a Sonnet advisor (Opus on demand,
 *    per-message via the deep-reasoning opt-in — see lib/config/ai.ts `getAdvisorModel`).
 *    Deep reasoning routes Opus but carries NO credit multiplier — Opus simply settles its
 *    own (higher) real cost.
 *
 * The `perUser*` sub-caps bound any single seat to a fraction of the org cap so one member
 * can't exhaust the whole workspace's included allowance.
 */
export const AI_TIERS: Record<AiTier, AiTierSpec> = {
	ai_free: {
		enabled: true,
		advisor: "none",
		dailyCredits: 230, // ≈$0.23/day burst rail
		weeklyCredits: 510, // ≈$0.51/week — the governor
		// Per-seat sub-cap = the full org cap (free orgs are usually a single seat).
		perUserDailyCredits: 230, // ≈$0.23/day
		perUserWeeklyCredits: 510, // ≈$0.51/week
	},
	ai_plus: {
		enabled: true,
		advisor: "sonnet",
		dailyCredits: 6_750, // ≈$6.75/day burst rail
		weeklyCredits: 15_000, // ≈$15/week — the governor
		// Per-seat sub-cap (paid orgs have several seats sharing the pool).
		perUserDailyCredits: 4_140, // ≈$4.14/day
		perUserWeeklyCredits: 9_200, // ≈$9.20/week
	},
	ai_max: {
		enabled: true,
		advisor: "sonnet",
		dailyCredits: 33_750, // ≈$33.75/day burst rail
		weeklyCredits: 75_000, // ≈$75/week — the governor
		// Per-seat sub-cap (larger teams share the pool).
		perUserDailyCredits: 20_700, // ≈$20.70/day
		perUserWeeklyCredits: 46_000, // ≈$46/week
	},
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

/** An org's effective AI tier plus its AI-spend hard-cap policy — one billing read. */
export interface AiPlanContext {
	tier: AiTier;
	/**
	 * The org's "never surprise me" spend policy (`organization_billing.usageHardCap`,
	 * shared with the runner-minutes guard). When ON, the AI guard pauses at the included
	 * allowance instead of auto-spending purchased top-up packs.
	 */
	hardCap: boolean;
}

/**
 * Resolve BOTH the effective AI tier and the org's AI-spend hard-cap policy in a single
 * billing read — the guard needs both per call. No row → free tier, hard-cap off.
 */
export async function resolveAiPlan(orgId: string): Promise<AiPlanContext> {
	const billing = await getOrgBilling(orgId).catch(() => null);
	if (!billing) return { tier: "ai_free", hardCap: false };
	return {
		tier: effectiveAiTier(
			billing.aiTier ?? "ai_free",
			billing.aiSubscriptionStatus ?? "none",
		),
		hardCap: billing.usageHardCap ?? false,
	};
}
