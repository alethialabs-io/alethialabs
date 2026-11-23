// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Client for the Odoo фактура API (management/infra/odoo/addons/alethia_stripe →
// POST /alethia/invoice/issue). On a paid Stripe invoice the console asks Odoo to issue the
// posted+paid Bulgarian фактура and return its PDF + legal number; that is the customer's
// invoice of record (mirrored by lib/billing/invoices.ts).
//
// The фактура is the ONLY document the console accepts as the invoice. A Stripe invoice does not
// satisfy Art. 114(1) of the VAT Act (ЗДДС): its number is a letter prefix, a hyphen and a sequence,
// never "пореден десетразряден номер, съдържащ само арабски цифри" (docs/legal/
// TAX_MARKET_PRECONDITIONS.md §2.4). So `requestFactura` does not return "nothing" on a failure for
// the caller to paper over with Stripe's PDF: it returns WHY there is no compliant фактура, and
// lib/billing/invoices.ts leaves the invoice pending and alerts the operator.
//
// What the console checks itself, and why each check sits on this side of the wire:
//  - the recipient's name, address and identification number are on the Stripe invoice BEFORE Odoo
//    is asked (Art. 114(1)), so an incomplete invoice never burns a number in the sequence;
//  - the no-VAT ground is the cell's (Art. 113(9) for a supplier not registered under the Act, from
//    `LEGAL_ENTITY.vatRegistered`), sent with the request and required back in the response;
//  - the returned number is ten Arabic digits and the document is posted (a draft has no number).
// The rendered PDF's other content is checked by the golden-render test in the management repo,
// not here: this module sees only the fields Odoo returns beside the PDF.
// Server-only.

import { LEGAL_ENTITY } from "@repo/legal/entity";
import type Stripe from "stripe";
import { z } from "zod";

const responseSchema = z.object({
	ok: z.boolean(),
	number: z.string().nullish(),
	currency: z.string().optional(),
	state: z.string().optional(),
	vat_ground: z.string().nullish(),
	pdf_base64: z.string().optional(),
});

/** The ground printed on a фактура by a supplier not registered under the VAT Act (Art. 113(9)). */
export const NO_VAT_GROUND_UNREGISTERED = "чл. 113, ал. 9 ЗДДС";

/** The Art. 114(1), point 2 shape: a ten-digit number of Arabic digits only. */
const LEGAL_INVOICE_NUMBER = /^[0-9]{10}$/;

/** How long the console waits for Odoo to issue and render one фактура. */
const ODOO_TIMEOUT_MS = 12_000;

/** The branded Odoo фактура issued for a paid Stripe invoice. */
export interface OdooFactura {
	/** The sequential фактура number: ten Arabic digits (Art. 114(1), point 2), e.g. "0000000001". */
	number: string;
	/** ISO currency code, lowercased (Stripe's convention). */
	currency: string;
	/** The no-VAT ground the фактура states, e.g. "чл. 113, ал. 9 ЗДДС". */
	vatGround: string;
	/** The rendered фактура PDF bytes. */
	pdf: Uint8Array;
}

/**
 * Why no compliant фактура exists for an invoice. Every one of them leaves the invoice pending.
 *  - `unconfigured`: ODOO_INVOICE_URL / ODOO_INVOICE_TOKEN are not both set.
 *  - `no_invoice_id`: the Stripe invoice has no id to key the фактура on.
 *  - `recipient_incomplete`: the recipient's name, address or identification number is missing.
 *  - `no_ground_ruling`: no ground is ruled for this supplier's VAT status (only "unregistered" is).
 *  - `unreachable`: Odoo did not answer, timed out, or answered with a non-2xx status.
 *  - `rejected`: Odoo answered `ok: false`, sent no PDF, or sent an unexpected shape.
 *  - `not_posted`: the document is not posted, so it has no legal number.
 *  - `number_format`: the number is not ten Arabic digits.
 *  - `ground_mismatch`: the no-VAT ground Odoo states is not the one this cell requires.
 */
export type FacturaFailure =
	| "unconfigured"
	| "no_invoice_id"
	| "recipient_incomplete"
	| "no_ground_ruling"
	| "unreachable"
	| "rejected"
	| "not_posted"
	| "number_format"
	| "ground_mismatch";

/** The result of asking for a фактура: the compliant document, or why there is none. */
export type FacturaOutcome =
	| { ok: true; factura: OdooFactura }
	| { ok: false; reason: FacturaFailure; detail: string };

/** The Stripe invoice fields the checks read (a full `Stripe.Invoice` satisfies it). */
export type FacturaSource = Pick<
	Stripe.Invoice,
	"id" | "currency" | "customer_name" | "customer_address" | "customer_tax_ids"
>;

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
export function missingRecipientDetails(inv: FacturaSource): string[] {
	const missing: string[] = [];
	if (!inv.customer_name?.trim()) missing.push("name");
	const addr = inv.customer_address;
	if (!addr?.line1?.trim() || !addr.city?.trim() || !addr.country?.trim()) missing.push("address");
	const hasId = (inv.customer_tax_ids ?? []).some((t) => Boolean(t.value?.trim()));
	if (!hasId) missing.push("identification number");
	return missing;
}

/** Collapses runs of whitespace and trims, so "чл. 113,  ал. 9" compares equal to "чл. 113, ал. 9". */
function normaliseGround(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

/** The Odoo фактура endpoint config from the environment, or null when not set. */
function odooConfig(): { url: string; token: string } | null {
	const url = process.env.ODOO_INVOICE_URL;
	const token = process.env.ODOO_INVOICE_TOKEN;
	return url && token ? { url, token } : null;
}

// Dedupe concurrent issue+render for the same invoice within a process (the webhook attaches
// the receipt PDF and mirrors the invoice — both want the same фактура).
const inflight = new Map<string, Promise<FacturaOutcome>>();

/**
 * Asks Odoo for the фактура of a paid Stripe invoice (idempotent on the Stripe invoice id) and
 * returns it only when it is compliant; otherwise returns the reason there is none. Never throws.
 * The pre-flight checks (configuration, recipient, ground) run before any request, so a request
 * that could only produce a non-compliant document never reaches Odoo or burns a number.
 */
export async function requestFactura(
	inv: FacturaSource,
	supplier: SupplierVatStatus = LEGAL_ENTITY,
): Promise<FacturaOutcome> {
	const invoiceId = inv.id;
	if (!invoiceId) {
		return { ok: false, reason: "no_invoice_id", detail: "the Stripe invoice has no id" };
	}
	const cfg = odooConfig();
	if (!cfg) {
		return {
			ok: false,
			reason: "unconfigured",
			detail: "ODOO_INVOICE_URL and ODOO_INVOICE_TOKEN are not both set",
		};
	}
	const missing = missingRecipientDetails(inv);
	if (missing.length) {
		return {
			ok: false,
			reason: "recipient_incomplete",
			detail: `the recipient's ${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} missing (Art. 114(1))`,
		};
	}
	const ground = noVatGround(supplier);
	if (!ground) {
		return {
			ok: false,
			reason: "no_ground_ruling",
			detail: "the supplier is VAT-registered and no per-cell invoice ground is ruled for that",
		};
	}
	const cached = inflight.get(invoiceId);
	if (cached) return cached;
	const task = postFactura(cfg, inv, ground);
	inflight.set(invoiceId, task);
	void task.finally(() => inflight.delete(invoiceId));
	return task;
}

/**
 * Issues the фактура and returns it, or null when there is no compliant one. Kept for the receipt
 * email's attachment; anything that RECORDS the invoice uses `requestFactura` so it can say why.
 */
export async function issueFactura(inv: FacturaSource): Promise<OdooFactura | null> {
	const outcome = await requestFactura(inv);
	return outcome.ok ? outcome.factura : null;
}

/**
 * Performs the authenticated POST with a timeout and hands the answer to `checkResponse`. The body
 * is `{ invoice, vat_ground }`, a shape the Odoo endpoint already accepts (it reads `invoice` and
 * ignores keys it does not know).
 */
async function postFactura(
	cfg: { url: string; token: string },
	inv: FacturaSource,
	ground: string,
): Promise<FacturaOutcome> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), ODOO_TIMEOUT_MS);
	let body: unknown;
	try {
		const res = await fetch(cfg.url, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${cfg.token}`,
			},
			body: JSON.stringify({ invoice: inv, vat_ground: ground }),
			signal: controller.signal,
		});
		if (!res.ok) {
			return { ok: false, reason: "unreachable", detail: `Odoo answered HTTP ${res.status}` };
		}
		body = await res.json();
	} catch (err) {
		const timedOut = err instanceof Error && err.name === "AbortError";
		return {
			ok: false,
			reason: "unreachable",
			detail: timedOut ? `Odoo did not answer within ${ODOO_TIMEOUT_MS / 1000}s` : "Odoo could not be reached",
		};
	} finally {
		clearTimeout(timer);
	}
	return checkResponse(body, inv, ground);
}

/** Validates Odoo's answer against Art. 113-114 and turns it into an outcome. */
function checkResponse(body: unknown, inv: FacturaSource, ground: string): FacturaOutcome {
	const parsed = responseSchema.safeParse(body);
	if (!parsed.success) {
		return { ok: false, reason: "rejected", detail: "Odoo's answer is not the expected JSON shape" };
	}
	const data = parsed.data;
	if (!data.ok || !data.pdf_base64) {
		return { ok: false, reason: "rejected", detail: "Odoo did not issue a фактура PDF" };
	}
	if (data.state !== "posted") {
		return {
			ok: false,
			reason: "not_posted",
			detail: `Odoo's фактура is in state "${data.state ?? "unknown"}", not "posted"`,
		};
	}
	if (!isLegalInvoiceNumber(data.number)) {
		return {
			ok: false,
			reason: "number_format",
			detail: `Odoo's number "${data.number ?? ""}" is not ten Arabic digits (Art. 114(1), point 2)`,
		};
	}
	if (!data.vat_ground || normaliseGround(data.vat_ground) !== normaliseGround(ground)) {
		return {
			ok: false,
			reason: "ground_mismatch",
			detail: `Odoo's no-VAT ground "${data.vat_ground ?? ""}" is not "${ground}"`,
		};
	}
	return {
		ok: true,
		factura: {
			number: data.number,
			currency: (data.currency ?? inv.currency).toLowerCase(),
			vatGround: normaliseGround(data.vat_ground),
			pdf: Uint8Array.from(Buffer.from(data.pdf_base64, "base64")),
		},
	};
}
