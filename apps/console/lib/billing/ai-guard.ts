// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import "server-only";
import { aiTierSpec, resolveAiPlan, resolveAiTier } from "@/lib/billing/ai-plan";
import { creditsFor } from "@/lib/billing/ai-credits";
import {
	type AiUsageKind,
	type CreditSource,
	purchasedBalance,
	sumCredits,
	sumCreditsForUser,
} from "@/lib/billing/ai-quota";
import { isStripeConfigured } from "@/lib/billing/config";

/** Thrown when an org is out of AI credits; mapped to an upgrade / buy-credits CTA. */
export class AiBudgetError extends Error {
	constructor(
		message: string,
		readonly reason: "not_enabled" | "daily" | "weekly" | "out",
		/** ISO time the blocking bucket resets (null when only buying credits helps). */
		readonly resetAt: string | null,
		/** Whether upgrading the AI plan would lift the block. */
		readonly upgradable: boolean,
	) {
		super(message);
		this.name = "AiBudgetError";
	}
}

/**
 * Decision returned by the guard: how to charge the allowed action. Two shapes:
 *  - **fixed** `{ source, credits }` — a reservation booked up front (only `scan` today).
 *  - **settle** `{ source, settle: true }` — a metered turn whose real cost-of-serve is only
 *    known AFTER it runs; the caller records it (credits derived from `cost_micros`).
 * `settle` is the discriminant (absent/false ⇒ the fixed shape carries `credits`).
 */
export type AiCharge =
	| { source: CreditSource; credits: number; settle?: false }
	| { source: CreditSource; settle: true };

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;

/** Fixed day/week buckets (epoch-aligned) → clean reset times + simple sums. */
function bucketStart(now: number, sizeMs: number): Date {
	return new Date(Math.floor(now / sizeMs) * sizeMs);
}

/**
 * Throw the **per-seat** (personal) budget error — this seat has exhausted its personal
 * daily/weekly sub-cap while the ORG still has included room. Not upgradable (buying org
 * credits / upgrading doesn't lift a personal cap; it clears on the bucket reset).
 */
function throwPersonalCap(weeklyHit: boolean, dayStart: Date, weekStart: Date): never {
	throw new AiBudgetError(
		weeklyHit
			? "You've reached your personal AI usage limit for this week. It resets soon — an admin can raise the per-seat limit."
			: "You've reached your personal AI usage limit for today. It resets soon — an admin can raise the per-seat limit.",
		weeklyHit ? "weekly" : "daily",
		new Date(
			weeklyHit ? weekStart.getTime() + WEEK_MS : dayStart.getTime() + DAY_MS,
		).toISOString(),
		false,
	);
}

/**
 * Throw the **org-level** budget error — the org's included allowance for this bucket is
 * spent (and no purchased top-up covers it). Upgradable: buying credits / upgrading lifts it.
 */
function throwOrgCap(weeklyHit: boolean, dayStart: Date, weekStart: Date): never {
	throw new AiBudgetError(
		weeklyHit
			? "You're out of AI usage for this week. Buy credits or upgrade your AI plan."
			: "You're out of AI usage for today. It resets soon — or buy credits / upgrade.",
		weeklyHit ? "weekly" : "daily",
		new Date(
			weeklyHit ? weekStart.getTime() + WEEK_MS : dayStart.getTime() + DAY_MS,
		).toISOString(),
		true,
	);
}

/**
 * Coarse access gate for the AI *surface* (the MCP endpoint): is AI enabled for this
 * org at all? Unlike assertAiAllowed it charges nothing — per-call metering still
 * rides each tool (e.g. scanner → assertAiAllowed("scan")). AI is a standalone product
 * now: every org has at least the `ai_free` tier, so this is true unless a tier is
 * explicitly disabled. **Self-host bypass:** no hosted billing → always enabled
 * (open-core; the operator pays their own gateway).
 */
export async function isAiSurfaceEnabled(orgId: string): Promise<boolean> {
	if (!isStripeConfigured()) return true;
	const tier = await resolveAiTier(orgId).catch(() => "ai_free" as const);
	return aiTierSpec(tier).enabled;
}

/**
 * Gate a metered AI action against the org's AI-tier budget — a fixed **daily** cap + a
 * **weekly** cap (both from the org's standalone AI tier, INDEPENDENT of the org plan),
 * spending **included** credits first, then **purchased** top-ups. Returns how to charge
 * it (caller records via `recordAiUsage`); throws `AiBudgetError` when out.
 *
 * Two charge models by kind:
 *  - **Fixed (`scan`)** — a nominal cost (`creditsFor`) is *reserved* up front: allowed only
 *    if `used + cost <= cap`. The returned charge carries that `credits` figure.
 *  - **Metered (`agent`/`support`)** — the real cost-of-serve is only known AFTER the turn, so
 *    the gate checks **headroom** instead: allowed if the bucket still has ANY room
 *    (`used < cap`). The returned charge is `{ settle: true }`; the caller settles the actual
 *    cost (derived from `cost_micros`) when the turn finishes. A turn that starts with headroom
 *    may overshoot its bucket by ≤1 turn — standard/accepted; the NEXT turn blocks.
 *
 * When `userId` is supplied, an additional **per-seat** daily + weekly sub-cap is enforced on
 * top of the org caps (a fraction of the org allowance — see `AiTierSpec.perUser*`), so one
 * member can't drain the whole workspace's included budget. A seat that has exhausted its
 * personal share while the org still has room is blocked (buying org credits doesn't lift a
 * per-seat cap; it clears on the bucket reset). Omitting `userId` preserves the org-only
 * behaviour (back-compat).
 *
 * Respects the org's **AI-spend hard cap** (`organization_billing.usageHardCap`, shared with
 * the runner-minutes guard): when on, the guard pauses at the included allowance instead of
 * auto-spending purchased top-up packs.
 *
 * **Self-host bypass:** no hosted billing → unlimited (the operator pays their own gateway
 * tokens; the open-core deal).
 */
export async function assertAiAllowed(
	orgId: string,
	kind: AiUsageKind,
	userId?: string,
): Promise<AiCharge> {
	if (!isStripeConfigured()) return { source: "included", credits: 0 };

	const { tier, hardCap } = await resolveAiPlan(orgId);
	const spec = aiTierSpec(tier);
	if (!spec.enabled) {
		throw new AiBudgetError(
			"AI features are not enabled for this workspace.",
			"not_enabled",
			null,
			true,
		);
	}

	const now = Date.now();
	const dayStart = bucketStart(now, DAY_MS);
	const weekStart = bucketStart(now, WEEK_MS);

	const [dayUsed, weekUsed, userDayUsed, userWeekUsed] = await Promise.all([
		sumCredits(orgId, "included", dayStart),
		sumCredits(orgId, "included", weekStart),
		userId
			? sumCreditsForUser(orgId, userId, "included", dayStart)
			: Promise.resolve(0),
		userId
			? sumCreditsForUser(orgId, userId, "included", weekStart)
			: Promise.resolve(0),
	]);

	// FIXED-cost kinds (scan): reserve the nominal cost up front — allowed only if it fits.
	if (kind === "scan") {
		const cost = creditsFor(kind);
		const orgDayOk = dayUsed + cost <= spec.dailyCredits;
		const orgWeekOk = weekUsed + cost <= spec.weeklyCredits;
		const userDayOk = !userId || userDayUsed + cost <= spec.perUserDailyCredits;
		const userWeekOk = !userId || userWeekUsed + cost <= spec.perUserWeeklyCredits;

		if (orgDayOk && orgWeekOk && userDayOk && userWeekOk) {
			return { source: "included", credits: cost };
		}
		// Per-seat fairness cap is the binding limit while the ORG still has included room.
		if (orgDayOk && orgWeekOk && (!userDayOk || !userWeekOk)) {
			throwPersonalCap(!userWeekOk, dayStart, weekStart);
		}
		// Org included budget exhausted — spend purchased top-ups unless the hard cap says pause.
		if (!hardCap && (await purchasedBalance(orgId)) >= cost) {
			return { source: "purchased", credits: cost };
		}
		throwOrgCap(!orgWeekOk, dayStart, weekStart);
	}

	// METERED kinds (agent/support): the real cost isn't known yet → gate on HEADROOM. The
	// turn settles its actual cost-of-serve afterward; overshoot by ≤1 turn is fine.
	const orgDayOk = dayUsed < spec.dailyCredits;
	const orgWeekOk = weekUsed < spec.weeklyCredits;
	const userDayOk = !userId || userDayUsed < spec.perUserDailyCredits;
	const userWeekOk = !userId || userWeekUsed < spec.perUserWeeklyCredits;

	if (orgDayOk && orgWeekOk && userDayOk && userWeekOk) {
		return { source: "included", settle: true };
	}
	// Per-seat fairness cap is the binding limit while the ORG still has included headroom:
	// block THIS seat (don't silently divert to purchased packs). Fail-closed.
	if (orgDayOk && orgWeekOk && (!userDayOk || !userWeekOk)) {
		throwPersonalCap(!userWeekOk, dayStart, weekStart);
	}
	// Org included headroom is gone for this bucket — settle against purchased top-ups if any,
	// unless the org's hard-cap policy says to pause at the included allowance instead.
	if (!hardCap && (await purchasedBalance(orgId)) > 0) {
		return { source: "purchased", settle: true };
	}
	throwOrgCap(!orgWeekOk, dayStart, weekStart);
}
