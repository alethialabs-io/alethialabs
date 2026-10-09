// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The W cases of ADR 0002 §6 for S7: the Stripe webhook on payment holds (§5.3, Q6).
//
// The dispatcher runs over a fake Stripe whose only read is `subscriptions.retrieve` and whose writes
// are spies that must stay silent, and over an in-memory hold table injected as its `WebhookHoldPort`.
// The machine and the store's state writes are mocked too, so a dispatcher that ACTED on a hold
// instead of nudging it would show up as a call. The route half pins that signature verification
// runs first and that the sweeper is woken only after the response, through `after`.

import type Stripe from "stripe";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/analytics/server", () => ({
	captureServer: vi.fn(),
	captureServerException: vi.fn(),
}));
vi.mock("@/lib/billing/ai-quota", () => ({ grantAiCredits: vi.fn() }));
vi.mock("@/lib/billing/invoices", () => ({
	mirrorPaidInvoice: vi.fn(),
	setInvoiceStatus: vi.fn(),
}));
vi.mock("@/lib/billing/payment-methods", () => ({ attemptBackupPayment: vi.fn() }));
const stripeMock = vi.hoisted(() => ({
	retrieve: vi.fn(),
	pay: vi.fn(),
	voidInvoice: vi.fn(),
	cancel: vi.fn(),
	refundsCreate: vi.fn(),
	constructEventAsync: vi.fn(),
}));
vi.mock("@/lib/billing/stripe", () => ({
	getStripe: () => ({
		subscriptions: { retrieve: stripeMock.retrieve, cancel: stripeMock.cancel },
		invoices: { pay: stripeMock.pay, voidInvoice: stripeMock.voidInvoice },
		refunds: { create: stripeMock.refundsCreate },
		webhooks: { constructEventAsync: stripeMock.constructEventAsync },
	}),
	getPurchaseStripe: () => {
		throw new Error("the webhook must never build the purchase client");
	},
}));
vi.mock("@/lib/billing/sync", () => ({ syncSubscriptionToBilling: vi.fn() }));
vi.mock("@/lib/email/billing-email", () => ({
	sendCreditPackReceiptEmail: vi.fn(),
	sendPaymentFailedEmail: vi.fn(),
	sendReceiptEmail: vi.fn(),
	sendSubscriptionCanceledEmail: vi.fn(),
	sendTrialEndingEmail: vi.fn(),
}));
vi.mock("@/lib/billing/payment-holds/store", () => ({
	nudgeHold: vi.fn(),
	writeHoldState: vi.fn(),
	releaseHold: vi.fn(),
	reserveRefundAttempt: vi.fn(),
	openHold: vi.fn(),
}));
vi.mock("@/lib/billing/payment-holds/machine", () => ({ advanceHold: vi.fn() }));
vi.mock("@/lib/billing/payment-holds/sweeper", () => ({
	wakePaymentHoldSweeper: vi.fn(),
	runPaymentHoldSweep: vi.fn(),
}));
const afterMock = vi.hoisted(() => {
	const callbacks: Array<() => unknown> = [];
	return { callbacks };
});
vi.mock("next/server", () => ({
	after: vi.fn((cb: () => unknown) => {
		afterMock.callbacks.push(cb);
	}),
}));
vi.mock("@/lib/billing/config", () => ({
	isStripeConfigured: () => true,
	getStripeConfig: () => ({ webhookSecret: "whsec_test" }),
}));
vi.mock("@/lib/billing/webhook-events", () => ({
	claimWebhookEvent: vi.fn(async () => ({ claimed: true })),
	markWebhookEventError: vi.fn(),
	runWebhookEventExactlyOnce: vi.fn(
		async (_id: string, _type: string, handler: () => Promise<void>) => {
			await handler();
			return "handled";
		},
	),
}));
vi.mock("@/lib/billing/webhook-handler", async (importOriginal) => {
	const real = await importOriginal<typeof import("@/lib/billing/webhook-handler")>();
	return { ...real, handleStripeEvent: vi.fn(real.handleStripeEvent) };
});

import { after } from "next/server";
import { POST } from "@/app/api/webhooks/stripe/route";
import { captureServer } from "@/lib/analytics/server";
import { advanceHold } from "@/lib/billing/payment-holds/machine";
import {
	nudgeHold,
	releaseHold,
	reserveRefundAttempt,
	writeHoldState,
} from "@/lib/billing/payment-holds/store";
import { wakePaymentHoldSweeper } from "@/lib/billing/payment-holds/sweeper";
import { setInvoiceStatus } from "@/lib/billing/invoices";
import { attemptBackupPayment } from "@/lib/billing/payment-methods";
import { syncSubscriptionToBilling } from "@/lib/billing/sync";
import { claimWebhookEvent } from "@/lib/billing/webhook-events";
import {
	handleStripeEvent,
	liveWebhookHolds,
	type WebhookHoldPort,
} from "@/lib/billing/webhook-handler";
import {
	sendPaymentFailedEmail,
	sendReceiptEmail,
	sendSubscriptionCanceledEmail,
} from "@/lib/email/billing-email";

const CREATED = 1_790_856_000;
const HOLD_ID = "0b6f7c4e-3a6d-4d0a-9c0e-1f2a3b4c5d6e";
const OTHER_HOLD_ID = "9d1e2f3a-4b5c-4d6e-8f70-819203a4b5c6";

/** One row of the in-memory hold table. */
interface FakeHold {
	id: string;
	subscription_id: string;
	customer_id: string;
	invoice_id: string;
	payment_intent_id: string | null;
	state: "closing" | "refund_due" | "released";
	version: number;
	nudged_at: Date | null;
}

/** An in-memory hold table behind the dispatcher's port; only `nudged_at` is ever written. */
function holdTable(rows: FakeHold[]): WebhookHoldPort & { rows: FakeHold[] } {
	const nudgeSub = (subscriptionId: string): number => {
		let n = 0;
		for (const r of rows) {
			if (r.subscription_id === subscriptionId && r.state !== "released") {
				r.nudged_at = new Date();
				n += 1;
			}
		}
		return n;
	};
	return {
		rows,
		heldInvoice: vi.fn(async (sub: string, inv: string, cus: string) => {
			const named = rows.filter((r) => r.subscription_id === sub && r.invoice_id === inv && r.customer_id === cus);
			if (named.length === 0) return null;
			return named.some((r) => r.state !== "released") ? "open" : "released";
		}),
		holdNamesSubscription: vi.fn(async (id: string, sub: string) =>
			rows.some((r) => r.id === id && r.subscription_id === sub),
		),
		nudgeSubscription: vi.fn(async (sub: string, cus: string) =>
			rows.some((r) => r.subscription_id === sub && r.customer_id === cus && r.state !== "released")
				? nudgeSub(sub)
				: 0,
		),
		nudgeRefund: vi.fn(async (holdId: string | null, pi: string | null) => {
			const subs = new Set(
				rows
					.filter(
						(r) =>
							r.state !== "released" &&
							((holdId !== null && r.id === holdId) ||
								(pi !== null && r.payment_intent_id === pi)),
					)
					.map((r) => r.subscription_id),
			);
			let n = 0;
			for (const s of subs) n += nudgeSub(s);
			return n;
		}),
	};
}

/** A hold on `sub_x` / `cus_1` holding `in_1`, open (`closing`) unless overridden. */
function hold(over: Partial<FakeHold> = {}): FakeHold {
	return {
		id: HOLD_ID,
		subscription_id: "sub_x",
		customer_id: "cus_1",
		invoice_id: "in_1",
		payment_intent_id: null,
		state: "closing",
		version: 3,
		nudged_at: null,
		...over,
	};
}

/** A subscription as Stripe returns it: create-a-team (created_by, no organization_id) unless overridden. */
function sub(status: string, metadata: Record<string, string> = { created_by: "user_u" }, extra: object = {}) {
	return { id: "sub_x", object: "subscription", status, customer: "cus_1", metadata, items: { data: [] }, ...extra };
}

/** True when a fixture carries the fields the dispatcher reads off an event. */
function isEventFixture(x: unknown): x is Stripe.Event {
	return typeof x === "object" && x !== null && "type" in x && "created" in x && "data" in x;
}

/** An event of `type` around `object`. */
function eventOf(type: string, object: object): Stripe.Event {
	const fixture: unknown = { id: "evt_1", object: "event", type, created: CREATED, data: { object } };
	if (!isEventFixture(fixture)) throw new Error("event fixture is malformed");
	return fixture;
}

/** An invoice of `sub_x` with a failed or paid first payment. */
function invoice(over: object = {}) {
	return {
		id: "in_1",
		object: "invoice",
		customer: "cus_1",
		amount_paid: 2900,
		amount_due: 2900,
		currency: "usd",
		billing_reason: "subscription_create",
		default_payment_method: "pm_failed",
		metadata: {},
		parent: { subscription_details: { subscription: "sub_x" } },
		...over,
	};
}

/** Asserts the dispatcher made no Stripe write and no hold state write (it only hinted). */
function expectNoActionOnHolds(table: { rows: FakeHold[] }, versions: number[]): void {
	expect(stripeMock.pay).not.toHaveBeenCalled();
	expect(stripeMock.voidInvoice).not.toHaveBeenCalled();
	expect(stripeMock.cancel).not.toHaveBeenCalled();
	expect(stripeMock.refundsCreate).not.toHaveBeenCalled();
	expect(advanceHold).not.toHaveBeenCalled();
	expect(writeHoldState).not.toHaveBeenCalled();
	expect(releaseHold).not.toHaveBeenCalled();
	expect(reserveRefundAttempt).not.toHaveBeenCalled();
	expect(table.rows.map((r) => r.version)).toEqual(versions);
}

beforeEach(() => {
	vi.clearAllMocks();
	afterMock.callbacks.length = 0;
	vi.mocked(syncSubscriptionToBilling).mockResolvedValue("applied");
	vi.mocked(attemptBackupPayment).mockResolvedValue(null);
});

describe("invoice.payment_failed — no backup-card retry on a held or ended create-a-team invoice (C41, C83)", () => {
	it("C41: an ended create-a-team subscription with an open held invoice and a backup card is never paid; the hold is nudged", async () => {
		stripeMock.retrieve.mockResolvedValue(sub("canceled"));
		const table = holdTable([hold()]);
		const res = await handleStripeEvent(eventOf("invoice.payment_failed", invoice()), { holds: table });
		expect(attemptBackupPayment).not.toHaveBeenCalled();
		expect(res.nudged).toBe(1);
		expect(table.rows[0]?.nudged_at).not.toBeNull();
		expectNoActionOnHolds(table, [3]);
		// The state still syncs on the first delivery, whatever the hold (C66).
		expect(syncSubscriptionToBilling).toHaveBeenCalledTimes(1);
	});

	it("a held invoice on an `incomplete` subscription is not retried either", async () => {
		stripeMock.retrieve.mockResolvedValue(sub("incomplete"));
		const table = holdTable([hold()]);
		await handleStripeEvent(eventOf("invoice.payment_failed", invoice()), { holds: table });
		expect(attemptBackupPayment).not.toHaveBeenCalled();
	});

	it("a RELEASED hold that names the invoice still blocks the retry", async () => {
		stripeMock.retrieve.mockResolvedValue(sub("incomplete"));
		const table = holdTable([hold({ state: "released" })]);
		const res = await handleStripeEvent(eventOf("invoice.payment_failed", invoice()), { holds: table });
		expect(attemptBackupPayment).not.toHaveBeenCalled();
		expect(res.nudged).toBe(0);
	});

	it.each(["canceled", "incomplete_expired", "incomplete"])(
		"an un-live (%s) create-a-team subscription with NO hold is not retried",
		async (status) => {
			stripeMock.retrieve.mockResolvedValue(sub(status));
			await handleStripeEvent(eventOf("invoice.payment_failed", invoice()), { holds: holdTable([]) });
			expect(attemptBackupPayment).not.toHaveBeenCalled();
		},
	);

	it("out of order: `invoice.voided` then a late `invoice.payment_failed` for the same held invoice — mirrored void, no retry, nudged", async () => {
		const table = holdTable([hold()]);
		await handleStripeEvent(eventOf("invoice.voided", invoice({ status: "void" })), { holds: table });
		expect(setInvoiceStatus).toHaveBeenCalledWith("in_1", "void");
		stripeMock.retrieve.mockResolvedValue(sub("canceled"));
		const res = await handleStripeEvent(eventOf("invoice.payment_failed", invoice()), { holds: table });
		expect(attemptBackupPayment).not.toHaveBeenCalled();
		expect(res.nudged).toBe(1);
		expectNoActionOnHolds(table, [3]);
	});

	it("a create-a-team FIRST payment that failed in the sheet (`incomplete`, no hold yet) gets no backup-card retry, and its payment-failed email is unchanged", async () => {
		stripeMock.retrieve.mockResolvedValue(sub("incomplete"));
		const res = await handleStripeEvent(eventOf("invoice.payment_failed", invoice()), { holds: holdTable([]) });
		expect(attemptBackupPayment).not.toHaveBeenCalled();
		expect(sendPaymentFailedEmail).toHaveBeenCalledTimes(1);
		expect(res.nudged).toBe(0);
	});

	it("an invoice an OPEN hold names gets no \"payment failed — update your card\" email (maintainer ruling)", async () => {
		stripeMock.retrieve.mockResolvedValue(sub("incomplete"));
		await handleStripeEvent(eventOf("invoice.payment_failed", invoice()), { holds: holdTable([hold()]) });
		expect(sendPaymentFailedEmail).not.toHaveBeenCalled();
	});

	it("an invoice only a RELEASED hold names keeps its payment-failed email", async () => {
		stripeMock.retrieve.mockResolvedValue(sub("incomplete"));
		await handleStripeEvent(eventOf("invoice.payment_failed", invoice()), {
			holds: holdTable([hold({ state: "released" })]),
		});
		expect(sendPaymentFailedEmail).toHaveBeenCalledTimes(1);
	});

	it("an invoice NO hold names keeps its payment-failed email exactly as today", async () => {
		stripeMock.retrieve.mockResolvedValue(sub("past_due", { organization_id: "org_1" }));
		await handleStripeEvent(eventOf("invoice.payment_failed", invoice()), { holds: holdTable([hold({ invoice_id: "in_other" })]) });
		expect(sendPaymentFailedEmail).toHaveBeenCalledTimes(1);
		expect(sendPaymentFailedEmail).toHaveBeenCalledWith(expect.objectContaining({ id: "sub_x" }), expect.objectContaining({ id: "in_1" }));
	});

	it("C83: an org-plan FIRST invoice (organization_id set, no hold) keeps its backup-card retry", async () => {
		stripeMock.retrieve.mockResolvedValue(sub("incomplete", { organization_id: "org_1", created_by: "user_u" }));
		await handleStripeEvent(eventOf("invoice.payment_failed", invoice()), { holds: holdTable([]) });
		expect(attemptBackupPayment).toHaveBeenCalledWith("cus_1", "in_1", "pm_failed");
	});

	it("a live create-a-team subscription's dunning invoice keeps its retry", async () => {
		stripeMock.retrieve.mockResolvedValue(sub("past_due"));
		await handleStripeEvent(
			eventOf("invoice.payment_failed", invoice({ id: "in_2", billing_reason: "subscription_cycle" })),
			{ holds: holdTable([hold()]) },
		);
		expect(attemptBackupPayment).toHaveBeenCalledWith("cus_1", "in_2", "pm_failed");
	});

	it("a hold read that throws fails the event BEFORE any charge (Stripe redelivers)", async () => {
		stripeMock.retrieve.mockResolvedValue(sub("past_due", { organization_id: "org_1" }));
		const table = holdTable([]);
		vi.mocked(table.heldInvoice).mockRejectedValueOnce(new Error("db down"));
		await expect(
			handleStripeEvent(eventOf("invoice.payment_failed", invoice()), { holds: table }),
		).rejects.toThrow("db down");
		expect(attemptBackupPayment).not.toHaveBeenCalled();
		expect(sendPaymentFailedEmail).not.toHaveBeenCalled();
	});
});

describe("invoice.payment_succeeded — the receipt rule covers held invoices (C9, C64, C83)", () => {
	it("C9: a held invoice paid on an ENDED subscription sends no receipt, no revenue event, no Stripe write, and nudges", async () => {
		stripeMock.retrieve.mockResolvedValue(sub("canceled"));
		const table = holdTable([hold()]);
		const res = await handleStripeEvent(eventOf("invoice.payment_succeeded", invoice()), { holds: table });
		expect(sendReceiptEmail).not.toHaveBeenCalled();
		expect(captureServer).not.toHaveBeenCalled();
		expect(res.nudged).toBe(1);
		expectNoActionOnHolds(table, [3]);
	});

	it("C64: the fresh read `incomplete` with an open closing hold sends ONE receipt", async () => {
		stripeMock.retrieve.mockResolvedValue(sub("incomplete"));
		await handleStripeEvent(eventOf("invoice.payment_succeeded", invoice()), { holds: holdTable([hold()]) });
		expect(sendReceiptEmail).toHaveBeenCalledTimes(1);
	});

	it("C64: the same with no hold sends one receipt", async () => {
		stripeMock.retrieve.mockResolvedValue(sub("incomplete"));
		await handleStripeEvent(eventOf("invoice.payment_succeeded", invoice()), { holds: holdTable([]) });
		expect(sendReceiptEmail).toHaveBeenCalledTimes(1);
	});

	it("C83: an org-plan renewal whose subscription reads `canceled` on redelivery still gets its receipt", async () => {
		stripeMock.retrieve.mockResolvedValue(sub("canceled", { organization_id: "org_1" }));
		await handleStripeEvent(
			eventOf("invoice.payment_succeeded", invoice({ billing_reason: "subscription_cycle" })),
			{ holds: holdTable([]) },
		);
		expect(sendReceiptEmail).toHaveBeenCalledTimes(1);
	});

	it("a hold on ANOTHER subscription naming the same invoice id never suppresses this receipt", async () => {
		stripeMock.retrieve.mockResolvedValue(sub("canceled"));
		const table = holdTable([hold({ subscription_id: "sub_other", customer_id: "cus_2" })]);
		const res = await handleStripeEvent(eventOf("invoice.payment_succeeded", invoice()), { holds: table });
		expect(sendReceiptEmail).toHaveBeenCalledTimes(1);
		expect(res.nudged).toBe(0);
		expect(table.rows[0]?.nudged_at).toBeNull();
	});
});

describe("customer.subscription.deleted — a stamped deletion is silent (C63, C67)", () => {
	it("C63: a linked X stamped `alethia:checkout_closed:<its hold>` writes the row but sends no email and no revenue event", async () => {
		const x = sub("canceled", { organization_id: "org_1", created_by: "user_u" }, {
			cancellation_details: { comment: `alethia:checkout_closed:${HOLD_ID}` },
		});
		const table = holdTable([hold({ state: "released" })]);
		await handleStripeEvent(eventOf("customer.subscription.deleted", x), { holds: table });
		expect(syncSubscriptionToBilling).toHaveBeenCalledWith(x, { eventAt: new Date(CREATED * 1000) });
		expect(sendSubscriptionCanceledEmail).not.toHaveBeenCalled();
		expect(captureServer).not.toHaveBeenCalled();
	});

	it("C63: the same deletion UNSTAMPED sends the email and the revenue event", async () => {
		const x = sub("canceled", { organization_id: "org_1", created_by: "user_u" });
		await handleStripeEvent(eventOf("customer.subscription.deleted", x), { holds: holdTable([hold()]) });
		expect(sendSubscriptionCanceledEmail).toHaveBeenCalledTimes(1);
		expect(captureServer).toHaveBeenCalledWith("user_u", "subscription_canceled", "org_1", undefined);
	});

	it("a hold stamp naming ANOTHER subscription's hold (e.g. typed into a cancel form) does not silence it", async () => {
		const x = sub("canceled", { organization_id: "org_1" }, {
			cancellation_details: { comment: `alethia:checkout_closed:${OTHER_HOLD_ID}` },
		});
		const table = holdTable([hold(), hold({ id: OTHER_HOLD_ID, subscription_id: "sub_other", customer_id: "cus_2" })]);
		await handleStripeEvent(eventOf("customer.subscription.deleted", x), { holds: table });
		expect(sendSubscriptionCanceledEmail).toHaveBeenCalledTimes(1);
	});

	it("C67: `created(Z, incomplete)` then a `deleted(Z)` stamped `alethia:closeout` with no organization_id write no row and send no email", async () => {
		vi.mocked(syncSubscriptionToBilling).mockResolvedValue("ignored");
		const z = sub("incomplete", { created_by: "user_u" });
		stripeMock.retrieve.mockResolvedValue(z);
		await handleStripeEvent(eventOf("customer.subscription.created", z), { holds: holdTable([]) });
		const deleted = { ...z, status: "canceled", cancellation_details: { comment: "alethia:closeout" } };
		await handleStripeEvent(eventOf("customer.subscription.deleted", deleted), { holds: holdTable([]) });
		expect(sendSubscriptionCanceledEmail).not.toHaveBeenCalled();
		expect(captureServer).not.toHaveBeenCalled();
	});

	it("a deletion APPLIED to the row and stamped `alethia:closeout` sends no email either", async () => {
		const z = sub("canceled", { organization_id: "org_1" }, { cancellation_details: { comment: "alethia:closeout" } });
		await handleStripeEvent(eventOf("customer.subscription.deleted", z), { holds: holdTable([]) });
		expect(syncSubscriptionToBilling).toHaveBeenCalledTimes(1);
		expect(sendSubscriptionCanceledEmail).not.toHaveBeenCalled();
	});
});

describe("events nudge open holds with a hint write (C53, C66)", () => {
	it("C53: customer.subscription.updated for a held subscription: no Stripe write, nudged_at set, version unchanged", async () => {
		stripeMock.retrieve.mockResolvedValue(sub("incomplete"));
		const table = holdTable([hold()]);
		const res = await handleStripeEvent(eventOf("customer.subscription.updated", sub("incomplete")), { holds: table });
		expect(res.nudged).toBe(1);
		expect(table.rows[0]?.nudged_at).not.toBeNull();
		expectNoActionOnHolds(table, [3]);
	});

	it("customer.subscription.deleted nudges even when the row refused the deletion", async () => {
		vi.mocked(syncSubscriptionToBilling).mockResolvedValue("ignored");
		const table = holdTable([hold()]);
		const res = await handleStripeEvent(eventOf("customer.subscription.deleted", sub("canceled")), { holds: table });
		expect(res.nudged).toBe(1);
	});

	it("the nudge is keyed on the event's own subscription AND customer", async () => {
		stripeMock.retrieve.mockResolvedValue(sub("incomplete"));
		const table = holdTable([hold({ customer_id: "cus_2" })]);
		const res = await handleStripeEvent(eventOf("customer.subscription.updated", sub("incomplete")), { holds: table });
		expect(table.nudgeSubscription).toHaveBeenCalledWith("sub_x", "cus_1");
		expect(res.nudged).toBe(0);
		expect(table.rows[0]?.nudged_at).toBeNull();
	});

	it("charge.refund.updated nudges the open hold its metadata names", async () => {
		const table = holdTable([hold({ state: "refund_due" })]);
		const refund = { id: "re_1", object: "refund", payment_intent: "pi_1", metadata: { alethia_payment_hold: HOLD_ID } };
		const res = await handleStripeEvent(eventOf("charge.refund.updated", refund), { holds: table });
		expect(table.nudgeRefund).toHaveBeenCalledWith(HOLD_ID, "pi_1");
		expect(res.nudged).toBe(1);
		expectNoActionOnHolds(table, [3]);
	});

	it("charge.refund.updated for a refund no hold made nudges nothing", async () => {
		const table = holdTable([hold()]);
		const refund = { id: "re_2", object: "refund", payment_intent: "pi_9", metadata: {} };
		const res = await handleStripeEvent(eventOf("charge.refund.updated", refund), { holds: table });
		expect(res.nudged).toBe(0);
	});

	it("a nudge that throws never fails the event, and the receipt still goes", async () => {
		stripeMock.retrieve.mockResolvedValue(sub("incomplete"));
		const table = holdTable([hold()]);
		vi.mocked(table.nudgeSubscription).mockRejectedValueOnce(new Error("db blip"));
		const res = await handleStripeEvent(eventOf("invoice.payment_succeeded", invoice()), { holds: table });
		expect(res.nudged).toBe(0);
		expect(sendReceiptEmail).toHaveBeenCalledTimes(1);
	});

	it("the live port never sends a malformed hold id to Postgres", async () => {
		await expect(liveWebhookHolds.holdNamesSubscription("not-a-uuid", "sub_x")).resolves.toBe(false);
		await expect(liveWebhookHolds.nudgeRefund("not-a-uuid", null)).resolves.toBe(0);
		expect(nudgeHold).not.toHaveBeenCalled();
	});
});

/** A webhook delivery request with a signature header. */
function delivery(signature: string | null = "t=1,v1=sig"): Request {
	const headers = new Headers();
	if (signature) headers.set("stripe-signature", signature);
	return new Request("https://console.test/api/webhooks/stripe", { method: "POST", body: "{}", headers });
}

describe("the route: signature first, sweeper woken only after the 2xx", () => {
	it("a bad signature is refused before anything runs", async () => {
		stripeMock.constructEventAsync.mockRejectedValueOnce(new Error("No signatures found"));
		const res = await POST(delivery());
		expect(res.status).toBe(400);
		expect(claimWebhookEvent).not.toHaveBeenCalled();
		expect(handleStripeEvent).not.toHaveBeenCalled();
		expect(after).not.toHaveBeenCalled();
	});

	it("a nudging event answers 2xx first and wakes the sweeper only in `after`", async () => {
		stripeMock.constructEventAsync.mockResolvedValueOnce(eventOf("invoice.payment_failed", invoice()));
		vi.mocked(handleStripeEvent).mockResolvedValueOnce({ nudged: 1 });
		const res = await POST(delivery());
		expect(res.status).toBe(200);
		// Nothing woke the sweeper while the request was being answered.
		expect(wakePaymentHoldSweeper).not.toHaveBeenCalled();
		expect(afterMock.callbacks).toHaveLength(1);
		for (const cb of afterMock.callbacks) await cb();
		expect(wakePaymentHoldSweeper).toHaveBeenCalledTimes(1);
	});

	it("an event that nudged nothing schedules no wake", async () => {
		stripeMock.constructEventAsync.mockResolvedValueOnce(eventOf("invoice.voided", invoice()));
		vi.mocked(handleStripeEvent).mockResolvedValueOnce({ nudged: 0 });
		const res = await POST(delivery());
		expect(res.status).toBe(200);
		expect(after).not.toHaveBeenCalled();
	});

	it("a handler error answers 500 and wakes nothing", async () => {
		stripeMock.constructEventAsync.mockResolvedValueOnce(eventOf("invoice.payment_failed", invoice()));
		vi.mocked(handleStripeEvent).mockRejectedValueOnce(new Error("boom"));
		const res = await POST(delivery());
		expect(res.status).toBe(500);
		expect(after).not.toHaveBeenCalled();
		expect(wakePaymentHoldSweeper).not.toHaveBeenCalled();
	});
});
