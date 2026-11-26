// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// The trial's two emails (REL-L19 #6907): the reminder before the end, which asks for a payment
// method only when none is on file, and the notice at the end. The senders run for real; the
// templates are rendered to text so the assertions read what a person reads. No email is sent —
// the guarded sender is replaced.

import { render } from "@react-email/components";
import type Stripe from "stripe";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/billing/config", () => ({ planForPriceId: vi.fn(() => "team") }));
const stripe = vi.hoisted(() => ({ customersRetrieve: vi.fn() }));
vi.mock("@/lib/billing/stripe", () => ({
	getStripe: () => ({ customers: { retrieve: stripe.customersRetrieve } }),
}));
vi.mock("@/lib/billing/factura/issue", () => ({ issuedFacturaFor: vi.fn(async () => null) }));
vi.mock("@/lib/db", () => {
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

import { sendLocalTrialNoticeEmail, sendTrialEndedEmail, sendTrialEndingEmail } from "@/lib/email/billing-email";
import { sendGuardedEmail } from "@/lib/email/guard";

const TRIAL_END = 1_796_083_200;

/** A trial subscription with `over` applied. */
function sub(over: Record<string, unknown> = {}): Stripe.Subscription {
	const fixture: unknown = {
		id: "sub_trial",
		status: "trialing",
		customer: "cus_1",
		metadata: { organization_id: "org-1" },
		items: { data: [{ id: "si_1", price: { id: "price_team", recurring: { usage_type: "licensed" } } }] },
		default_payment_method: null,
		trial_end: TRIAL_END,
		...over,
	};
	return fixture as Stripe.Subscription;
}

/** The last email handed to the guarded sender: its recipient, subject and rendered text. */
async function lastEmail(): Promise<{ to: string; subject: string; text: string }> {
	const call = vi.mocked(sendGuardedEmail).mock.calls.at(-1);
	if (!call) throw new Error("no email was handed to the sender");
	const [args] = call;
	return { to: args.to, subject: args.subject, text: (await render(args.react, { plainText: true })).replace(/\s+/g, " ") };
}

beforeEach(() => {
	vi.clearAllMocks();
	stripe.customersRetrieve.mockResolvedValue({ id: "cus_1", email: "billing@acme.test", invoice_settings: {} });
});

describe("the reminder before the trial ends", () => {
	it("asks a card-less trial for a payment method, and says it returns to Hobby with nothing deleted", async () => {
		await sendTrialEndingEmail(sub());
		const email = await lastEmail();
		expect(email.to).toBe("billing@acme.test");
		expect(email.text).toMatch(/Add a payment method/);
		expect(email.text).toMatch(/free Hobby plan/);
		expect(email.text).toMatch(/Nothing is deleted/);
	});

	it("tells a trial with a payment method on file that the plan continues", async () => {
		stripe.customersRetrieve.mockResolvedValue({
			id: "cus_1",
			email: "billing@acme.test",
			invoice_settings: { default_payment_method: "pm_1" },
		});
		await sendTrialEndingEmail(sub());
		const email = await lastEmail();
		expect(email.text).toMatch(/payment method is on file/);
		expect(email.text).not.toMatch(/Add payment method/);
	});

	it("reads the subscription's own payment method without asking the customer's", async () => {
		await sendTrialEndingEmail(sub({ default_payment_method: "pm_sub", customer: { id: "cus_1", email: "x@acme.test" } }));
		expect(stripe.customersRetrieve).not.toHaveBeenCalled();
		expect((await lastEmail()).text).toMatch(/payment method is on file/);
	});

	it("sends nothing without a trial end or a recipient", async () => {
		await sendTrialEndingEmail(sub({ trial_end: null }));
		stripe.customersRetrieve.mockResolvedValue({ id: "cus_1", deleted: true });
		await sendTrialEndingEmail(sub());
		expect(sendGuardedEmail).not.toHaveBeenCalled();
	});
});

describe("the notice at the trial's end", () => {
	it("says the organization is on Hobby now, nothing was deleted, and nothing was charged", async () => {
		await sendTrialEndedEmail(sub({ status: "canceled" }));
		const email = await lastEmail();
		expect(email.to).toBe("billing@acme.test");
		expect(email.subject).toMatch(/trial has ended/);
		expect(email.text).toMatch(/Acme Cloud/);
		expect(email.text).toMatch(/free Hobby plan/);
		expect(email.text).toMatch(/Nothing is deleted/);
		expect(email.text).toMatch(/not charged/);
	});

	it("sends nothing without a recipient", async () => {
		stripe.customersRetrieve.mockResolvedValue({ id: "cus_1", deleted: true });
		await sendTrialEndedEmail(sub({ status: "canceled", trial_end: null }));
		expect(sendGuardedEmail).not.toHaveBeenCalled();
	});
});

describe("a local trial's emails (the trial-notice sweep)", () => {
	const trialEnd = new Date("2026-12-13T12:00:00Z");

	it("reminds the org owner to SUBSCRIBE, never to add a card to a subscription it lacks", async () => {
		expect(await sendLocalTrialNoticeEmail({ orgId: "org-1", notice: "ending", trialEnd })).toBe(true);
		const email = await lastEmail();
		expect(email.to).toBe("owner@example.test");
		expect(email.subject).toMatch(/trial ends soon/);
		expect(email.text).toMatch(/13 Dec 2026/);
		expect(email.text).toMatch(/Subscribe to keep Pro/);
		expect(email.text).toMatch(/Subscribe to Pro/);
		expect(email.text).not.toMatch(/Add a payment method|Add payment method/);
		expect(email.text).toMatch(/Nothing is deleted/);
		expect(stripe.customersRetrieve).not.toHaveBeenCalled();
	});

	it("tells the owner the trial ended with no subscription started", async () => {
		expect(await sendLocalTrialNoticeEmail({ orgId: "org-1", notice: "ended", trialEnd })).toBe(true);
		const email = await lastEmail();
		expect(email.subject).toMatch(/trial has ended/);
		expect(email.text).toMatch(/no subscription was started/);
		expect(email.text).not.toMatch(/no payment method was added/);
		expect(email.text).toMatch(/free Hobby plan/);
	});
});
