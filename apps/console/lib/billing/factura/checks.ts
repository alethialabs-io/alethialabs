// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The Art. 113-114 ЗДДС checks a paid Stripe invoice must pass BEFORE a фактура number is taken
// (#7368). Each one runs ahead of the counter, so an invoice that could only produce a non-compliant
// document never spends a number in the gap-free series (lib/db/schema/factura.ts):
//  - the recipient's name, address and identification number are on the Stripe invoice (Art. 114(1));
//  - a no-VAT ground is ruled for the supplier's VAT status (Art. 113(9) while unregistered);
//  - Stripe charged no VAT, because an unregistered supplier may not show any (Art. 113(9)).
// The number's own shape is checked too, on the way out, by `isLegalInvoiceNumber`.
// Server-only.

import { LEGAL_ENTITY } from "@repo/legal/entity";
import type Stripe from "stripe";

/** The ground printed on a фактура by a supplier not registered under the VAT Act (Art. 113(9)). */
export const NO_VAT_GROUND_UNREGISTERED = "чл. 113, ал. 9 ЗДДС";

/** The Art. 114(1), point 2 shape: a ten-digit number of Arabic digits only. */
const LEGAL_INVOICE_NUMBER = /^[0-9]{10}$/;

/**
 * Why no compliant фактура exists for an invoice. Every one of them leaves the invoice pending.
 *  - `no_invoice_id`: the Stripe invoice has no id to key the фактура on.
 *  - `recipient_incomplete`: the recipient's name, address or identification number is missing.
 *  - `no_ground_ruling`: no ground is ruled for this supplier's VAT status (only "unregistered" is).
 *  - `vat_charged`: the Stripe invoice carries tax, which an unregistered supplier may not show.
 *  - `no_rate`: the invoice is not in EUR and no ECB rate could be had for the chargeable date.
 *  - `store_failed`: the number and document could not be saved (nothing was issued).
 *  - `pdf_failed`: the фактура is issued (number and snapshot saved) but its PDF could not be
 *    rendered or stored yet; a replay renders it from the snapshot.
 *  - `pdf_integrity`: the stored PDF does not match the SHA-256 recorded when it was issued.
 */
export type FacturaFailure =
	| "no_invoice_id"
	| "recipient_incomplete"
	| "no_ground_ruling"
	| "vat_charged"
	| "no_rate"
	| "store_failed"
	| "pdf_failed"
	| "pdf_integrity";

/** The Stripe invoice fields the фактура is built from (a full `Stripe.Invoice` satisfies it). */
export type FacturaSource = Pick<
	Stripe.Invoice,
	| "id"
	| "number"
	| "currency"
	| "customer_name"
	| "customer_address"
	| "customer_tax_ids"
	| "total"
	| "total_excluding_tax"
	| "status_transitions"
> & {
	lines?: { data: FacturaSourceLine[] } | null;
};

/** The Stripe invoice-line fields a фактура line is built from. */
export type FacturaSourceLine = Pick<Stripe.InvoiceLineItem, "description" | "amount" | "quantity"> & {
	period?: { start: number; end: number } | null;
};

/** The supplier fact the no-VAT ground depends on (`LEGAL_ENTITY` satisfies it). */
export interface SupplierVatStatus {
	vatRegistered: boolean;
}

/** True when `value` is an Art. 114(1), point 2 invoice number: exactly ten Arabic digits. */
export function isLegalInvoiceNumber(value: string | null | undefined): value is string {
	return typeof value === "string" && LEGAL_INVOICE_NUMBER.test(value);
}

/**
 * The no-VAT ground a фактура must state for this supplier, or null when none is ruled.
 * Every cell the company can open without a registration sells as a supplier not registered under
 * the VAT Act, so the ground is Art. 113(9) in each of them (TAX_MARKET_PRECONDITIONS.md §3.2,
 * §3.4-§3.7). A registered supplier needs a per-cell ground (reverse charge under Art. 114(4) for an
 * EU business, §3.3) that nobody has ruled on, so it gets null and the invoice stays pending.
 */
export function noVatGround(supplier: SupplierVatStatus = LEGAL_ENTITY): string | null {
	return supplier.vatRegistered ? null : NO_VAT_GROUND_UNREGISTERED;
}

/**
 * The Art. 114(1) recipient details missing from a Stripe invoice: the name, the address (street,
 * city and country), and an identification number (a VAT or register number in `customer_tax_ids`).
 * Empty when all are present.
 */
export function missingRecipientDetails(
	inv: Pick<FacturaSource, "customer_name" | "customer_address" | "customer_tax_ids">,
): string[] {
	const missing: string[] = [];
	if (!inv.customer_name?.trim()) missing.push("name");
	const addr = inv.customer_address;
	if (!addr?.line1?.trim() || !addr.city?.trim() || !addr.country?.trim()) missing.push("address");
	const hasId = (inv.customer_tax_ids ?? []).some((t) => Boolean(t.value?.trim()));
	if (!hasId) missing.push("identification number");
	return missing;
}

/**
 * True when Stripe charged tax on the invoice: its total differs from its total before tax. Stripe
 * omits `total_excluding_tax` on some objects; then there is nothing to compare and no tax is read.
 */
export function vatCharged(inv: Pick<FacturaSource, "total" | "total_excluding_tax">): boolean {
	return inv.total_excluding_tax !== null && inv.total_excluding_tax !== undefined
		? inv.total !== inv.total_excluding_tax
		: false;
}
