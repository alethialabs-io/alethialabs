// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The footer every Stripe invoice and its PDF carries for a customer the console creates. Stripe's
 * invoice is a payment record; the invoice of record is the фактура the console issues
 * (lib/billing/factura/issue.ts).
 *
 * Why it is set on the CUSTOMER: Stripe's account-level default footer is dashboard-only (Settings →
 * Billing → Invoices; POST /v1/accounts/:id cannot update your own account), subscriptions take no
 * footer (`invoice_settings` there is only `account_tax_ids` and `issuer`), and invoice templates
 * cannot be created through the API. `customer.invoice_settings.footer` is the one API-reachable place
 * that applies to every invoice a subscription generates. A customer created before this was added
 * keeps no footer; the dashboard default in the Stripe runbook (§3) covers it.
 */
export const STRIPE_INVOICE_FOOTER =
	"This is a payment receipt, not a tax invoice. Your фактура is issued by Alethia Labs and is available in your billing settings.";
