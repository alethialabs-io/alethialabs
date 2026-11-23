// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// EA-7 (#7323): mirrorPaidInvoice records the Odoo фактура as the invoice, and NOTHING else. When no
// compliant фактура exists it used to file Stripe's PDF and Stripe's number as "the invoice of
// record" without a word; now the row is written pending (no number, no document, no hosted link the
// PDF route would redirect to) and the operator is alerted with the reason and the Art. 113(4) date.

import type Stripe from "stripe";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { insertValues, conflictSet } = vi.hoisted(() => ({
	insertValues: vi.fn(),
	conflictSet: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
	getServiceDb: () => ({
		insert: () => ({
			values: (v: unknown) => {
				insertValues(v);
				return {
					onConflictDoUpdate: async (cfg: { set: unknown }) => {
						conflictSet(cfg.set);
					},
				};
			},
		}),
	}),
}));
vi.mock("@/lib/storage", () => ({ storage: { put: vi.fn(async () => undefined) } }));
vi.mock("@/lib/billing/operator-alert", () => ({ alertOperator: vi.fn(async () => true) }));
vi.mock("@/lib/billing/odoo-invoice", () => ({ requestFactura: vi.fn() }));

import { mirrorPaidInvoice } from "@/lib/billing/invoices";
import type { FacturaFailure } from "@/lib/billing/odoo-invoice";
import { requestFactura } from "@/lib/billing/odoo-invoice";
import { alertOperator } from "@/lib/billing/operator-alert";
import { storage } from "@/lib/storage";

const PAID_AT = Date.UTC(2027, 0, 10, 9, 0, 0) / 1000;

/** A paid Stripe invoice carrying Stripe's own (non-compliant) number, PDF and hosted page. */
function paidInvoice(): Stripe.Invoice {
	const inv = {
		id: "in_1",
		object: "invoice",
		customer: "cus_1",
		number: "OQDLWV3B-0031",
		total: 2900,
		currency: "usd",
		period_start: PAID_AT,
		period_end: PAID_AT + 30 * 86400,
		description: null,
		lines: { data: [{ description: "Pro plan" }] },
		invoice_pdf: "https://pay.stripe.com/invoice/acct/in_1/pdf",
		hosted_invoice_url: "https://invoice.stripe.com/i/acct/in_1",
		status_transitions: { paid_at: PAID_AT },
	};
	// Test-only: a fixture carries the fields the mirror reads, not all of Stripe's ~90.
	return inv as unknown as Stripe.Invoice;
}

/** The compliant outcome requestFactura returns when Odoo issued a correct фактура. */
function issued() {
	return {
		ok: true as const,
		factura: {
			number: "0000000042",
			currency: "usd",
			vatGround: "чл. 113, ал. 9 ЗДДС",
			pdf: new Uint8Array([37, 80, 68, 70]),
		},
	};
}

const fetchMock = vi.fn();

describe("mirrorPaidInvoice (EA-7)", () => {
	beforeEach(() => {
		insertValues.mockReset();
		conflictSet.mockReset();
		vi.mocked(storage.put).mockClear();
		vi.mocked(alertOperator).mockClear();
		vi.mocked(requestFactura).mockReset();
		fetchMock.mockReset();
		vi.stubGlobal("fetch", fetchMock);
	});
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("records the фактура's ten-digit number and PDF, and alerts nobody", async () => {
		vi.mocked(requestFactura).mockResolvedValueOnce(issued());
		await mirrorPaidInvoice(paidInvoice(), "org_1");
		expect(storage.put).toHaveBeenCalledWith(
			"invoices",
			expect.stringContaining("in_1"),
			new Uint8Array([37, 80, 68, 70]),
			"application/pdf",
		);
		const row = insertValues.mock.calls[0][0];
		expect(row.number).toBe("0000000042");
		expect(row.pdfKey).toEqual(expect.stringContaining("in_1"));
		expect(row.hostedInvoiceUrl).toBe("https://invoice.stripe.com/i/acct/in_1");
		expect(conflictSet.mock.calls[0][0].number).toBe("0000000042");
		expect(alertOperator).not.toHaveBeenCalled();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	const FAILURES: FacturaFailure[] = [
		"unconfigured",
		"recipient_incomplete",
		"no_ground_ruling",
		"unreachable",
		"rejected",
		"not_posted",
		"number_format",
		"ground_mismatch",
	];

	it.each(FAILURES)("on %s: never files Stripe's PDF, number or page as the invoice", async (reason) => {
		vi.mocked(requestFactura).mockResolvedValueOnce({ ok: false, reason, detail: "the detail" });
		await mirrorPaidInvoice(paidInvoice(), "org_1");
		// Stripe's PDF is not fetched, and nothing is stored.
		expect(fetchMock).not.toHaveBeenCalled();
		expect(storage.put).not.toHaveBeenCalled();
		const row = insertValues.mock.calls[0][0];
		expect(row.number).toBeNull();
		expect(row.pdfKey).toBeNull();
		expect(row.hostedInvoiceUrl).toBeNull();
		// The payment itself is still recorded.
		expect(row.status).toBe("paid");
		expect(row.amountTotal).toBe(2900);
	});

	it.each(FAILURES)("on %s: alerts the operator with the reason and the deadline", async (reason) => {
		vi.mocked(requestFactura).mockResolvedValueOnce({ ok: false, reason, detail: "the detail" });
		await mirrorPaidInvoice(paidInvoice(), "org_1");
		expect(alertOperator).toHaveBeenCalledTimes(1);
		const alert = vi.mocked(alertOperator).mock.calls[0][0];
		expect(alert.subject).toEqual({ type: "stripe_customer", id: "cus_1" });
		expect(alert.summary).toContain("in_1");
		expect(alert.summary).toContain("org_1");
		expect(alert.summary).toContain(`${reason} — the detail`);
		// Paid 2027-01-10: Art. 113(4)'s five days run out on 2027-01-15.
		expect(alert.summary).toContain("2027-01-15");
		expect(alert.summary).toContain("replay_webhook");
	});

	it("a failed retry leaves a stored фактура alone", async () => {
		vi.mocked(requestFactura).mockResolvedValueOnce({
			ok: false,
			reason: "unreachable",
			detail: "Odoo answered HTTP 502",
		});
		await mirrorPaidInvoice(paidInvoice(), "org_1");
		const set = conflictSet.mock.calls[0][0];
		expect(set).not.toHaveProperty("number");
		expect(set).not.toHaveProperty("pdfKey");
		expect(set).not.toHaveProperty("hostedInvoiceUrl");
		expect(set.status).toBe("paid");
	});

	it("does nothing for an invoice with no id", async () => {
		await mirrorPaidInvoice({ ...paidInvoice(), id: "" }, "org_1");
		expect(requestFactura).not.toHaveBeenCalled();
		expect(insertValues).not.toHaveBeenCalled();
	});
});
