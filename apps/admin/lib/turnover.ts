// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The staff turnover read (#7327, EA-5): every running total the tax thresholds read, from the
// console-owned `invoice` table, summed and assessed by `@repo/legal/turnover` — the same functions
// the console's purchase gate calls (apps/console/lib/billing/invoice-facts.ts). The page therefore
// cannot show "ok" for a total the gate refuses on.
//
// The table is declared here read-only and only as far as this read needs it; the console owns it
// and its migrations (apps/console/lib/db/schema/invoices.ts). No migrations are generated here.

import {
	assessTurnover,
	type TurnoverAssessments,
	type TurnoverTotals,
	turnoverTotals,
	turnoverWindowStart,
} from "@repo/legal/turnover";
import type { PayerCapacity } from "@repo/legal/commerce";
import { gte } from "drizzle-orm";
import { boolean, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { getServiceDb } from "@/lib/db";

/** The console's `invoice` table: the payment and the tax snapshot columns, read-only. */
const invoice = pgTable("invoice", {
	id: uuid().primaryKey(),
	status: text().notNull(),
	amountTotal: integer().notNull(),
	currency: text().notNull(),
	paidAt: timestamp({ withTimezone: true }),
	customerCountry: text(),
	customerState: text(),
	payerCapacity: text().$type<PayerCapacity>(),
	vatIdGiven: boolean(),
	amountEurMinor: integer(),
});

/** The totals and their assessments as of one moment. */
export interface TurnoverReport {
	readonly asOf: Date;
	readonly totals: TurnoverTotals;
	readonly assessments: TurnoverAssessments;
}

/**
 * Reads every invoice paid inside the longest measuring window and returns the running totals with
 * their threshold assessments, as of `now`. Cross-tenant, on the service connection.
 */
export async function turnoverReport(now: Date = new Date()): Promise<TurnoverReport> {
	const rows = await getServiceDb()
		.select({
			status: invoice.status,
			paidAt: invoice.paidAt,
			currency: invoice.currency,
			amountMinor: invoice.amountTotal,
			amountEurMinor: invoice.amountEurMinor,
			country: invoice.customerCountry,
			state: invoice.customerState,
			capacity: invoice.payerCapacity,
			vatIdGiven: invoice.vatIdGiven,
		})
		.from(invoice)
		.where(gte(invoice.paidAt, turnoverWindowStart(now)));
	const totals = turnoverTotals(rows, now);
	return { asOf: now, totals, assessments: assessTurnover(totals) };
}
