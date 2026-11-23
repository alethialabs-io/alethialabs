// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Locally-mirrored invoices — Alethia's own record of every invoice for which money
// actually moved. Stripe stays the payment rail, but we mirror its finalized+paid
// invoices into this table (via the Stripe webhook) so the billing UI never has to hit
// the Stripe API at page load, never surfaces never-paid draft/void artifacts, and owns
// the invoice document (a self-hosted PDF in object storage, not Stripe's expiring
// hosted link). One row per Stripe invoice (stripe_invoice_id unique → idempotent
// mirror: a replayed webhook converges to the same row).

import { sql } from "drizzle-orm";
import {
	boolean,
	check,
	integer,
	numeric,
	pgTable,
	text,
	timestamp,
	uuid,
} from "drizzle-orm/pg-core";
import { invoiceStatus, payerCapacity } from "./enums";
import { organization } from "./organizations";

/**
 * Where the Bulgarian invoice of record (фактура, Art. 113 ЗДДС) for this payment stands. `pending`
 * means it is still owed (lib/billing/factura/issue.ts named why, and the operator was alerted); a
 * replay of the Stripe event retries it. `issued` means the document exists (the `factura` row);
 * `failed` means retries stopped and an operator must act. NULL on rows mirrored before the
 * фактура pipeline existed.
 */
export const FACTURA_STATUSES = ["pending", "issued", "failed"] as const;

/** One of `FACTURA_STATUSES`. */
export type FacturaStatus = (typeof FACTURA_STATUSES)[number];

/** `'a', 'b', …` for a CHECK constraint's IN list, from a closed list of literals declared here. */
function sqlList(values: readonly string[]): string {
	return values.map((v) => `'${v}'`).join(", ");
}

export const invoice = pgTable("invoice", {
	id: uuid().primaryKey().defaultRandom(),
	organizationId: uuid()
		.notNull()
		.references(() => organization.id, { onDelete: "cascade" }),
	// Stripe's invoice id — the idempotency / mirror key. Unique so a replayed webhook
	// (Stripe retries deliveries) upserts the one row rather than duplicating it.
	stripeInvoiceId: text().notNull().unique(),
	stripeCustomerId: text(),
	// Stripe's finalized human-facing number (e.g. "OQDLWV3B-0031") — kept so our record
	// matches the PDF document. Null only for the rare invoice Stripe never numbered.
	number: text(),
	status: invoiceStatus().notNull(),
	// Total in the smallest currency unit (cents) + the ISO currency code.
	amountTotal: integer().notNull(),
	currency: text().notNull(),
	// Billing window this invoice covers (from the line-item period), for the UI's
	// "billing period" column + period filter.
	periodStart: timestamp({ withTimezone: true }),
	periodEnd: timestamp({ withTimezone: true }),
	description: text(),
	// Our self-hosted PDF: object-storage key (see lib/storage/invoice-pdf.ts). Null if
	// the PDF couldn't be captured; hostedInvoiceUrl is the Stripe fallback link.
	pdfKey: text(),
	hostedInvoiceUrl: text(),
	// When the invoice was actually paid (Stripe's status_transitions.paid_at), the
	// primary sort/display date. createdAt is our mirror-insert time.
	paidAt: timestamp({ withTimezone: true }),
	// ── Recipient and tax facts, SNAPSHOTTED at payment (#7321, Early Access) ──────
	// The turnover thresholds (BG place of supply, the EU EUR 10,000 distance-sales limit, the US
	// per-state counts) are sums over these columns, so each row records the payer as declared AT
	// THE TIME it paid, never joined from organization_billing later: a later change of country or
	// VAT status must not re-describe a past sale. All are NULL on rows mirrored before #7321.
	/** ISO 3166-1 alpha-2, upper-case. */
	customerCountry: text(),
	/** USPS two-letter state code, for a US customer. */
	customerState: text(),
	payerCapacity: payerCapacity(),
	/** Whether the customer had declared a VAT number when this invoice was paid. */
	vatIdGiven: boolean(),
	/** The invoice total converted to EUR, in euro cents (Art. 114(5) and the EUR thresholds). */
	amountEurMinor: integer(),
	/** The rate used for `amountEurMinor`: EUR per one unit of `currency`, exact (string). */
	eurRate: numeric({ precision: 18, scale: 8 }),
	/** Where `eurRate` came from and for which date, e.g. `BNB:2027-01-15` or `ECB:2027-01-15`. */
	eurRateSource: text(),
	facturaStatus: text().$type<FacturaStatus>(),
	createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
	updatedAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
}, () => [
	check(
		"invoice_factura_status_known",
		sql.raw(`factura_status IS NULL OR factura_status IN (${sqlList(FACTURA_STATUSES)})`),
	),
	// A EUR amount is meaningless without the rate and source that produced it.
	check(
		"invoice_eur_amount_has_rate",
		sql`amount_eur_minor IS NULL OR (eur_rate IS NOT NULL AND eur_rate_source IS NOT NULL)`,
	),
]);

export type Invoice = typeof invoice.$inferSelect;
export type InvoiceInsert = typeof invoice.$inferInsert;
