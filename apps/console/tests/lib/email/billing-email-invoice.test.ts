// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// EA-7b (#7338): a receipt never hands the customer Stripe's PDF as the invoice.
//
// The receipt and credit-pack senders run for real, with the REAL templates rendered to text, so
// the assertions read what a person reads. Only the фактура source (`issuedFacturaFor`) and the guarded
// sender are replaced. Every Stripe invoice below carries an `invoice_pdf` URL and a Stripe
// `number`, and `fetch` is spied on, so a restored fallback to Stripe's PDF or Stripe's number
// fails a case rather than passing silently.

import { render } from "@react-email/components";
import type Stripe from "stripe";
import { type MockInstance, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/billing/config", () => ({ planForPriceId: vi.fn(() => "team") }));
vi.mock("@/lib/billing/stripe", () => ({ getStripe: vi.fn() }));
vi.mock("@/lib/billing/factura/issue", () => ({ issuedFacturaFor: vi.fn() }));
vi.mock("@/lib/db", () => {
	/** A self-returning query builder whose `limit` resolves to one row. */
	const chain = {
		select: () => chain,
		from: () => chain,
		innerJoin: () => chain,
		where: () => chain,
		orderBy: () => chain,
		limit: async () => [{ name: "Acme Cloud", email: "owner@example.test" }],
	};
	return { getServiceDb: () => chain };
});
vi.mock("@repo/email/config", () => ({
	getEmailConfig: () => ({ from: { general: "billing@example.test" }, configSet: { general: "general" } }),
}));
vi.mock("@/lib/email/guard", () => ({ sendGuardedEmail: vi.fn() }));

import { issuedFacturaFor } from "@/lib/billing/factura/issue";
import { sendCreditPackReceiptEmail, sendReceiptEmail } from "@/lib/email/billing-email";
import { sendGuardedEmail } from "@/lib/email/guard";

const STRIPE_NUMBER = "ABCD-0031";
const FACTURA_NUMBER = "0000000042";
const FACTURA_PDF = new Uint8Array([37, 80, 68, 70, 45]);

/** A paid Stripe invoice carrying Stripe's own PDF link and number — the things never to send. */
function stripeInvoice(over: Partial<Stripe.Invoice> = {}): Stripe.Invoice {
	const base: Partial<Stripe.Invoice> = {
		id: "in_1",
		number: STRIPE_NUMBER,
		invoice_pdf: "https://pay.stripe.test/invoice/in_1/pdf",
		amount_paid: 5800,
		amount_due: 5800,
		currency: "usd",
		customer: "cus_1",
		customer_email: "billing@acme.test",
		period_start: 1_798_761_600,
		period_end: 1_801_440_000,
		metadata: { organization_id: "org-1", credits: "2000" },
		...over,
	};
	return base as Stripe.Invoice;
}

/** A subscription with no items: the plan name then comes from metadata. */
function subscription(): Stripe.Subscription {
	const base: Partial<Stripe.Subscription> = {
		id: "sub_1",
		status: "active",
		customer: "cus_1",
		metadata: { organization_id: "org-1", plan: "team" },
		items: { object: "list", data: [], has_more: false, url: "" },
	};
	return base as Stripe.Subscription;
}

/** The one email the sender was asked to send, with its body rendered to plain text. */
async function sentEmail(): Promise<{ text: string; attachments: unknown }> {
	expect(sendGuardedEmail).toHaveBeenCalledTimes(1);
	const [args] = vi.mocked(sendGuardedEmail).mock.calls[0];
	return { text: await render(args.react, { plainText: true }), attachments: args.attachments };
}

let fetchSpy: MockInstance<typeof fetch>;

beforeEach(() => {
	vi.clearAllMocks();
	fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("no network in this suite"));
});

afterEach(() => {
	fetchSpy.mockRestore();
});

describe.each([
	["subscription receipt", () => sendReceiptEmail(subscription(), stripeInvoice())],
	["credit-pack receipt", () => sendCreditPackReceiptEmail(stripeInvoice())],
])("%s", (_name, send) => {
	it("attaches the фактура and names its number when one was issued", async () => {
		vi.mocked(issuedFacturaFor).mockResolvedValue({
			number: FACTURA_NUMBER,
			currency: "usd",
			vatGround: "чл. 113, ал. 9 ЗДДС",
			pdfKey: "org-1/in_1.pdf",
			pdf: FACTURA_PDF,
		});
		await send();
		const { text, attachments } = await sentEmail();
		expect(attachments).toEqual([
			{ filename: `Invoice-${FACTURA_NUMBER}.pdf`, content: FACTURA_PDF, contentType: "application/pdf" },
		]);
		expect(text).toContain(FACTURA_NUMBER);
		expect(text).toContain("Your invoice is attached as a PDF");
		expect(text).not.toContain(STRIPE_NUMBER);
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("sends no attachment, no Stripe number, and says the invoice follows when no фактура exists", async () => {
		vi.mocked(issuedFacturaFor).mockResolvedValue(null);
		await send();
		const { text, attachments } = await sentEmail();
		expect(attachments).toBeUndefined();
		expect(text).toContain("Your invoice is being issued and will follow");
		expect(text).not.toContain("attached");
		expect(text).not.toContain(STRIPE_NUMBER);
		// Stripe's PDF is never fetched, so it cannot be attached under any name.
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("still sends the receipt, without an attachment, when reading the фактура throws", async () => {
		vi.mocked(issuedFacturaFor).mockRejectedValue(new Error("store exploded"));
		await send();
		const { text, attachments } = await sentEmail();
		expect(attachments).toBeUndefined();
		expect(text).toContain("will follow");
		expect(fetchSpy).not.toHaveBeenCalled();
	});
});
