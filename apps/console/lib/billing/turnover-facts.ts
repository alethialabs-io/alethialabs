// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The read behind the tax-threshold totals (#7327, EA-5) and the check the purchase gate runs before
// a sale (#7352). A LEAF on purpose: it imports only `@repo/legal`, the database handle and the schema.
//
// Why a leaf. The gate (`turnover.ts`) is reached from every billing action. Importing
// `invoice-facts.ts` would pull the webhook's recording, refund and фактура graph (`invoices.ts` →
// `factura/issue.ts`) into all of them, and while that graph was an import cycle (#7352) it failed
// `next build` with "Cannot access … before initialization". The gate reads from here instead, and so
// does `invoice-facts.ts`, so there is still exactly one read and one assessment.

import {
	assessSaleAgainstTurnover,
	type ProspectiveSale,
	type SaleAssessment,
	type TurnoverFact,
	type TurnoverTotals,
	turnoverTotals,
	turnoverWindowStart,
} from "@repo/legal/turnover";
import { gte } from "drizzle-orm";
import { getServiceDb } from "@/lib/db";
import { invoice } from "@/lib/db/schema";

/** An invoice row, with its id, as the recording and the totals read it. */
export interface InvoiceFactRow extends TurnoverFact {
	readonly id: string;
	readonly eurRateSource: string | null;
}

/** The invoice columns the facts read, selected once. */
export const INVOICE_FACT_COLUMNS = {
	id: invoice.id,
	status: invoice.status,
	paidAt: invoice.paidAt,
	currency: invoice.currency,
	amountMinor: invoice.amountTotal,
	amountEurMinor: invoice.amountEurMinor,
	country: invoice.customerCountry,
	state: invoice.customerState,
	capacity: invoice.payerCapacity,
	vatIdGiven: invoice.vatIdGiven,
	eurRateSource: invoice.eurRateSource,
};

/** The gate's read: every invoice row paid at or after `since`, outside any lock. */
export interface TurnoverFactsReader {
	factsSince(since: Date): Promise<InvoiceFactRow[]>;
}

/** The live read over `getServiceDb()`. */
export const liveTurnoverFactsReader: TurnoverFactsReader = {
	async factsSince(since) {
		return getServiceDb().select(INVOICE_FACT_COLUMNS).from(invoice).where(gte(invoice.paidAt, since));
	},
};

/** Every running total as of `now`, summed from the invoice rows by `@repo/legal/turnover`. */
export async function readTurnoverTotals(
	now: Date = new Date(),
	store: TurnoverFactsReader = liveTurnoverFactsReader,
): Promise<TurnoverTotals> {
	return turnoverTotals(await store.factsSince(turnoverWindowStart(now)), now);
}

/**
 * The check EA-2's gate runs BEFORE taking a sale: the totals as they stand, with this sale added,
 * against each threshold it counts toward. `stop` means refuse with `threshold_reached`. A database
 * error throws, and the gate must treat a throw as a refusal.
 */
export async function assessSaleBeforeCharge(
	sale: ProspectiveSale,
	opts: { now?: Date; store?: TurnoverFactsReader; warnMargin?: number } = {},
): Promise<SaleAssessment> {
	const totals = await readTurnoverTotals(opts.now, opts.store);
	return assessSaleAgainstTurnover(totals, sale, opts.warnMargin);
}
