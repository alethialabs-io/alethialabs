// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The cells self-serve card sales through the merchant of record (Paddle) are open for, and
// nothing else (paddle-billing plan, lane L6a).
//
// A sibling of paid-markets.ts, not a flag on it, because the two answer different questions.
// PAID_MARKETS says where ALETHIA LABS may be the seller of record: every cell there needs our own
// tax position, payment account and invoicing for that country. Here Paddle is the seller of record
// — it charges and remits the tax and issues the customer's invoice — so the per-country tax
// conditions do not apply, and a cell needs only the conditions in `docs/legal/PAID_MARKETS.md`
// § "Merchant-of-record cells". Keeping it in its own file keeps opening a cell a one-file diff that
// changes no rule.

import { PAYER_CAPACITIES, type PayerCapacity } from "./commerce";

/** One country × capacity pair the merchant of record may sell into on our behalf. */
export interface MorMarketCell {
	/** ISO 3166-1 alpha-2, upper-case. */
	readonly country: string;
	readonly capacity: PayerCapacity;
	/** The evidence that opened this cell — an audit trail, not a comment. */
	readonly evidence: string;
}

/**
 * The country × capacity cells self-serve card sales through Paddle are enabled for.
 *
 * ⚠️ IT IS EMPTY, AND EMPTY IS THE CORRECT STATE TODAY. Opening a cell is the maintainer's decision,
 * made in its own one-file PR, no earlier than the VAT registration taking effect, and only once
 * every condition in `docs/legal/PAID_MARKETS.md` § "Merchant-of-record cells" holds:
 *
 *  1. **Paddle** — the live account is verified and alethialabs.io passed Paddle's domain review.
 *  2. **Contractual** — the Terms and the consumer-rights page naming Paddle as reseller are sealed
 *     (documents.ts) and on production.
 *  3. **Books** — the accountant's written opinion on the supply to Paddle (ЗДДС чл. 21(2)) and on
 *     Наредба Н-18 is on file.
 *
 * There is no VAT-number dimension: Paddle, as the seller, decides the buyer's tax treatment, so the
 * buyer's VAT-number status does not change whether we may sell.
 */
export const MOR_MARKETS: readonly MorMarketCell[] = [];

/** The country as an upper-case alpha-2 code, or `null` when it is missing or not two characters. */
function normaliseCountry(country: string | null | undefined): string | null {
	if (!country) return null;
	const iso = country.trim().toUpperCase();
	return iso.length === 2 ? iso : null;
}

/**
 * The cell in `cells` that opens this buyer, or `undefined` — the one matching rule for
 * merchant-of-record sales. FAIL-CLOSED: a missing or malformed country, or an undeclared or unknown
 * capacity, matches nothing, and an empty list matches nothing.
 */
export function matchMorMarketCell(
	cells: readonly MorMarketCell[],
	country: string | null | undefined,
	capacity: PayerCapacity | null | undefined,
): MorMarketCell | undefined {
	const iso = normaliseCountry(country);
	if (iso === null || !capacity || !PAYER_CAPACITIES.includes(capacity)) return undefined;
	return cells.find((cell) => cell.country === iso && cell.capacity === capacity);
}

/** Whether Paddle may sell to this buyer on our behalf today; refuses everything while MOR_MARKETS is empty. */
export function morMarketEnabled(
	country: string | null | undefined,
	capacity: PayerCapacity | null | undefined,
): boolean {
	return matchMorMarketCell(MOR_MARKETS, country, capacity) !== undefined;
}
