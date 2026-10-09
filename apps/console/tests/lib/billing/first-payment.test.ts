// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// `readFirstPayment`'s void rule (ADR 0002 §3.4, C47): after a void-first close, an `incomplete`
// subscription whose invoice is void and whose PaymentIntent is `canceled` was never paid. Nothing
// else moves: a payment that succeeded or is in flight is never proven unpaid, whatever the invoice.

import { beforeEach, describe, expect, it, vi } from "vitest";

const stripe = vi.hoisted(() => {
	const intents: Array<{ status: string }> = [];
	return { invoice: { status: "open" }, intents, hasMore: false, invoiceReads: 0 };
});

vi.mock("@/lib/billing/stripe", () => ({
	getStripe: () => ({
		invoicePayments: {
			list: async () => ({
				has_more: stripe.hasMore,
				data: stripe.intents.map((pi, i) => ({
					status: pi.status === "succeeded" ? "paid" : "open",
					payment: { type: "payment_intent", payment_intent: { id: `pi_${i}`, status: pi.status } },
				})),
			}),
		},
		invoices: {
			retrieve: async () => {
				stripe.invoiceReads += 1;
				return stripe.invoice;
			},
		},
	}),
}));

import { readFirstPayment } from "@/lib/billing/first-payment";

const sub = (status: "incomplete" | "incomplete_expired" | "active" = "incomplete") => ({ id: "sub_1", status, latest_invoice: "in_1" });

describe("readFirstPayment (C47)", () => {
	beforeEach(() => {
		stripe.invoice = { status: "open" };
		stripe.intents = [];
		stripe.hasMore = false;
		stripe.invoiceReads = 0;
	});

	it("C47: incomplete + invoice void + a canceled PaymentIntent is never_paid", async () => {
		stripe.invoice = { status: "void" };
		stripe.intents = [{ status: "canceled" }];
		expect(await readFirstPayment(sub())).toBe("never_paid");
	});

	it("C47: incomplete + invoice void + no payment at all is never_paid", async () => {
		stripe.invoice = { status: "void" };
		expect(await readFirstPayment(sub())).toBe("never_paid");
	});

	it("an open invoice with a canceled PaymentIntent is still not proven unpaid", async () => {
		stripe.intents = [{ status: "canceled" }];
		expect(await readFirstPayment(sub())).toBe("not_proven_unpaid");
		expect(stripe.invoiceReads).toBe(1);
	});

	it.each(["succeeded", "processing", "requires_capture"])(
		"a void invoice never outweighs a PaymentIntent that is %s",
		async (status) => {
			stripe.invoice = { status: "void" };
			stripe.intents = [{ status: "canceled" }, { status }];
			expect(await readFirstPayment(sub())).toBe("not_proven_unpaid");
			expect(stripe.invoiceReads).toBe(0);
		},
	);

	it("a void invoice with more payments than one page is not proven unpaid", async () => {
		stripe.invoice = { status: "void" };
		stripe.hasMore = true;
		expect(await readFirstPayment(sub())).toBe("not_proven_unpaid");
	});

	it("unchanged: awaiting-only payments are never_paid with no invoice read", async () => {
		stripe.intents = [{ status: "requires_payment_method" }];
		expect(await readFirstPayment(sub())).toBe("never_paid");
		expect(stripe.invoiceReads).toBe(0);
	});

	it("unchanged: incomplete_expired with canceled payments is never_paid; a live status is not proven", async () => {
		stripe.intents = [{ status: "canceled" }];
		expect(await readFirstPayment(sub("incomplete_expired"))).toBe("never_paid");
		expect(await readFirstPayment(sub("active"))).toBe("not_proven_unpaid");
	});
});
