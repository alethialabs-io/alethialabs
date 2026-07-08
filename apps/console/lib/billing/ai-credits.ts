// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { AiUsageKind } from "@/lib/billing/ai-quota";

// Credit cost per AI action. A scan is heavy (a runner job + a large inference); a
// message is light. Internal — never shown to users. Tune freely.
export const SCAN_CREDITS = 20;
export const MESSAGE_CREDITS = 1;
/** A "deep reasoning" (Opus advisor) message costs double a normal message. */
export const DEEP_REASONING_CREDITS = 2;

/**
 * Credits a metered AI action costs. A scan is always the heavy flat rate; a message is 1,
 * except a "deep reasoning" (Opus advisor) turn which costs {@link DEEP_REASONING_CREDITS}.
 * The deep-reasoning cost is tier-agnostic — the caller (route/config/UI) gates who may set it.
 */
export function creditsFor(
	kind: AiUsageKind,
	opts?: { deepReasoning?: boolean },
): number {
	if (kind === "scan") return SCAN_CREDITS;
	return opts?.deepReasoning ? DEEP_REASONING_CREDITS : MESSAGE_CREDITS;
}

/** A purchasable top-up credit pack (one-time). Amount is in cents (USD). */
export interface CreditPack {
	id: string;
	credits: number;
	amountCents: number;
}

export const AI_CREDIT_PACKS: CreditPack[] = [
	{ id: "s", credits: 100, amountCents: 2_500 },
	{ id: "m", credits: 500, amountCents: 9_900 },
	{ id: "l", credits: 1_500, amountCents: 24_900 },
];

export function creditPack(id: string): CreditPack | undefined {
	return AI_CREDIT_PACKS.find((p) => p.id === id);
}
