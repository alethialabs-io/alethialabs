// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Locally-mirrored invoices — Alethia's own record of every invoice for which money
// actually moved. Stripe stays the payment rail, but we mirror its finalized+paid
// invoices into this table (via the Stripe webhook) so the billing UI never has to hit
// the Stripe API at page load, never surfaces never-paid draft/void artifacts, and owns
// the invoice document (a self-hosted PDF in object storage, not Stripe's expiring
// hosted link). One row per Stripe invoice (stripe_invoice_id unique → idempotent
// mirror: a replayed webhook converges to the same row).

import { integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { invoiceStatus } from "./enums";
import { organization } from "./organizations";

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
	createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
	updatedAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
});

export type Invoice = typeof invoice.$inferSelect;
export type InvoiceInsert = typeof invoice.$inferInsert;
