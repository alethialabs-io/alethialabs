// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { AiUsageKind } from "@/lib/billing/ai-quota";

// Cost-weighted AI credits. A credit is a slice of real **cost-of-serve** — not a message
// count — so the daily/weekly caps bound actual $ spend, not turn count. A cheap one-line
// question costs a few credits; a 40k-token deep tool-loop costs many more, naturally, with
// no multiplier. Internal — never shown to users. See lib/billing/ai-quota.ts (settle path).

/** One credit = $0.001 of cost-of-serve (1000 USD micros). The atomic metering unit. */
export const CREDIT_UNIT_MICROS = 1000;

/**
 * Convert a metered turn's real cost (USD micros, snapshotted per model row via
 * `aiCostMicros`) into cost-weighted credits, rounding UP so every fraction of a
 * cent is charged. E.g. a ~$0.084 Sonnet turn (84_000 micros) ≈ 84 credits; a
 * ~$0.117 Opus turn (117_000 micros) ≈ 117 — Opus costs more because it *is* more
 * expensive to serve, not because of a per-tier multiplier.
 */
export function costToCredits(costMicros: number): number {
	return Math.ceil(costMicros / CREDIT_UNIT_MICROS);
}

/**
 * A repo scan's FIXED nominal charge in the cost-of-serve unit (≈$0.20). A scan's real
 * cost lands on the runner job (a clone + static parse), not the AI ledger, so it has no
 * per-turn token cost to settle — it stays a fixed reservation booked up front.
 */
export const SCAN_CREDITS = 200;

/**
 * Credits a FIXED-cost AI action reserves up front. Only `scan` is fixed today (its real
 * cost is on the runner job, not the AI ledger). Metered chat turns do NOT use this — they
 * settle their real cost-of-serve after the turn (see `costToCredits` + the guard's settle
 * path), so there is no per-message credit here.
 */
export function creditsFor(kind: AiUsageKind): number {
	return kind === "scan" ? SCAN_CREDITS : 0;
}

/** A purchasable top-up credit pack (one-time). Amount is in cents (USD). */
export interface CreditPack {
	id: string;
	credits: number;
	amountCents: number;
}

// Packs are priced with $/credit comfortably ABOVE the $0.001 cost-of-serve (maintainer-
// tunable placeholders; still gated behind "Coming soon"). Larger packs = better $/credit.
export const AI_CREDIT_PACKS: CreditPack[] = [
	{ id: "s", credits: 5_000, amountCents: 1_900 }, // $19 → $0.0038/cr
	{ id: "m", credits: 20_000, amountCents: 5_900 }, // $59 → $0.00295/cr
	{ id: "l", credits: 60_000, amountCents: 14_900 }, // $149 → $0.00248/cr
];

export function creditPack(id: string): CreditPack | undefined {
	return AI_CREDIT_PACKS.find((p) => p.id === id);
}
