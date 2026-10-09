// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Integration (real Postgres): the Stripe webhook route on payment holds (ADR 0002 §5.3, S7). The
// route, the exactly-once bookkeeping (`stripe_webhook_event` + the advisory lock), the live hold port
// (`liveWebhookHolds`) and the store's `nudgeHold` are all real; Stripe, the sync, the emails and the
// sweeper's wake are faked.
//
//   DEDUP     the same event delivered twice — one after the other, and concurrently — runs the hold
//             read and nudge ONCE: the second delivery leaves `nudged_at` alone and schedules no wake.
//   CUSTOMER  the live nudge is keyed on the event's subscription AND customer: an event naming the
//             subscription with another customer nudges nothing.
//   REFUND    a refund whose metadata names a hold reaches only that hold's `nudged_at`, never its
//             state or `version`; and a hold that knows its PaymentIntent is not nudged by a refund of
//             another PaymentIntent that carries its id.

import { randomUUID } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeEach, expect, it, vi } from "vitest";

const stripeMock = vi.hoisted(() => ({ constructEventAsync: vi.fn(), retrieve: vi.fn() }));
vi.mock("@/lib/billing/stripe", () => ({
	getStripe: () => ({
		webhooks: { constructEventAsync: stripeMock.constructEventAsync },
		subscriptions: { retrieve: stripeMock.retrieve },
	}),
}));
vi.mock("@/lib/billing/config", () => ({
	isStripeConfigured: () => true,
	getStripeConfig: () => ({ webhookSecret: "whsec_test" }),
}));
vi.mock("@/lib/analytics/server", () => ({ captureServer: vi.fn(), captureServerException: vi.fn() }));
vi.mock("@/lib/billing/ai-quota", () => ({ grantAiCredits: vi.fn() }));
vi.mock("@/lib/billing/invoices", () => ({ mirrorPaidInvoice: vi.fn(), setInvoiceStatus: vi.fn() }));
vi.mock("@/lib/billing/payment-methods", () => ({ attemptBackupPayment: vi.fn(async () => null) }));
vi.mock("@/lib/billing/sync", () => ({ syncSubscriptionToBilling: vi.fn(async () => "ignored") }));
vi.mock("@/lib/email/billing-email", () => ({
	sendCreditPackReceiptEmail: vi.fn(),
	sendPaymentFailedEmail: vi.fn(),
	sendReceiptEmail: vi.fn(),
	sendSubscriptionCanceledEmail: vi.fn(),
	sendTrialEndingEmail: vi.fn(),
}));
vi.mock("@/lib/billing/payment-holds/sweeper", () => ({ wakePaymentHoldSweeper: vi.fn() }));
vi.mock("next/server", () => ({ after: vi.fn() }));

import { after } from "next/server";
import type Stripe from "stripe";
import { POST } from "@/app/api/webhooks/stripe/route";
import { getServiceDb } from "@/lib/db";
import { type PaymentHoldRow, paymentHolds, stripeWebhookEvent } from "@/lib/db/schema";
import { describeIfDb } from "./db";

const holdIds: string[] = [];
const eventIds: string[] = [];

/** A unique Stripe-style id with `prefix`. */
function uid(prefix: string): string {
	return `${prefix}_s7_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

/** Inserts an open hold (a test fixture; production opens holds only through the store's `openHold`). */
async function seedHold(over: Partial<typeof paymentHolds.$inferInsert> = {}): Promise<PaymentHoldRow> {
	const [row] = await getServiceDb()
		.insert(paymentHolds)
		.values({
			subscription_id: uid("sub"),
			customer_id: uid("cus"),
			payer_key: uid("user"),
			invoice_id: uid("in"),
			state: "closing",
			next_check_at: sql`now() + interval '1 hour'`,
			opened_by: "purchase",
			...over,
		})
		.returning();
	if (!row) throw new Error("seed failed");
	holdIds.push(row.id);
	return row;
}

/** The hold `id` as stored now. */
async function readHold(id: string): Promise<PaymentHoldRow> {
	const [row] = await getServiceDb().select().from(paymentHolds).where(eq(paymentHolds.id, id));
	if (!row) throw new Error(`hold ${id} is gone`);
	return row;
}

/** True when a fixture has the fields the route and dispatcher read off an event. */
function isEvent(x: unknown): x is Stripe.Event {
	return typeof x === "object" && x !== null && "id" in x && "type" in x && "data" in x;
}

/** A `customer.subscription.updated` event for `subscriptionId` on `customerId`, with a fresh id. */
function updatedEvent(subscriptionId: string, customerId: string): Stripe.Event {
	const id = uid("evt");
	eventIds.push(id);
	const e: unknown = {
		id,
		object: "event",
		type: "customer.subscription.updated",
		created: Math.floor(Date.now() / 1000),
		data: { object: { id: subscriptionId, object: "subscription", status: "incomplete", customer: customerId, metadata: {} } },
	};
	if (!isEvent(e)) throw new Error("bad fixture");
	return e;
}

/** A `charge.refund.updated` event for a refund of `paymentIntentId` whose metadata names `holdId`. */
function refundEvent(holdId: string, paymentIntentId: string): Stripe.Event {
	const id = uid("evt");
	eventIds.push(id);
	const e: unknown = {
		id,
		object: "event",
		type: "charge.refund.updated",
		created: Math.floor(Date.now() / 1000),
		data: { object: { id: uid("re"), object: "refund", payment_intent: paymentIntentId, metadata: { alethia_payment_hold: holdId } } },
	};
	if (!isEvent(e)) throw new Error("bad fixture");
	return e;
}

/** Delivers `event` to the route as Stripe would (the signature check is faked to accept it). */
async function deliver(event: Stripe.Event): Promise<Response> {
	stripeMock.constructEventAsync.mockResolvedValueOnce(event);
	return POST(
		new Request("https://console.test/api/webhooks/stripe", {
			method: "POST",
			body: JSON.stringify(event),
			headers: { "stripe-signature": "t=1,v1=sig" },
		}),
	);
}

/** Marks a hold observed AFTER its nudge, as a sweeper tick would; returns the nudge it saw. */
async function observeAfterNudge(id: string): Promise<Date> {
	const [row] = await getServiceDb()
		.update(paymentHolds)
		.set({ observed_at: sql`${paymentHolds.nudged_at} + interval '1 second'` })
		.where(eq(paymentHolds.id, id))
		.returning();
	if (!row?.nudged_at) throw new Error("hold was never nudged");
	return row.nudged_at;
}

describeIfDb("the Stripe webhook route on payment holds (real Postgres)", () => {
	beforeEach(() => {
		vi.mocked(after).mockClear();
		stripeMock.constructEventAsync.mockReset();
		stripeMock.retrieve.mockReset();
	});

	afterAll(async () => {
		if (holdIds.length) await getServiceDb().delete(paymentHolds).where(inArray(paymentHolds.id, holdIds));
		if (eventIds.length) {
			await getServiceDb().delete(stripeWebhookEvent).where(inArray(stripeWebhookEvent.eventId, eventIds));
		}
	});

	it("DEDUP: a redelivered event does not nudge again and schedules no second wake", async () => {
		const h = await seedHold();
		stripeMock.retrieve.mockResolvedValue({ id: h.subscription_id, status: "incomplete", customer: h.customer_id, metadata: {} });
		const event = updatedEvent(h.subscription_id, h.customer_id);

		const first = await deliver(event);
		expect(first.status).toBe(200);
		expect(after).toHaveBeenCalledTimes(1);
		const seen = await observeAfterNudge(h.id);

		const second = await deliver(event);
		expect(await second.json()).toEqual({ received: true, duplicate: true });
		const after2 = await readHold(h.id);
		expect(after2.nudged_at?.getTime()).toBe(seen.getTime());
		expect(after2.version).toBe(h.version);
		expect(after).toHaveBeenCalledTimes(1);
	});

	it("DEDUP: two concurrent deliveries of one event nudge once and schedule one wake", async () => {
		const h = await seedHold();
		stripeMock.retrieve.mockResolvedValue({ id: h.subscription_id, status: "incomplete", customer: h.customer_id, metadata: {} });
		const event = updatedEvent(h.subscription_id, h.customer_id);
		const [a, b] = await Promise.all([deliver(event), deliver(event)]);
		expect([a.status, b.status]).toEqual([200, 200]);
		expect(after).toHaveBeenCalledTimes(1);
		const [row] = await getServiceDb()
			.select({ status: stripeWebhookEvent.status })
			.from(stripeWebhookEvent)
			.where(eq(stripeWebhookEvent.eventId, event.id));
		expect(row?.status).toBe("done");
	});

	it("CUSTOMER: an event naming the subscription with another customer nudges nothing", async () => {
		const h = await seedHold();
		stripeMock.retrieve.mockResolvedValue({ id: h.subscription_id, status: "incomplete", customer: uid("cus"), metadata: {} });
		const res = await deliver(updatedEvent(h.subscription_id, uid("cus")));
		expect(res.status).toBe(200);
		expect((await readHold(h.id)).nudged_at).toBeNull();
		expect(after).not.toHaveBeenCalled();
	});

	it("REFUND: a refund naming a hold reaches only that hold's nudged_at — never its state or version", async () => {
		const h = await seedHold({ state: "refund_due" });
		const other = await seedHold();
		const res = await deliver(refundEvent(h.id, uid("pi")));
		expect(res.status).toBe(200);
		const row = await readHold(h.id);
		expect(row.nudged_at).not.toBeNull();
		expect(row.state).toBe("refund_due");
		expect(row.version).toBe(h.version);
		expect((await readHold(other.id)).nudged_at).toBeNull();
	});

	it("REFUND: a hold that knows its PaymentIntent is not nudged by another PaymentIntent's refund carrying its id", async () => {
		const h = await seedHold({ payment_intent_id: uid("pi") });
		const res = await deliver(refundEvent(h.id, uid("pi")));
		expect(res.status).toBe(200);
		expect((await readHold(h.id)).nudged_at).toBeNull();
		expect(after).not.toHaveBeenCalled();
	});
});
