// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Pure helpers for the invoice-PDF object store, shared by the webhook mirror (which
// captures Stripe's finalized PDF at payment time) and the authorized download route.
// Keeping the bucket + key policy here means the storage layout lives in one place.

/** Object-storage bucket holding self-hosted invoice PDFs. */
export const INVOICE_PDF_BUCKET = "invoices";

/**
 * Storage key for an org's invoice PDF. Namespaced by org so a listing can't leak across
 * tenants, keyed by the Stripe invoice id (stable + unique) so a re-mirror overwrites in
 * place rather than duplicating.
 */
export function invoicePdfKey(orgId: string, stripeInvoiceId: string): string {
	return `${orgId}/${stripeInvoiceId}.pdf`;
}
