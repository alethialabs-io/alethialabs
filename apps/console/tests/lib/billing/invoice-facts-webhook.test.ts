// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The webhook's half of #7327 (EA-5): a paid invoice is mirrored THEN its tax facts are recorded, a
// facts failure never fails the event, a failed mirror records no facts, and a refund reaches the
// invoice's status.

import type Stripe from "stripe";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/analytics/server", () => ({ captureServer: vi.fn() }));
vi.mock("@/lib/billing/ai-quota", () => ({ grantAiCredits: vi.fn() }));
vi.mock("@/lib/billing/invoices", () => ({ mirrorPaidInvoice: vi.fn(), setInvoiceStatus: vi.fn() }));
vi.mock("@/lib/billing/invoice-facts", () => ({
	recordInvoiceFacts: vi.fn(),
	markRefundedInvoice: vi.fn(),
}));
vi.mock("@/lib/billing/payment-methods", () => ({ attemptBackupPayment: vi.fn() }));
vi.mock("@/lib/billing/factura/credit-note", () => ({
	issueCreditNotesForCharge: vi.fn(),
	issueCreditNoteForRefund: vi.fn(),
}));
const stripeClient = vi.hoisted(() => ({ subscriptions: { retrieve: vi.fn(), list: vi.fn() } }));
vi.mock("@/lib/billing/stripe", () => ({ getStripe: () => stripeClient }));
vi.mock("@/lib/email/billing-email", () => ({
	sendCreditPackReceiptEmail: vi.fn(),
	sendPaymentFailedEmail: vi.fn(),
	sendReceiptEmail: vi.fn(),
	sendSubscriptionCanceledEmail: vi.fn(),
	sendTrialEndedEmail: vi.fn(),
	sendTrialEndingEmail: vi.fn(),
}));

import { issueCreditNotesForCharge } from "@/lib/billing/factura/credit-note";
import { markRefundedInvoice, recordInvoiceFacts } from "@/lib/billing/invoice-facts";
import { mirrorPaidInvoice } from "@/lib/billing/invoices";
import { handleStripeEvent, type WebhookHoldPort } from "@/lib/billing/webhook-handler";
import { log } from "@/lib/observability/log";

/** A hold port that names no hold. */
const noHolds: WebhookHoldPort = {
	heldInvoice: async () => null,
	holdNamesSubscription: async () => false,
	nudgeSubscription: async () => 0,
	nudgeRefund: async () => 0,
};

/** A verified event carrying `object`. */
function eventOf(type: string, object: object): Stripe.Event {
	return { id: "evt_1", type, created: 1_800_000_000, data: { object } } as unknown as Stripe.Event;
}

/** A paid AI credit-pack invoice: the branch that mirrors without touching subscriptions. */
const creditPack = {
	id: "in_1",
	currency: "eur",
	metadata: { product_type: "ai_credits", organization_id: "org_1", user_id: "u_1", credits: "100" },
};

beforeEach(() => {
	vi.mocked(mirrorPaidInvoice).mockReset();
	vi.mocked(recordInvoiceFacts).mockReset();
	vi.mocked(markRefundedInvoice).mockReset();
	vi.mocked(issueCreditNotesForCharge).mockReset();
});

describe("invoice.payment_succeeded records the tax facts", () => {
	it("mirrors, then records the facts for the same invoice and org", async () => {
		const order: string[] = [];
		vi.mocked(mirrorPaidInvoice).mockImplementation(async () => {
			order.push("mirror");
		});
		vi.mocked(recordInvoiceFacts).mockImplementation(async () => {
			order.push("facts");
			return { recorded: false, reason: "already_recorded" };
		});
		await handleStripeEvent(eventOf("invoice.payment_succeeded", creditPack), { holds: noHolds, suppressEmails: true });
		expect(order).toEqual(["mirror", "facts"]);
		expect(recordInvoiceFacts).toHaveBeenCalledWith(expect.objectContaining({ id: "in_1" }), "org_1");
	});

	it("a facts failure is logged and never fails the event", async () => {
		const boom = new Error("db down");
		vi.mocked(recordInvoiceFacts).mockRejectedValue(boom);
		const logged = vi.spyOn(log, "error").mockImplementation(() => {});
		await expect(
			handleStripeEvent(eventOf("invoice.payment_succeeded", creditPack), { holds: noHolds, suppressEmails: true }),
		).resolves.toEqual({ nudged: 0 });
		expect(logged).toHaveBeenCalledWith("[stripe] invoice facts failed for in_1", { err: boom });
		logged.mockRestore();
	});

	it("a failed mirror records no facts: there is no row to write them onto", async () => {
		vi.mocked(mirrorPaidInvoice).mockRejectedValue(new Error("mirror down"));
		const logged = vi.spyOn(log, "error").mockImplementation(() => {});
		await handleStripeEvent(eventOf("invoice.payment_succeeded", creditPack), { holds: noHolds, suppressEmails: true });
		expect(recordInvoiceFacts).not.toHaveBeenCalled();
		logged.mockRestore();
	});
});

describe("charge.refunded reaches the invoice", () => {
	it("hands the charge to markRefundedInvoice with the Stripe client", async () => {
		const charge = { id: "ch_1", refunded: true, payment_intent: "pi_1" };
		await handleStripeEvent(eventOf("charge.refunded", charge), { holds: noHolds });
		expect(markRefundedInvoice).toHaveBeenCalledWith(charge, stripeClient);
	});

	it("issues the charge's credit notes after the status write (#7369)", async () => {
		const order: string[] = [];
		vi.mocked(markRefundedInvoice).mockImplementation(async () => {
			order.push("status");
			return "in_1";
		});
		vi.mocked(issueCreditNotesForCharge).mockImplementation(async () => {
			order.push("credit-notes");
			return [];
		});
		const charge = { id: "ch_1", refunded: false, payment_intent: "pi_1" };
		await handleStripeEvent(eventOf("charge.refunded", charge), { holds: noHolds });
		expect(order).toEqual(["status", "credit-notes"]);
		expect(issueCreditNotesForCharge).toHaveBeenCalledWith(charge, stripeClient);
	});

	it("a credit-note store failure fails the event, so Stripe redelivers it", async () => {
		vi.mocked(issueCreditNotesForCharge).mockRejectedValue(new Error("credit note: store_failed"));
		await expect(
			handleStripeEvent(eventOf("charge.refunded", { id: "ch_1", refunded: false }), { holds: noHolds }),
		).rejects.toThrow("store_failed");
	});

	it("a Stripe error fails the event, so Stripe redelivers it", async () => {
		vi.mocked(markRefundedInvoice).mockRejectedValue(new Error("stripe 500"));
		await expect(
			handleStripeEvent(eventOf("charge.refunded", { id: "ch_1", refunded: true }), { holds: noHolds }),
		).rejects.toThrow("stripe 500");
	});
});
