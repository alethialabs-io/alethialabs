// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Client for the Odoo фактура API (management/infra/odoo/addons/alethia_stripe →
// POST /alethia/invoice/issue). On a paid Stripe invoice the console asks Odoo to issue the
// posted+paid branded Bulgarian фактура and return its PDF + legal number; that becomes the
// customer's invoice of record (attached to the receipt + mirrored). Gated + best-effort:
// with no ODOO_INVOICE_URL/TOKEN, or on any error/timeout, this returns null and the caller
// falls back to Stripe's own PDF — issuing the фактура must never fail the webhook or receipt.
// Server-only.

import type Stripe from "stripe";
import { z } from "zod";

const responseSchema = z.object({
	ok: z.boolean(),
	number: z.string().nullish(),
	currency: z.string().optional(),
	pdf_base64: z.string().optional(),
});

/** The branded Odoo фактура issued for a paid Stripe invoice. */
export interface OdooFactura {
	/** The sequential НАП фактура number (e.g. "INV/2026/00001"), or null if unposted. */
	number: string | null;
	/** ISO currency code, lowercased (Stripe's convention). */
	currency: string;
	/** The rendered фактура PDF bytes. */
	pdf: Uint8Array;
}

/** The Odoo фактура endpoint config from the environment, or null when not hosted. */
function odooConfig(): { url: string; token: string } | null {
	const url = process.env.ODOO_INVOICE_URL;
	const token = process.env.ODOO_INVOICE_TOKEN;
	return url && token ? { url, token } : null;
}

// Dedupe concurrent issue+render for the same invoice within a process (the webhook attaches
// the receipt PDF and mirrors the invoice — both want the same фактура).
const inflight = new Map<string, Promise<OdooFactura | null>>();

/**
 * Issues (or finds — idempotent on the Stripe invoice id) the branded Odoo фактура for a
 * paid Stripe invoice and returns its PDF + legal number. Returns null when Odoo isn't
 * configured or is unreachable/slow, so the caller falls back to Stripe's PDF.
 */
export async function issueFactura(invoice: Stripe.Invoice): Promise<OdooFactura | null> {
	const cfg = odooConfig();
	if (!cfg || !invoice.id) return null;
	const cached = inflight.get(invoice.id);
	if (cached) return cached;
	const task = requestFactura(cfg, invoice);
	inflight.set(invoice.id, task);
	void task.finally(() => inflight.delete(invoice.id));
	return task;
}

/** Performs the authenticated POST + parse with a 12s timeout; null on any failure. */
async function requestFactura(
	cfg: { url: string; token: string },
	invoice: Stripe.Invoice,
): Promise<OdooFactura | null> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 12_000);
	try {
		const res = await fetch(cfg.url, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${cfg.token}`,
			},
			body: JSON.stringify(invoice),
			signal: controller.signal,
		});
		if (!res.ok) return null;
		const parsed = responseSchema.safeParse(await res.json());
		if (!parsed.success || !parsed.data.ok || !parsed.data.pdf_base64) return null;
		return {
			number: parsed.data.number ?? null,
			currency: (parsed.data.currency ?? invoice.currency).toLowerCase(),
			pdf: Uint8Array.from(Buffer.from(parsed.data.pdf_base64, "base64")),
		};
	} catch {
		return null;
	} finally {
		clearTimeout(timer);
	}
}
