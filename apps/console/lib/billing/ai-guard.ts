// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import "server-only";
import {
	AI_SESSION_WINDOW_MS,
	aiTierSpec,
	resolveAiPlan,
	resolveAiTier,
} from "@/lib/billing/ai-plan";
import { creditsFor } from "@/lib/billing/ai-credits";
import {
	type AiUsageKind,
	type CreditSource,
	oldestUsageForUserSince,
	oldestUsageSince,
	purchasedBalance,
	sumCredits,
	sumCreditsForUser,
} from "@/lib/billing/ai-quota";
import { isStripeConfigured } from "@/lib/billing/config";

/** Thrown when an org is out of AI credits; mapped to an upgrade / buy-credits CTA. */
export class AiBudgetError extends Error {
	constructor(
		message: string,
		readonly reason: "not_enabled" | "session" | "weekly" | "out",
		/** ISO time the blocking window clears (null when only buying credits helps). */
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

/** Fixed week bucket (epoch-aligned) → a clean shared weekly reset + simple sums. */
function bucketStart(now: number, sizeMs: number): Date {
	return new Date(Math.floor(now / sizeMs) * sizeMs);
}

/**
 * When a blocked ROLLING session fully clears: the oldest included usage inside the
 * trailing 5-hour window + the window size (capacity actually frees gradually as usage
 * ages out; this is the conservative "all clear" moment). Per-seat when `userId` is
 * given. Null-defensive — a blocked caller has usage in the window by definition, but a
 * racing window edge must not turn the budget error into a crash.
 */
async function sessionResetIso(
	orgId: string,
	userId?: string,
): Promise<string | null> {
	const since = new Date(Date.now() - AI_SESSION_WINDOW_MS);
	const oldest = userId
		? await oldestUsageForUserSince(orgId, userId, "included", since)
		: await oldestUsageSince(orgId, "included", since);
	return oldest
		? new Date(oldest.getTime() + AI_SESSION_WINDOW_MS).toISOString()
		: null;
}

/**
 * Throw the **per-seat** (personal) budget error — this seat has exhausted its personal
 * session/weekly sub-cap while the ORG still has included room. Not upgradable (buying
 * org credits / upgrading doesn't lift a personal cap; it clears as the window rolls).
 */
function throwPersonalCap(weeklyHit: boolean, resetAt: string | null): never {
	throw new AiBudgetError(
		weeklyHit
			? "You've reached your personal AI usage limit for this week. It resets soon — an admin can raise the per-seat limit."
			: "You've reached your personal AI usage limit for this session. It frees up as usage rolls out of the 5-hour window — an admin can raise the per-seat limit.",
		weeklyHit ? "weekly" : "session",
		resetAt,
		false,
	);
}

/**
 * Throw the **org-level** budget error — the org's included allowance for this window is
 * spent (and no purchased top-up covers it). Upgradable: a higher tier lifts it.
 */
function throwOrgCap(weeklyHit: boolean, resetAt: string | null): never {
	throw new AiBudgetError(
		weeklyHit
			? "You're out of included AI usage for this week. Upgrade your AI plan or wait for the weekly reset."
			: "You're out of included AI usage for this session. It frees up as usage rolls out of the 5-hour window.",
		weeklyHit ? "weekly" : "session",
		resetAt,
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
 * Gate a metered AI action against the org's AI-tier budget — a rolling **5-hour session**
 * cap + a fixed **weekly** cap (both from the org's standalone AI tier, INDEPENDENT of the
 * org plan), spending **included** credits first, then **purchased** top-ups. The two
 * windows are independent, Anthropic-style: sessions roll continuously, so a heavy day can
 * legitimately exhaust the whole week. Returns how to charge it (caller records via
 * `recordAiUsage`); throws `AiBudgetError` when out.
 *
 * Two charge models by kind:
 *  - **Fixed (`scan`)** — a nominal cost (`creditsFor`) is *reserved* up front: allowed only
 *    if `used + cost <= cap`. The returned charge carries that `credits` figure.
 *  - **Metered (`agent`/`support`)** — the real cost-of-serve is only known AFTER the turn, so
 *    the gate checks **headroom** instead: allowed if the window still has ANY room
 *    (`used < cap`). The returned charge is `{ settle: true }`; the caller settles the actual
 *    cost (derived from `cost_micros`) when the turn finishes. A turn that starts with headroom
 *    may overshoot its window by ≤1 turn — standard/accepted; the NEXT turn blocks.
 *
 * When `userId` is supplied, an additional **per-seat** session + weekly sub-cap is enforced on
 * top of the org caps (a fraction of the org allowance — see `AiTierSpec.perUser*`), so one
 * member can't drain the whole workspace's included budget. A seat that has exhausted its
 * personal share while the org still has room is blocked (buying org credits doesn't lift a
 * per-seat cap; it clears as usage rolls out of the window). Omitting `userId` preserves the
 * org-only behaviour (back-compat).
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
	const sessionSince = new Date(now - AI_SESSION_WINDOW_MS);
	const weekStart = bucketStart(now, WEEK_MS);
	const weekResetIso = new Date(weekStart.getTime() + WEEK_MS).toISOString();

	const [sessionUsed, weekUsed, userSessionUsed, userWeekUsed] =
		await Promise.all([
			sumCredits(orgId, "included", sessionSince),
			sumCredits(orgId, "included", weekStart),
			userId
				? sumCreditsForUser(orgId, userId, "included", sessionSince)
				: Promise.resolve(0),
			userId
				? sumCreditsForUser(orgId, userId, "included", weekStart)
				: Promise.resolve(0),
		]);

	// FIXED-cost kinds (scan): reserve the nominal cost up front — allowed only if it fits.
	if (kind === "scan") {
		const cost = creditsFor(kind);
		const orgSessionOk = sessionUsed + cost <= spec.sessionCredits;
		const orgWeekOk = weekUsed + cost <= spec.weeklyCredits;
		const userSessionOk =
			!userId || userSessionUsed + cost <= spec.perUserSessionCredits;
		const userWeekOk =
			!userId || userWeekUsed + cost <= spec.perUserWeeklyCredits;

		if (orgSessionOk && orgWeekOk && userSessionOk && userWeekOk) {
			return { source: "included", credits: cost };
		}
		// Per-seat fairness cap is the binding limit while the ORG still has included room.
		if (orgSessionOk && orgWeekOk && (!userSessionOk || !userWeekOk)) {
			throwPersonalCap(
				!userWeekOk,
				!userWeekOk ? weekResetIso : await sessionResetIso(orgId, userId),
			);
		}
		// Org included budget exhausted — spend purchased top-ups unless the hard cap says pause.
		if (!hardCap && (await purchasedBalance(orgId)) >= cost) {
			return { source: "purchased", credits: cost };
		}
		throwOrgCap(
			!orgWeekOk,
			!orgWeekOk ? weekResetIso : await sessionResetIso(orgId),
		);
	}

	// METERED kinds (agent/support): the real cost isn't known yet → gate on HEADROOM. The
	// turn settles its actual cost-of-serve afterward; overshoot by ≤1 turn is fine.
	const orgSessionOk = sessionUsed < spec.sessionCredits;
	const orgWeekOk = weekUsed < spec.weeklyCredits;
	const userSessionOk = !userId || userSessionUsed < spec.perUserSessionCredits;
	const userWeekOk = !userId || userWeekUsed < spec.perUserWeeklyCredits;

	if (orgSessionOk && orgWeekOk && userSessionOk && userWeekOk) {
		return { source: "included", settle: true };
	}
	// Per-seat fairness cap is the binding limit while the ORG still has included headroom:
	// block THIS seat (don't silently divert to purchased packs). Fail-closed.
	if (orgSessionOk && orgWeekOk && (!userSessionOk || !userWeekOk)) {
		throwPersonalCap(
			!userWeekOk,
			!userWeekOk ? weekResetIso : await sessionResetIso(orgId, userId),
		);
	}
	// Org included headroom is gone for this window — settle against purchased top-ups if any,
	// unless the org's hard-cap policy says to pause at the included allowance instead.
	if (!hardCap && (await purchasedBalance(orgId)) > 0) {
		return { source: "purchased", settle: true };
	}
	throwOrgCap(
		!orgWeekOk,
		!orgWeekOk ? weekResetIso : await sessionResetIso(orgId),
	);
}
