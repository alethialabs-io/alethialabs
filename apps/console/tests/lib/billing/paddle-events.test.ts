// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Paddle notification → provider-neutral event (lib/billing/paddle/events.ts). One case per event
// type we act on, plus the edges: an unknown type is ignored without its data being parsed, an
// unconfigured price is ignored, malformed data we read throws PaddlePayloadError, and custom_data
// that is not our shape is dropped rather than trusted or thrown on.

import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
	catalogItemForPrice,
	normalizePaddleEvent,
	PaddlePayloadError,
	paddleStatusToBillingStatus,
	parseCustomData,
	parsePaddleEnvelope,
	TRANSACTION_READ_EVENT_TYPE,
	transactionReadEvent,
} from "@/lib/billing/paddle/events";
import {
	adjustmentData,
	CATALOG,
	envelope,
	PRICE_AI_MAX,
	PRICE_AI_PLUS,
	PRICE_ENTERPRISE,
	PRICE_TEAM,
	subscriptionData,
	transactionData,
} from "../../fixtures/paddle-events";

/** Normalizes a fixture envelope through the real JSON path. */
function normalize(env: Record<string, unknown>) {
	return normalizePaddleEvent(parsePaddleEnvelope(JSON.stringify(env)), CATALOG);
}

const ORG = randomUUID();
const USER = randomUUID();

describe("parsePaddleEnvelope", () => {
	it("parses event id, type and occurred_at (microsecond precision)", () => {
		const env = parsePaddleEnvelope(JSON.stringify(envelope("subscription.created", subscriptionData())));
		expect(env.event_id).toBe("evt_01test");
		expect(env.occurred_at.toISOString()).toBe("2026-11-25T10:00:00.123Z");
	});

	it("throws PaddlePayloadError on a non-JSON body or a missing envelope field", () => {
		expect(() => parsePaddleEnvelope("not json")).toThrow(PaddlePayloadError);
		expect(() => parsePaddleEnvelope(JSON.stringify({ event_type: "x" }))).toThrow(PaddlePayloadError);
		expect(() =>
			parsePaddleEnvelope(JSON.stringify(envelope("subscription.created", {}, { occurred_at: "yesterday" }))),
		).toThrow(PaddlePayloadError);
	});
});

describe("catalog and status mapping", () => {
	it("maps each configured price to its slot", () => {
		expect(catalogItemForPrice(PRICE_TEAM, CATALOG)).toEqual({ slot: "plan", plan: "team" });
		expect(catalogItemForPrice(PRICE_ENTERPRISE, CATALOG)).toEqual({ slot: "plan", plan: "enterprise" });
		expect(catalogItemForPrice(PRICE_AI_PLUS, CATALOG)).toEqual({ slot: "ai", tier: "ai_plus" });
		expect(catalogItemForPrice(PRICE_AI_MAX, CATALOG)).toEqual({ slot: "ai", tier: "ai_max" });
		expect(catalogItemForPrice("pri_other", CATALOG)).toBeNull();
		expect(catalogItemForPrice(PRICE_AI_MAX, { prices: { team: PRICE_TEAM } })).toBeNull();
	});

	it("stores paused as none and passes the rest through", () => {
		expect(paddleStatusToBillingStatus("active")).toBe("active");
		expect(paddleStatusToBillingStatus("trialing")).toBe("trialing");
		expect(paddleStatusToBillingStatus("past_due")).toBe("past_due");
		expect(paddleStatusToBillingStatus("canceled")).toBe("canceled");
		expect(paddleStatusToBillingStatus("paused")).toBe("none");
	});
});

describe("parseCustomData", () => {
	it("accepts our shape and drops anything else", () => {
		expect(parseCustomData({ organizationId: ORG, kind: "plan", plan: "team" })).toEqual({
			organizationId: ORG,
			kind: "plan",
			plan: "team",
		});
		expect(parseCustomData(null)).toBeNull();
		expect(parseCustomData({ organizationId: "not-a-uuid", kind: "plan" })).toBeNull();
		expect(parseCustomData({ organizationId: ORG, kind: "free_money" })).toBeNull();
		expect(parseCustomData({ organizationId: ORG, kind: "credit_pack", credits: -5 })).toBeNull();
	});
});

describe("subscription events", () => {
	const types = [
		"subscription.created",
		"subscription.updated",
		"subscription.activated",
		"subscription.trialing",
		"subscription.past_due",
		"subscription.paused",
		"subscription.resumed",
	];

	it.each(types)("%s normalizes to subscription_upserted", (type) => {
		const ev = normalize(envelope(type, subscriptionData({ custom_data: { organizationId: ORG, kind: "plan" } })));
		expect(ev).toMatchObject({
			provider: "paddle",
			kind: "subscription_upserted",
			eventType: type,
			slot: "plan",
			plan: "team",
			aiTier: null,
			subscriptionId: "sub_01test",
			customerId: "ctm_01test",
			businessId: "biz_01test",
			addressId: "add_01test",
			organizationId: ORG,
			status: "active",
			seats: 3,
			cancelEffectiveAt: null,
		});
		if (ev.kind !== "subscription_upserted") throw new Error("kind");
		expect(ev.currentPeriodStart?.toISOString()).toBe("2026-11-25T00:00:00.000Z");
		expect(ev.currentPeriodEnd?.toISOString()).toBe("2026-12-25T00:00:00.000Z");
	});

	it("carries a scheduled cancellation's effective date, and not a scheduled pause's", () => {
		const cancel = normalize(
			envelope(
				"subscription.updated",
				subscriptionData({ scheduled_change: { action: "cancel", effective_at: "2026-12-25T00:00:00Z", resume_at: null } }),
			),
		);
		expect(cancel.kind === "subscription_upserted" && cancel.cancelEffectiveAt?.toISOString()).toBe(
			"2026-12-25T00:00:00.000Z",
		);
		const pause = normalize(
			envelope(
				"subscription.updated",
				subscriptionData({ scheduled_change: { action: "pause", effective_at: "2026-12-25T00:00:00Z" } }),
			),
		);
		expect(pause.kind === "subscription_upserted" && pause.cancelEffectiveAt).toBeNull();
	});

	it("routes an AI price to the ai slot", () => {
		const ev = normalize(
			envelope("subscription.created", subscriptionData({ items: [{ quantity: 1, price: { id: PRICE_AI_PLUS } }] })),
		);
		expect(ev).toMatchObject({ kind: "subscription_upserted", slot: "ai", aiTier: "ai_plus", plan: null, seats: null });
	});

	it("subscription.canceled (and any canceled status) normalizes to subscription_canceled", () => {
		expect(normalize(envelope("subscription.canceled", subscriptionData({ status: "canceled" })))).toMatchObject({
			kind: "subscription_canceled",
			slot: "plan",
			subscriptionId: "sub_01test",
		});
		expect(normalize(envelope("subscription.updated", subscriptionData({ status: "canceled" })))).toMatchObject({
			kind: "subscription_canceled",
		});
	});

	it("ignores a subscription on a price we did not configure", () => {
		const ev = normalize(
			envelope("subscription.created", subscriptionData({ items: [{ quantity: 1, price: { id: "pri_stranger" } }] })),
		);
		expect(ev.kind).toBe("ignored");
	});

	it("drops custom_data that is not ours instead of trusting it", () => {
		const ev = normalize(
			envelope("subscription.created", subscriptionData({ custom_data: { organizationId: "x", kind: "plan" } })),
		);
		expect(ev.organizationId).toBeNull();
	});

	it("throws PaddlePayloadError when a field we read is malformed", () => {
		expect(() => normalize(envelope("subscription.created", subscriptionData({ status: "frozen" })))).toThrow(
			PaddlePayloadError,
		);
		expect(() => normalize(envelope("subscription.created", subscriptionData({ id: "nope" })))).toThrow(
			PaddlePayloadError,
		);
	});
});

describe("transaction events", () => {
	it("transaction.completed carries totals, the mirror snapshot and the purchased plan", () => {
		const ev = normalize(
			envelope("transaction.completed", transactionData({ custom_data: { organizationId: ORG, kind: "plan" } })),
		);
		expect(ev).toMatchObject({
			kind: "transaction_completed",
			transactionId: "txn_01test",
			subscriptionId: "sub_01test",
			customerId: "ctm_01test",
			organizationId: ORG,
			item: { kind: "plan", plan: "team" },
			total: { minor: 7080, currency: "EUR" },
			tax: { minor: 1180, currency: "EUR" },
			transaction: {
				status: "completed",
				origin: "web",
				subtotal: { minor: 5900, currency: "EUR" },
				invoiceNumber: "325-10566",
				customData: { organizationId: ORG, kind: "plan" },
			},
		});
	});

	it("reads a credit pack from custom_data, an AI tier from its price, and nothing from an unknown price", () => {
		const pack = normalize(
			envelope(
				"transaction.completed",
				transactionData({
					subscription_id: null,
					items: [],
					custom_data: { organizationId: ORG, kind: "credit_pack", credits: 5000, userId: USER },
				}),
			),
		);
		expect(pack).toMatchObject({ item: { kind: "credit_pack", credits: 5000 } });
		const packNoCredits = normalize(
			envelope("transaction.completed", transactionData({ custom_data: { organizationId: ORG, kind: "credit_pack" } })),
		);
		expect(packNoCredits).toMatchObject({ item: null });
		const ai = normalize(envelope("transaction.completed", transactionData({ items: [{ price: { id: PRICE_AI_MAX } }] })));
		expect(ai).toMatchObject({ item: { kind: "ai_tier", tier: "ai_max" } });
		const none = normalize(envelope("transaction.completed", transactionData({ items: [{ price: null }] })));
		expect(none).toMatchObject({ item: null });
	});

	it("transaction.billed moves the mirror only, so an unpaid invoice is mirrored before it is paid (#7672)", () => {
		expect(
			normalize(envelope("transaction.billed", transactionData({ status: "billed", subscription_id: null }))),
		).toMatchObject({
			kind: "transaction_updated",
			transactionId: "txn_01test",
			transaction: { status: "billed", invoiceNumber: "325-10566" },
		});
	});

	it("subscription.created carries the transaction that created it; other types do not need one", () => {
		const created = normalize(envelope("subscription.created", subscriptionData({ transaction_id: "txn_01test" })));
		expect(created).toMatchObject({ kind: "subscription_upserted", transactionId: "txn_01test" });
		const updated = normalize(envelope("subscription.updated", subscriptionData()));
		expect(updated).toMatchObject({ kind: "subscription_upserted", transactionId: null });
	});

	it("transaction.payment_failed and transaction.paid / past_due keep the snapshot", () => {
		expect(normalize(envelope("transaction.payment_failed", transactionData({ status: "past_due" })))).toMatchObject({
			kind: "transaction_payment_failed",
			transaction: { status: "past_due" },
		});
		expect(normalize(envelope("transaction.paid", transactionData({ status: "paid" })))).toMatchObject({
			kind: "transaction_updated",
			transaction: { status: "paid" },
		});
		expect(normalize(envelope("transaction.past_due", transactionData({ status: "past_due" })))).toMatchObject({
			kind: "transaction_updated",
		});
	});

	it("throws PaddlePayloadError on a non-integer amount", () => {
		expect(() =>
			normalize(
				envelope("transaction.completed", transactionData({ details: { totals: { subtotal: "1.5", tax: "0", total: "1" } } })),
			),
		).toThrow(PaddlePayloadError);
	});
});

describe("transactionReadEvent (the mirror backfill)", () => {
	it("is a mirror-only event watermarked at the transaction's own updated_at", () => {
		const ev = transactionReadEvent(
			transactionData({
				status: "billed",
				updated_at: "2026-11-20T08:00:00.000Z",
				custom_data: { organizationId: ORG, kind: "plan" },
			}),
		);
		expect(ev).toMatchObject({
			kind: "transaction_updated",
			eventType: TRANSACTION_READ_EVENT_TYPE,
			eventId: "read:txn_01test:2026-11-20T08:00:00.000Z",
			organizationId: ORG,
			transactionId: "txn_01test",
			subscriptionId: "sub_01test",
			customerId: "ctm_01test",
			transaction: { status: "billed", customData: { organizationId: ORG, kind: "plan" } },
		});
		expect(ev.occurredAt.toISOString()).toBe("2026-11-20T08:00:00.000Z");
	});

	it("throws PaddlePayloadError without updated_at, since nothing else can order it against a webhook", () => {
		expect(() => transactionReadEvent(transactionData())).toThrow(PaddlePayloadError);
	});
});

describe("adjustment events", () => {
	it.each(["adjustment.created", "adjustment.updated"])("%s normalizes to adjustment", (type) => {
		expect(normalize(envelope(type, adjustmentData()))).toMatchObject({
			kind: "adjustment",
			adjustmentId: "adj_01test",
			transactionId: "txn_01test",
			action: "refund",
			status: "approved",
			total: { minor: 7080, currency: "EUR" },
			full: true,
		});
	});

	it("folds unknown actions to other and an absent type to null", () => {
		expect(normalize(envelope("adjustment.created", adjustmentData({ action: "chargeback_warning", type: null })))).toMatchObject(
			{ action: "other", full: null },
		);
		expect(normalize(envelope("adjustment.created", adjustmentData({ action: "chargeback", type: "partial" })))).toMatchObject({
			action: "chargeback",
			full: false,
		});
	});
});

describe("unhandled event types", () => {
	it("are ignored without their data being parsed", () => {
		const ev = normalize(envelope("customer.updated", { anything: true }));
		expect(ev).toMatchObject({ kind: "ignored", eventType: "customer.updated", organizationId: null });
	});
});
