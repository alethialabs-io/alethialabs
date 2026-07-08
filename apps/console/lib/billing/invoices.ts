// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The mirror + typed reads for locally-owned invoices. Stripe remains the payment rail,
// but every invoice for which money actually moved is mirrored into our `invoice` table
// by the Stripe webhook (mirrorPaidInvoice). The stored document + number are the branded
// Odoo фактура (issueFactura) when Odoo is configured, else Stripe's finalized PDF — either
// way captured into object storage so the billing UI owns the document and never hits the
// Stripe API at page load. Idempotent on stripe_invoice_id, so a replay converges to one row.

import type Stripe from "stripe";
import { and, desc, eq, gte, inArray, lte } from "drizzle-orm";
import { type OdooFactura, issueFactura } from "@/lib/billing/odoo-invoice";
import { getServiceDb } from "@/lib/db";
import { type Invoice, invoice } from "@/lib/db/schema";
import type { InvoiceStatus } from "@/lib/db/schema/enums";
import { storage } from "@/lib/storage";
import { INVOICE_PDF_BUCKET, invoicePdfKey } from "@/lib/storage/invoice-pdf";

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

/** Fetches Stripe's finalized, tokenized invoice PDF bytes (best-effort; the URL needs no
 *  API key). Used as the fallback when the Odoo фактура isn't available. */
async function fetchStripePdf(inv: Stripe.Invoice): Promise<Uint8Array | null> {
	if (!inv.invoice_pdf) return null;
	try {
		const res = await fetch(inv.invoice_pdf);
		if (!res.ok) return null;
		return new Uint8Array(await res.arrayBuffer());
	} catch {
		return null;
	}
}

/**
 * Stores the invoice document (the branded Odoo фактура when issued, else Stripe's PDF) into
 * object storage (best-effort: returns the stored key, or null so a hiccup never blocks
 * recording the invoice — the hosted URL is kept as a fallback).
 */
async function storeInvoicePdf(
	orgId: string,
	inv: Stripe.Invoice,
	factura: OdooFactura | null,
): Promise<string | null> {
	if (!inv.id) return null;
	const bytes = factura?.pdf ?? (await fetchStripePdf(inv));
	if (!bytes) return null;
	const key = invoicePdfKey(orgId, inv.id);
	await storage.put(INVOICE_PDF_BUCKET, key, bytes, "application/pdf");
	return key;
}

/**
 * Mirrors a paid Stripe invoice into the local table for `orgId`, capturing its PDF.
 * Idempotent on stripe_invoice_id — a replayed webhook (or a later status change) upserts
 * the one row. Only ever called once payment has actually succeeded, so the local table
 * never holds never-paid draft/void artifacts. Best-effort: a mirror failure logs but
 * must never fail the webhook (the entitlement sync already committed).
 */
export async function mirrorPaidInvoice(
	inv: Stripe.Invoice,
	orgId: string,
): Promise<void> {
	if (!inv.id) return;
	// The branded Odoo фактура is the invoice of record (its number + PDF); Stripe is the
	// fallback when Odoo isn't configured/reachable.
	const factura = await issueFactura(inv);
	const pdfKey = await storeInvoicePdf(orgId, inv, factura);
	const values = {
		organizationId: orgId,
		stripeInvoiceId: inv.id,
		stripeCustomerId: customerIdOf(inv),
		number: factura?.number ?? inv.number ?? null,
		status: "paid" as InvoiceStatus,
		amountTotal: inv.total,
		currency: inv.currency,
		periodStart: toDate(inv.period_start),
		periodEnd: toDate(inv.period_end),
		description: inv.lines?.data[0]?.description ?? inv.description ?? null,
		pdfKey,
		hostedInvoiceUrl: inv.hosted_invoice_url ?? null,
		paidAt: toDate(inv.status_transitions?.paid_at) ?? new Date(),
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
				number: values.number,
				// Only overwrite the stored PDF key if we captured one this time.
				...(pdfKey ? { pdfKey } : {}),
				hostedInvoiceUrl: values.hostedInvoiceUrl,
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
