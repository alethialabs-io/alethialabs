// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import "server-only";
import { aiTierSpec, resolveAiTier } from "@/lib/billing/ai-plan";
import { creditsFor } from "@/lib/billing/ai-credits";
import {
	type AiUsageKind,
	type CreditSource,
	purchasedBalance,
	sumCredits,
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

/** Decision returned by the guard: how to charge the allowed action. */
export interface AiCharge {
	source: CreditSource;
	credits: number;
}

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;

/** Fixed day/week buckets (epoch-aligned) → clean reset times + simple sums. */
function bucketStart(now: number, sizeMs: number): Date {
	return new Date(Math.floor(now / sizeMs) * sizeMs);
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
 * it (caller records via `recordAiUsage`); throws `AiBudgetError` when out. **Self-host
 * bypass:** no hosted billing → unlimited (the operator pays their own gateway tokens;
 * the open-core deal).
 */
export async function assertAiAllowed(
	orgId: string,
	kind: AiUsageKind,
): Promise<AiCharge> {
	if (!isStripeConfigured()) return { source: "included", credits: 0 };

	const tier = await resolveAiTier(orgId);
	const spec = aiTierSpec(tier);
	if (!spec.enabled) {
		throw new AiBudgetError(
			"AI features are not enabled for this workspace.",
			"not_enabled",
			null,
			true,
		);
	}

	const cost = creditsFor(kind);
	const now = Date.now();
	const dayStart = bucketStart(now, DAY_MS);
	const weekStart = bucketStart(now, WEEK_MS);

	const [dayUsed, weekUsed] = await Promise.all([
		sumCredits(orgId, "included", dayStart),
		sumCredits(orgId, "included", weekStart),
	]);

	const dayOk = dayUsed + cost <= spec.dailyCredits;
	const weekOk = weekUsed + cost <= spec.weeklyCredits;
	if (dayOk && weekOk) {
		return { source: "included", credits: cost };
	}

	// Included budget exhausted for this bucket — spend purchased top-ups if any.
	if ((await purchasedBalance(orgId)) >= cost) {
		return { source: "purchased", credits: cost };
	}

	// The weekly cap is the harder stop (buying credits is the only immediate remedy);
	// otherwise it's the daily cap, which also clears at midnight UTC.
	const weeklyHit = !weekOk;
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
