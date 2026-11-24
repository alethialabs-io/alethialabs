// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The webhook's half of the trial end (REL-L19 #6907): when Stripe cancels a card-less trial that ran
// out with no payment method, the deletion is applied through the same guarded sync as any other —
// which is what returns the org to Hobby with its data kept — and the customer is told their TRIAL
// ended, not that a subscription they never had was canceled. The reminder before the end stays the
// `trial_will_end` email.

import type Stripe from "stripe";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/analytics/server", () => ({ captureServer: vi.fn() }));
vi.mock("@/lib/billing/ai-quota", () => ({ grantAiCredits: vi.fn() }));
vi.mock("@/lib/billing/factura/credit-note", () => ({
	issueCreditNotesForCharge: vi.fn(async () => []),
	issueCreditNoteForRefund: vi.fn(async () => []),
}));
vi.mock("@/lib/billing/invoices", () => ({ mirrorPaidInvoice: vi.fn(), setInvoiceStatus: vi.fn() }));
vi.mock("@/lib/billing/payment-methods", () => ({ attemptBackupPayment: vi.fn() }));
vi.mock("@/lib/billing/stripe", () => ({ getStripe: () => ({ subscriptions: { retrieve: vi.fn(), list: vi.fn() } }) }));
vi.mock("@/lib/billing/sync", async (importActual) => ({
	...(await importActual<typeof import("@/lib/billing/sync")>()),
	syncSubscriptionToBilling: vi.fn(),
}));
vi.mock("@/lib/billing/org-plan-row", async (importActual) => ({
	...(await importActual<typeof import("@/lib/billing/org-plan-row")>()),
	repointAfterEnd: vi.fn(async () => null),
}));
vi.mock("@/lib/email/billing-email", () => ({
	sendCreditPackReceiptEmail: vi.fn(),
	sendPaymentFailedEmail: vi.fn(),
	sendReceiptEmail: vi.fn(),
	sendSubscriptionCanceledEmail: vi.fn(),
	sendTrialEndedEmail: vi.fn(),
	sendTrialEndingEmail: vi.fn(),
}));

import { type HandleEventOptions, handleStripeEvent } from "@/lib/billing/webhook-handler";
import { syncSubscriptionToBilling } from "@/lib/billing/sync";
import {
	sendSubscriptionCanceledEmail,
	sendTrialEndedEmail,
	sendTrialEndingEmail,
} from "@/lib/email/billing-email";

const CREATED = 1_796_083_300;
const TRIAL_END = 1_796_083_200;

const noHolds: HandleEventOptions = {
	holds: {
		heldInvoice: async () => null,
		holdNamesSubscription: async () => false,
		nudgeSubscription: async () => 0,
		nudgeRefund: async () => 0,
	},
};

/** An event of `type` carrying a trial subscription with `over` applied. */
function trialEvent(type: string, over: Record<string, unknown> = {}): Stripe.Event {
	const fixture: unknown = {
		id: "evt_trial",
		object: "event",
		type,
		created: CREATED,
		data: {
			object: {
				id: "sub_trial",
				object: "subscription",
				status: "canceled",
				customer: "cus_1",
				metadata: { organization_id: "org_1" },
				items: { data: [] },
				default_payment_method: null,
				trial_end: TRIAL_END,
				ended_at: TRIAL_END,
				canceled_at: TRIAL_END,
				trial_settings: { end_behavior: { missing_payment_method: "cancel" } },
				...over,
			},
		},
	};
	return fixture as Stripe.Event;
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(syncSubscriptionToBilling).mockResolvedValue("applied");
});

describe("the end of a card-less trial", () => {
	it("applies the deletion through the guarded sync, and sends the trial-ended email instead of a cancellation", async () => {
		const event = trialEvent("customer.subscription.deleted");
		await handleStripeEvent(event, noHolds);
		expect(syncSubscriptionToBilling).toHaveBeenCalledWith(event.data.object, { eventAt: new Date(CREATED * 1000) });
		expect(sendTrialEndedEmail).toHaveBeenCalledWith(event.data.object);
		expect(sendSubscriptionCanceledEmail).not.toHaveBeenCalled();
	});

	it("tells a customer who cancelled mid-trial about a cancellation", async () => {
		const early = TRIAL_END - 10 * 86_400;
		await handleStripeEvent(trialEvent("customer.subscription.deleted", { ended_at: early, canceled_at: early }), noHolds);
		expect(sendSubscriptionCanceledEmail).toHaveBeenCalledTimes(1);
		expect(sendTrialEndedEmail).not.toHaveBeenCalled();
	});

	it("sends nothing for a deletion the row refused", async () => {
		vi.mocked(syncSubscriptionToBilling).mockResolvedValue("ignored");
		await handleStripeEvent(trialEvent("customer.subscription.deleted"), noHolds);
		expect(sendTrialEndedEmail).not.toHaveBeenCalled();
		expect(sendSubscriptionCanceledEmail).not.toHaveBeenCalled();
	});

	it("sends no email on a replay", async () => {
		await handleStripeEvent(trialEvent("customer.subscription.deleted"), { ...noHolds, suppressEmails: true });
		expect(sendTrialEndedEmail).not.toHaveBeenCalled();
	});

	it("sends the reminder before the end on trial_will_end", async () => {
		const event = trialEvent("customer.subscription.trial_will_end", { status: "trialing", ended_at: null, canceled_at: null });
		await handleStripeEvent(event, noHolds);
		expect(sendTrialEndingEmail).toHaveBeenCalledWith(event.data.object);
	});
});
