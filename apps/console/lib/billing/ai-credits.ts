// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { AiUsageKind } from "@/lib/billing/ai-quota";

// Credit cost per AI action. A scan is heavy (a runner job + a large inference); a
// message is light. Internal — never shown to users. Tune freely.
export const SCAN_CREDITS = 20;
export const MESSAGE_CREDITS = 1;

/** Credits a metered AI action costs. */
export function creditsFor(kind: AiUsageKind): number {
	return kind === "scan" ? SCAN_CREDITS : MESSAGE_CREDITS;
}

/** A purchasable top-up credit pack (one-time). Amount is in cents (USD). */
export interface CreditPack {
	id: string;
	credits: number;
	amountCents: number;
}

export const AI_CREDIT_PACKS: CreditPack[] = [
	{ id: "s", credits: 500, amountCents: 900 },
	{ id: "m", credits: 2_000, amountCents: 2_900 },
	{ id: "l", credits: 5_000, amountCents: 5_900 },
];

export function creditPack(id: string): CreditPack | undefined {
	return AI_CREDIT_PACKS.find((p) => p.id === id);
}
