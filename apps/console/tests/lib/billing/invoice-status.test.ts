// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// The Invoices list's displayed status (lib/billing/invoice-status.ts). The defect this locks: a
// mirrored Paddle invoice that was billed but not yet paid read "paid", and a past-due one was not
// listed at all. Every Paddle transaction status is enumerated from the schema's own list, so a
// status added there without a mapping decision fails here rather than reading as something else.

import { describe, expect, it } from "vitest";
import {
	INVOICE_DISPLAY_STATUSES,
	isInvoiceDisplayStatus,
	isLocalInvoiceStatus,
	LOCAL_INVOICE_STATUSES,
	PADDLE_INVOICE_STATUSES,
	paddleInvoiceStatus,
} from "@/lib/billing/invoice-status";
import { invoiceStatus } from "@/lib/db/schema/enums";
import { PADDLE_TRANSACTION_STATUSES, type PaddleTransactionStatus } from "@/lib/db/schema/paddle-transaction";

/** The expected display status of an un-refunded Paddle transaction, written out per status. */
const EXPECTED: Record<PaddleTransactionStatus, string> = {
	draft: "open",
	ready: "open",
	billed: "open",
	past_due: "overdue",
	paid: "paid",
	completed: "paid",
	canceled: "void",
};

describe("paddleInvoiceStatus", () => {
	it.each(PADDLE_TRANSACTION_STATUSES)("maps Paddle's %s to its displayed state", (status) => {
		expect(paddleInvoiceStatus({ status, refundedAt: null, chargebackAt: null })).toBe(EXPECTED[status]);
	});

	it("a billed invoice is open, never paid", () => {
		expect(paddleInvoiceStatus({ status: "billed", refundedAt: null, chargebackAt: null })).toBe("open");
	});

	it("a refund or a chargeback wins over any Paddle status", () => {
		for (const status of PADDLE_TRANSACTION_STATUSES) {
			expect(paddleInvoiceStatus({ status, refundedAt: new Date(), chargebackAt: null })).toBe("refunded");
			expect(paddleInvoiceStatus({ status, refundedAt: null, chargebackAt: new Date() })).toBe("refunded");
		}
	});

	it("lists every invoiced status — past_due included — and no pre-invoice one", () => {
		expect([...PADDLE_INVOICE_STATUSES].sort()).toEqual(["billed", "canceled", "completed", "paid", "past_due"]);
	});
});

describe("the displayed scale", () => {
	it("holds every stored invoice_status value, so a Stripe-era row always has a badge", () => {
		expect([...LOCAL_INVOICE_STATUSES].sort()).toEqual([...invoiceStatus.enumValues].sort());
		for (const s of invoiceStatus.enumValues) expect(isInvoiceDisplayStatus(s)).toBe(true);
	});

	it("separates the Paddle-only states from the stored ones", () => {
		expect(INVOICE_DISPLAY_STATUSES.filter(isLocalInvoiceStatus)).toEqual(["paid", "refunded", "void"]);
		expect(isInvoiceDisplayStatus("billed")).toBe(false);
	});
});
