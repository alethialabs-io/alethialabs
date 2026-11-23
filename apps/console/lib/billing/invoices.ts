// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The mirror + typed reads for locally-owned invoices. Stripe remains the payment rail,
// but every invoice for which money actually moved is mirrored into our `invoice` table
// by the Stripe webhook (mirrorPaidInvoice). The stored document + number are the Bulgarian
// фактура the console issues itself (lib/billing/factura/issue.ts, #7368), kept in object storage
// so the billing UI owns the document and never hits the Stripe API at page load. Idempotent on
// stripe_invoice_id, so a replay converges to one row.
//
// There is no fallback to Stripe's PDF, number or hosted page. A Stripe invoice does not satisfy
// Art. 114(1) of the VAT Act (docs/legal/TAX_MARKET_PRECONDITIONS.md §2.4), so filing it as "the
// invoice" would present a non-compliant document as one. When no compliant фактура exists — the
// recipient's details are incomplete, no EUR rate could be had, the store or the PDF failed — the
// row is written PENDING (factura_status 'pending'; number, pdfKey and hostedInvoiceUrl null, so
// neither the list nor the PDF route has a document to show) and the operator is alerted, because
// Art. 113(4) gives five days.

import type Stripe from "stripe";
import { and, desc, eq, gte, inArray, lte } from "drizzle-orm";
import { alertOperator } from "@/lib/billing/operator-alert";
import { type FacturaOutcome, requestFactura } from "@/lib/billing/factura/issue";
import { getServiceDb } from "@/lib/db";
import { type Invoice, invoice } from "@/lib/db/schema";
import type { InvoiceStatus } from "@/lib/db/schema/enums";

/** Art. 113(4): the фактура is due within this many days of the chargeable event. */
const FACTURA_DEADLINE_DAYS = 5;

/** The Stripe customer id off an invoice (string ref or expanded object), or null. */
function customerIdOf(inv: Stripe.Invoice): string | null {
	const c = inv.customer;
	if (!c) return null;
	return typeof c === "string" ? c : c.id;
}

/** epoch seconds → Date, or null. */
function toDate(epochSeconds: number | null | undefined): Date | null {
	return epochSeconds ? new Date(epochSeconds * 1000) : null;
}

/**
 * Tells the operator that a paid invoice has no compliant фактура yet, with the reason, the date
 * Art. 113(4) runs out, and the remedy. The subject is the Stripe customer (the alert rules know no
 * invoice subject), and the summary names the invoice so two of one customer's stay distinguishable.
 */
async function alertFacturaPending(
	inv: Stripe.Invoice,
	orgId: string,
	failure: Extract<FacturaOutcome, { ok: false }>,
	paidAt: Date,
): Promise<void> {
	const due = new Date(paidAt.getTime() + FACTURA_DEADLINE_DAYS * 24 * 60 * 60 * 1000);
	await alertOperator({
		title: "A paid invoice has no Bulgarian фактура",
		subject: { type: "stripe_customer", id: customerIdOf(inv) ?? inv.id ?? orgId },
		summary:
			`Stripe invoice ${inv.id} (organization ${orgId}) was paid but no compliant фактура was ` +
			`issued: ${failure.reason} — ${failure.detail}. The invoice is recorded as pending and no ` +
			`document is shown to the customer. Fix the cause, then replay its invoice.paid event ` +
			`(break-glass replay_webhook). Art. 113(4) ЗДДС deadline: ${due.toISOString().slice(0, 10)}.`,
	});
}

/**
 * Mirrors a paid Stripe invoice into the local table for `orgId`, with the фактура as its number
 * and document (issued on the first delivery, found again on a replay). Idempotent on
 * stripe_invoice_id — a replayed webhook (or a later status change) upserts the one row. Only ever called once payment has actually succeeded, so the local
 * table never holds never-paid draft/void artifacts. With no compliant фактура the row is written
 * pending (no number, no document) and the operator is alerted; a replay that then succeeds fills
 * them in, and one that fails again never erases a фактура an earlier attempt stored.
 */
export async function mirrorPaidInvoice(
	inv: Stripe.Invoice,
	orgId: string,
): Promise<void> {
	if (!inv.id) return;
	const paidAt = toDate(inv.status_transitions?.paid_at) ?? new Date();
	const outcome = await requestFactura(inv, orgId);
	if (!outcome.ok) await alertFacturaPending(inv, orgId, outcome, paidAt);
	const factura = outcome.ok ? outcome.factura : null;
	// The document fields come ONLY from a compliant фактура. Stripe's hosted page is kept beside it
	// as the payment receipt, never on its own: the PDF route redirects to it when there is no stored
	// PDF, which would serve Stripe's document as the invoice.
	const document: Pick<
		typeof invoice.$inferInsert,
		"number" | "pdfKey" | "hostedInvoiceUrl" | "facturaStatus"
	> | null = factura
		? {
				number: factura.number,
				pdfKey: factura.pdfKey,
				hostedInvoiceUrl: inv.hosted_invoice_url ?? null,
				facturaStatus: "issued",
			}
		: null;
	const values: typeof invoice.$inferInsert = {
		organizationId: orgId,
		stripeInvoiceId: inv.id,
		stripeCustomerId: customerIdOf(inv),
		number: document?.number ?? null,
		status: "paid",
		amountTotal: inv.total,
		currency: inv.currency,
		periodStart: toDate(inv.period_start),
		periodEnd: toDate(inv.period_end),
		description: inv.lines?.data[0]?.description ?? inv.description ?? null,
		pdfKey: document?.pdfKey ?? null,
		hostedInvoiceUrl: document?.hostedInvoiceUrl ?? null,
		facturaStatus: document ? "issued" : "pending",
		paidAt,
		updatedAt: new Date(),
	};
	await getServiceDb()
		.insert(invoice)
		.values(values)
		.onConflictDoUpdate({
			target: invoice.stripeInvoiceId,
			set: {
				status: values.status,
				amountTotal: values.amountTotal,
				// Only a compliant фактура writes the document fields, so a failed retry never
				// erases one an earlier attempt stored.
				...(document ?? {}),
				paidAt: values.paidAt,
				updatedAt: values.updatedAt,
			},
		});
}

/**
 * Flips a mirrored invoice's status (e.g. → `refunded` on a charge refund, → `void` if a
 * paid invoice is later voided). No-op if we never mirrored the invoice (e.g. it was never
 * paid). Idempotent.
 */
export async function setInvoiceStatus(
	stripeInvoiceId: string,
	status: InvoiceStatus,
): Promise<void> {
	await getServiceDb()
		.update(invoice)
		.set({ status, updatedAt: new Date() })
		.where(eq(invoice.stripeInvoiceId, stripeInvoiceId));
}

/** Filters for the invoices list (all optional; combined with AND). */
export interface InvoiceListFilters {
	status?: InvoiceStatus[];
	/** ISO date — only invoices paid on/after this instant. */
	paidFrom?: string;
	/** ISO date — only invoices paid on/before this instant. */
	paidTo?: string;
	limit?: number;
}

/**
 * Lists an org's mirrored invoices, newest paid first, applying the optional filters.
 * Org-scoped by the caller passing the resolved actor.orgId (never user input).
 */
export async function listOrgInvoices(
	orgId: string,
	filters: InvoiceListFilters = {},
): Promise<Invoice[]> {
	const where = [eq(invoice.organizationId, orgId)];
	if (filters.status?.length) {
		where.push(inArray(invoice.status, filters.status));
	}
	if (filters.paidFrom) where.push(gte(invoice.paidAt, new Date(filters.paidFrom)));
	if (filters.paidTo) where.push(lte(invoice.paidAt, new Date(filters.paidTo)));
	return getServiceDb()
		.select()
		.from(invoice)
		.where(and(...where))
		.orderBy(desc(invoice.paidAt))
		.limit(filters.limit ?? 200);
}

/** Loads one invoice, scoped to the org (returns null when it isn't the org's). */
export async function getOrgInvoice(
	orgId: string,
	id: string,
): Promise<Invoice | null> {
	const [row] = await getServiceDb()
		.select()
		.from(invoice)
		.where(and(eq(invoice.id, id), eq(invoice.organizationId, orgId)))
		.limit(1);
	return row ?? null;
}
