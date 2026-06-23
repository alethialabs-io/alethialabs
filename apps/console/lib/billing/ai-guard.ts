// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import "server-only";
import { creditsFor } from "@/lib/billing/ai-credits";
import {
	type AiUsageKind,
	type CreditSource,
	purchasedBalance,
	sumCredits,
} from "@/lib/billing/ai-quota";
import { isStripeConfigured } from "@/lib/billing/config";
import { resolvePlanEntitlements } from "@/lib/billing/plan";
import { getOrgBilling } from "@/lib/billing/queries";

/** Thrown when an org is out of AI credits; mapped to an upgrade / buy-credits CTA. */
export class AiBudgetError extends Error {
	constructor(
		message: string,
		readonly reason: "not_enabled" | "window" | "weekly" | "out",
		/** ISO time the blocking window resets (null when only buying credits helps). */
		readonly resetAt: string | null,
		/** Whether upgrading the plan would lift the block. */
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
const WEEK_MS = 7 * 24 * HOUR_MS;

/** Fixed window/week buckets (epoch-aligned) → clean reset times + simple sums. */
function bucketStart(now: number, sizeMs: number): Date {
	return new Date(Math.floor(now / sizeMs) * sizeMs);
}

/**
 * Coarse access gate for the AI *surface* (the MCP endpoint): is AI enabled for this
 * org at all? Unlike assertAiAllowed it charges nothing — per-call metering still
 * rides each tool (e.g. scanner → assertAiAllowed("scan")). **Self-host bypass:** no
 * hosted billing → always enabled (open-core; the operator pays their own gateway).
 */
export async function isAiSurfaceEnabled(orgId: string): Promise<boolean> {
	if (!isStripeConfigured()) return true;
	const billing = await getOrgBilling(orgId).catch(() => null);
	return resolvePlanEntitlements(
		billing?.plan ?? "community",
		billing?.status ?? "none",
	).ai.enabled;
}

/**
 * Gate a metered AI action against the org's credit budget — a short fixed **window**
 * + a **weekly** cap (both scaled by the plan multiplier), spending **included** credits
 * first, then **purchased** top-ups. Returns how to charge it (caller records via
 * `recordAiUsage`); throws `AiBudgetError` when out. **Self-host bypass:** no hosted
 * billing → unlimited (the operator pays their own gateway tokens; the open-core deal).
 */
export async function assertAiAllowed(
	orgId: string,
	kind: AiUsageKind,
): Promise<AiCharge> {
	if (!isStripeConfigured()) return { source: "included", credits: 0 };

	const billing = await getOrgBilling(orgId).catch(() => null);
	const ai = resolvePlanEntitlements(
		billing?.plan ?? "community",
		billing?.status ?? "none",
	).ai;
	if (!ai.enabled) {
		throw new AiBudgetError(
			"AI features require an active plan. Upgrade to enable them.",
			"not_enabled",
			null,
			true,
		);
	}

	const cost = creditsFor(kind);
	const now = Date.now();
	const windowMs = ai.windowHours * HOUR_MS;
	const windowStart = bucketStart(now, windowMs);
	const weekStart = bucketStart(now, WEEK_MS);

	const windowUsed = await sumCredits(orgId, "included", windowStart);
	const weekUsed = await sumCredits(orgId, "included", weekStart);

	if (windowUsed + cost <= ai.windowCredits && weekUsed + cost <= ai.weeklyCredits) {
		return { source: "included", credits: cost };
	}

	// Included budget exhausted — spend purchased top-ups if any.
	if ((await purchasedBalance(orgId)) >= cost) {
		return { source: "purchased", credits: cost };
	}

	const weeklyHit = weekUsed + cost > ai.weeklyCredits;
	throw new AiBudgetError(
		weeklyHit
			? "You're out of AI usage for this week. Upgrade or add credits."
			: "You're out of AI usage for now. It resets shortly, or upgrade / add credits.",
		weeklyHit ? "weekly" : "window",
		new Date(
			weeklyHit
				? bucketStart(now, WEEK_MS).getTime() + WEEK_MS
				: windowStart.getTime() + windowMs,
		).toISOString(),
		true,
	);
}
