// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The list of cells paid conversion is open for, and nothing else (#7320, EA-1).
//
// It lives in its own file so that opening a cell is a one-file diff that changes no rule: the
// types, the matching and the reasons stay in commerce.ts and launch.ts, and a review of this file
// reads only "which cells, on what evidence". `commerce.ts` re-exports it, so every existing import
// of `PAID_MARKETS` from `@repo/legal/commerce` keeps working.

import type { PaidMarketCell } from "./commerce";

/**
 * The country × capacity (× VAT-number status) cells paid conversion is enabled for.
 *
 * ⚠️ IT IS EMPTY, AND EMPTY IS THE CORRECT STATE TODAY. Adding a cell is the maintainer's decision,
 * made in its own PR, and it needs every condition in `docs/legal/PAID_MARKETS.md` met first.
 *
 * A cell may be added ONLY when all four hold, and the evidence string must say which:
 *
 *  1. **Tax** — a registration that covers the sale, or a documented basis for charging none, and
 *     the product's tax code named.
 *  2. **Stripe** — the account is live (not test), enabled for that country's payment methods, with
 *     the tax and invoicing settings the sale needs.
 *  3. **Contractual** — Terms, and for `consumer` cells the consumer-rights disclosures, published
 *     in a language the market requires, at a version whose hash is sealed (see documents.ts).
 *  4. **Commercial rights** — for `consumer` cells: the withdrawal, confirmation and ADR duties are
 *     implemented AND the ADR body named in CONSUMER_ADR is the correct one for that country.
 *
 * **The VAT-number dimension.** An `organization` cell may carry `vatId`:
 *
 *  - `vatId: "not_given"` opens only buyers who declared that they have no VAT number. This is the
 *    cell for an EU business outside Bulgaria while the seller is not VAT-registered: the sale rests
 *    on the Art. 18(2) presumption and counts toward the EUR 10,000 threshold (thresholds.ts).
 *  - `vatId: "given"` opens only buyers who gave one. Outside Bulgaria in the EU that sale needs the
 *    seller's own registration first (`docs/legal/TAX_MARKET_PRECONDITIONS.md` §3.3).
 *  - no `vatId` opens both. For an EU business outside Bulgaria the buyer must still have DECLARED
 *    a status: an undeclared one is refused (`paidMarketEnabled`).
 *
 * `vatId` belongs on `organization` cells only. A `consumer` cell carrying one never matches.
 */
export const PAID_MARKETS: readonly PaidMarketCell[] = [];
