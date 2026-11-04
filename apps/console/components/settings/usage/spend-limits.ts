// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The AI spend limits' input contract (F047, #6127) — ONE module both halves import, so the form's
// inline errors and the server's validation cannot disagree about what a valid limit is. Plain zod,
// no "use client", no server imports.
//
// The limits are ENTERED in dollars per week and STORED in credits ($0.001 each — lib/billing/
// ai-credits.ts) in two `integer` columns (organization_billing.ai_*_weekly_cap_credits).

import { formatMoney, moneyFromMajor } from "@repo/format";
import { z } from "zod";

/** 1 credit = $0.001 (lib/billing/ai-credits.ts), so a dollar is 1,000 credits. */
const CREDITS_PER_DOLLAR = 1_000;

/** A cent is 10 credits. */
const CREDITS_PER_CENT = CREDITS_PER_DOLLAR / 100;

/**
 * The largest weekly limit accepted, in dollars.
 *
 * Why $10,000: a limit only ever TIGHTENS the AI tier's own weekly cap (`min(tier, limit)`,
 * lib/billing/ai-plan.ts), and the largest tier's cap is $75/week — so any value above that is
 * already "no tighter than the plan", and $10,000 leaves two orders of magnitude for tiers that do
 * not exist yet. The hard ceiling it keeps well clear of is the column: 2,147,483,647 credits
 * (~$2.1M) in a Postgres `integer`. The F047 probe's `1e20` overflowed that column and the save
 * failed as an unhandled error with nothing on screen.
 */
export const MAX_WEEKLY_CAP_DOLLARS = 10_000;

/** The ceiling as a person reads it ("$10,000.00"), for the validation message. */
export const MAX_LABEL = formatMoney(moneyFromMajor(MAX_WEEKLY_CAP_DOLLARS, "usd"));

/** The ceiling's validation message — one sentence, shared by the form and the server. */
const TOO_LARGE = `A limit can be at most ${MAX_LABEL} a week.`;

/** The same ceiling in credits — what the server checks. */
export const MAX_WEEKLY_CAP_CREDITS = MAX_WEEKLY_CAP_DOLLARS * CREDITS_PER_DOLLAR;

/** One stored limit: whole credits in [0, MAX], or null for "no limit beyond the plan". */
const capCredits = z
	.number()
	.min(0, "A limit can't be negative.")
	.max(MAX_WEEKLY_CAP_CREDITS, TOO_LARGE)
	// `Number.isInteger`, not `.int()`: zod's `.int()` also refuses anything past 2^53 as "not an
	// integer", which would tell the F047 probe's `1e20` it is a fraction. The ceiling above is the
	// answer that is true of it.
	.refine((n) => Number.isInteger(n), "A limit is a whole number of credits.")
	// Whole CENTS (10 credits): the form takes dollars-and-cents, so a stored limit is always one the
	// form can show and save back unchanged. `toDollars` rounds an older, finer value to the cent.
	.refine((n) => n % CREDITS_PER_CENT === 0, "A limit is a whole number of cents.")
	.nullable();

/** The server's input: both limits, in credits. */
export const aiSpendLimitsInput = z.object({
	orgWeeklyCapCredits: capCredits,
	perUserWeeklyCapCredits: capCredits,
});

/** A pair of limits, in credits (null = no limit). */
export type AiSpendLimits = z.infer<typeof aiSpendLimitsInput>;

/** A field the person types: blank (no limit) or dollars, ≥ 0, ≤ the max, at most cents. */
const dollarsField = z
	.string()
	.trim()
	.refine((v) => !v.startsWith("-"), { message: "A limit can't be negative." })
	.refine((v) => v.startsWith("-") || v === "" || /^\d+(\.\d{1,2})?$/.test(v), {
		message: "Enter an amount in dollars, like 50 or 12.50.",
	})
	.refine((v) => v === "" || Number(v) <= MAX_WEEKLY_CAP_DOLLARS, {
		message: TOO_LARGE,
	});

/**
 * The form's schema. A negative number gets its own message, which is the point: `-5` used to be
 * coerced to "no limit" and saved as such, silently. `1e20` is not dollars-and-cents notation.
 */
export const spendLimitsForm = z.object({
	orgWeeklyCap: dollarsField,
	perUserWeeklyCap: dollarsField,
});

/** The form's values. */
export type SpendLimitsFormValues = z.infer<typeof spendLimitsForm>;

/** Stored credits → the dollars string shown in the field (empty = no limit). */
export function toDollars(credits: number | null): string {
	if (credits == null) return "";
	// Rounded to the cent: a limit stored before limits were whole cents (12,345 credits) would
	// otherwise show as "12.345", which the field's own rule then refuses.
	return String(Math.round(credits / CREDITS_PER_CENT) / 100);
}

/** A VALIDATED dollars field → credits to store (blank = null = no limit). */
export function toCredits(dollars: string): number | null {
	const t = dollars.trim();
	if (!t) return null;
	return Math.round(Number(t) * CREDITS_PER_DOLLAR);
}

/** The server's field names → the form's, for routing a `validation` result to the right input. */
export const SERVER_TO_FORM_FIELD = {
	orgWeeklyCapCredits: "orgWeeklyCap",
	perUserWeeklyCapCredits: "perUserWeeklyCap",
} as const satisfies Record<keyof AiSpendLimits, keyof SpendLimitsFormValues>;
