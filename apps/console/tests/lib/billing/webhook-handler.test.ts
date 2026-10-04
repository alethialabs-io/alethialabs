// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The Stripe event dispatcher's half of #5514. The row-level guard lives in the database write
// (tests/integration/billing-sync.test.ts proves it against real Postgres); what this file pins is
// that the dispatcher FEEDS that guard — every subscription sync carries the event's own `created`
// time, without which a stale or redelivered event is indistinguishable from a fresh one — and that
// a deletion the guard refused does not tell the customer their subscription was canceled.

import type Stripe from "stripe";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/analytics/server", () => ({ captureServer: vi.fn() }));
vi.mock("@/lib/billing/ai-quota", () => ({ grantAiCredits: vi.fn() }));
vi.mock("@/lib/billing/invoices", () => ({
	mirrorPaidInvoice: vi.fn(),
	setInvoiceStatus: vi.fn(),
}));
vi.mock("@/lib/billing/payment-methods", () => ({ attemptBackupPayment: vi.fn() }));
vi.mock("@/lib/billing/stripe", () => ({ getStripe: vi.fn() }));
vi.mock("@/lib/billing/sync", () => ({ syncSubscriptionToBilling: vi.fn() }));
vi.mock("@/lib/email/billing-email", () => ({
	sendCreditPackReceiptEmail: vi.fn(),
	sendPaymentFailedEmail: vi.fn(),
	sendReceiptEmail: vi.fn(),
	sendSubscriptionCanceledEmail: vi.fn(),
	sendTrialEndingEmail: vi.fn(),
}));

import { captureServer } from "@/lib/analytics/server";
import { handleStripeEvent } from "@/lib/billing/webhook-handler";
import { syncSubscriptionToBilling } from "@/lib/billing/sync";
import { sendSubscriptionCanceledEmail } from "@/lib/email/billing-email";

/** Stripe's `created` for every event below: 2026-10-01T12:00:00Z, in seconds. */
const CREATED = 1_790_856_000;

/** True when a fixture carries the fields the dispatcher reads off an event. */
function isEventFixture(x: unknown): x is Stripe.Event {
	return (
		typeof x === "object" &&
		x !== null &&
		"type" in x &&
		"created" in x &&
		"data" in x
	);
}

/** A subscription event of `type`, created at CREATED, carrying a minimal subscription. */
function subscriptionEvent(type: string): { event: Stripe.Event; subscription: unknown } {
	const subscription = {
		id: "sub_z",
		object: "subscription",
		status: "canceled",
		customer: "cus_1",
		metadata: { organization_id: "org_1" },
		items: { data: [] },
	};
	const fixture: unknown = {
		id: "evt_1",
		object: "event",
		type,
		created: CREATED,
		data: { object: subscription },
	};
	if (!isEventFixture(fixture)) throw new Error("event fixture is malformed");
	return { event: fixture, subscription };
}

describe("handleStripeEvent → syncSubscriptionToBilling (#5514)", () => {
	beforeEach(() => {
		vi.mocked(syncSubscriptionToBilling).mockReset();
		vi.mocked(sendSubscriptionCanceledEmail).mockClear();
		vi.mocked(captureServer).mockClear();
	});

	it.each(["customer.subscription.created", "customer.subscription.updated"])(
		"%s syncs with the event's own created time",
		async (type) => {
			vi.mocked(syncSubscriptionToBilling).mockResolvedValue("applied");
			const { event, subscription } = subscriptionEvent(type);
			await handleStripeEvent(event);
			expect(syncSubscriptionToBilling).toHaveBeenCalledWith(subscription, {
				eventAt: new Date(CREATED * 1000),
			});
		},
	);

	it("a deletion the row REFUSED (another subscription's) sends no cancellation email", async () => {
		vi.mocked(syncSubscriptionToBilling).mockResolvedValue("ignored");
		const { event, subscription } = subscriptionEvent("customer.subscription.deleted");
		await handleStripeEvent(event);
		expect(syncSubscriptionToBilling).toHaveBeenCalledWith(subscription, {
			eventAt: new Date(CREATED * 1000),
		});
		expect(sendSubscriptionCanceledEmail).not.toHaveBeenCalled();
		expect(captureServer).not.toHaveBeenCalled();
	});
});
