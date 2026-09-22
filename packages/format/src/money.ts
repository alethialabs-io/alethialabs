// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * An amount and the currency it is quoted in, held together in one value.
 *
 * ── WHY A TYPE AND NOT A CONVENTION ──────────────────────────────────────────────────────────
 *
 * #4176 measured the console's money layer and found the same defect nine times: an amount
 * travelling as a bare `number` while its currency stayed behind. `formatMoney(monthly * 100)`
 * took a `currency = "USD"` default and rendered a EUR subscription with a dollar sign. #4176's
 * part (a) removed that default, which turned the nine into compile errors and made each caller
 * NAME a currency — but naming one at the render site is the weaker half of the fix, because the
 * name it can reach is whatever the local variable happens to be called. The field was called
 * `unitAmountUsd` and held euros.
 *
 * A `Money` cannot be built without saying which currency it is in, and cannot be passed on
 * without carrying it. That is the whole of the idea; everything below is bookkeeping.
 *
 * ── MINOR UNITS, ALWAYS ──────────────────────────────────────────────────────────────────────
 *
 * `minor` is what Stripe quotes a charge in and what `invoices.amount`, `transactions.amount` and
 * `cost.amount_cents` store. Converting to major units early is what created the `* 100` sites
 * #4176 catalogued: `getBillingSummary` divided Stripe's `unit_amount` by a fixed 100 and the
 * billing panel multiplied it back by a fixed 100 three renders later, so the two halves of one
 * conversion sat in different files and only cancelled by luck.
 *
 * `moneyFromMajor` exists for the inputs that genuinely arrive in major units — a catalog figure
 * a person typed, an AI tool's `*_usd` wire field — and it asks {@link stripeChargeDivisor} rather
 * than assuming 100, so the conversion is right for a zero-decimal currency too.
 *
 * ── WHAT IS STILL NOT COVERED ────────────────────────────────────────────────────────────────
 *
 * Three-decimal currencies (BHD, JOD, KWD, OMR, TND). `moneyFromMajor(12.4, "BHD")` answers 1240
 * minor units where the true answer is 12400, because `stripeChargeDivisor` has no three-decimal
 * row to consult — Stripe no longer publishes a list to cite, so none is invented. See the module
 * doc in `minor-units.ts`.
 *
 * NOTHING IN #4176's PART (b) MADE THAT REACHABLE, and it is worth saying which way round that
 * runs. A three-decimal code could already reach `formatMoney` before this file existed, through
 * `invoices.currency` and `transactions.currency` — free `text()` mirrored from Stripe, rendered
 * with the row's own code since long before #4836. What part (b) changes is the path a PLAN price
 * takes, and that path is still gated by `asSupportedCurrency` (`"usd" | "eur"`), so it admits no
 * third currency at all. The gap is exactly where it was; it is restated here because a reader
 * who finds `Money` first should not have to rediscover it.
 */

import { stripeChargeDivisor } from "./minor-units";

/**
 * A money amount: how much, and in what.
 *
 * Readonly on purpose. A `Money` is a VALUE — two of them with the same fields are the same
 * money — and every operation below returns a new one rather than editing one in place, so an
 * amount cannot be scaled halfway through a render and observed by the next line.
 */
export interface Money {
	/**
	 * The amount in MINOR units, as Stripe quotes a charge in {@link currency}: 1250 for $12.50,
	 * 124000 for ¥124,000. May be negative (a credit) and may carry a fraction of a minor unit,
	 * which is what a metered estimate produces — `formatMoney` rounds, this does not.
	 */
	readonly minor: number;
	/**
	 * ISO 4217, in either case. Stripe hands back lower case (`"usd"`), the billing tables store
	 * whatever Stripe sent, and CLDR wants upper — so every consumer here upper-cases on the way
	 * into Intl rather than demanding one spelling of its callers. Do NOT normalise it on the way
	 * in: a round-trip through this type must give back the code the row actually holds.
	 */
	readonly currency: string;
}

/**
 * A `Money` from an amount already in MINOR units — the common case, because that is how Stripe
 * and every billing table hold one.
 *
 * @param minor the amount in minor units (cents).
 * @param currency ISO 4217, either case.
 */
export function money(minor: number, currency: string): Money {
	return { minor, currency };
}

/**
 * A `Money` from an amount in MAJOR units — 20 for $20, 12.4 for BHD 12.400.
 *
 * The divisor is {@link stripeChargeDivisor}, not a literal 100, so `moneyFromMajor(500, "JPY")`
 * is 500 minor units and not 50,000. `Math.round` because `minor` is documented as Stripe's
 * integer amount and `29.99 * 100` is `2998.9999999999995`.
 *
 * PREFER {@link money}. Every use of this function is a place where an amount was converted out
 * of minor units earlier than it should have been, and the fix is usually upstream — the catalog
 * now holds minor units for exactly this reason. It is here for the inputs that are not ours to
 * change: an AI tool's `*_usd` wire field, and a human-typed figure.
 *
 * @param major the amount in major units (dollars, euros).
 * @param currency ISO 4217, either case.
 */
export function moneyFromMajor(major: number, currency: string): Money {
	return { minor: Math.round(major * stripeChargeDivisor(currency)), currency };
}

/**
 * The same money multiplied by a count — a per-seat price times the seats, a unit price times the
 * quantity.
 *
 * A separate function rather than `{ ...m, minor: m.minor * n }` at each call site so the currency
 * cannot be dropped by a spread that forgets it, and so the result is provably in the same
 * currency as the input: there is no second currency in scope to get it wrong with.
 *
 * @param value the unit amount.
 * @param factor how many of them. Not rounded — a fractional minor unit is a real intermediate
 *   (a metered rate), and `formatMoney` rounds once, at the end.
 */
export function scaleMoney(value: Money, factor: number): Money {
	return { minor: value.minor * factor, currency: value.currency };
}
