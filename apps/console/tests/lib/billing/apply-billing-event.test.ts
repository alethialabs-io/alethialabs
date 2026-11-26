// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// applyBillingEvent (lib/billing/events/apply.ts) over an in-memory store: every rule in the module's
// header, one describe each — org resolution (custom_data is untrusted), the occurred_at watermark
// (out-of-order and duplicate deliveries), no revival of a canceled subscription, one subscription
// per slot, the live-Stripe refusal, the stored plan per status, the transaction mirror, credit
// packs, and adjustments. The Postgres store behind the same interface is proven against a real
// database in tests/integration/paddle-apply-event.test.ts.

import { randomUUID } from "node:crypto";
import { money } from "@repo/format";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	type ApplyDeps,
	applyBillingEvent,
	type BillingEventStore,
	type BillingRowPatch,
	type BillingRowState,
	decideSubscriptionCanceled,
	type ProviderRefs,
	lifecycleRank,
	RetryableBillingEventError,
	type TransactionMirrorState,
	type TransactionMirrorWrite,
} from "@/lib/billing/events/apply";
import type {
	AdjustmentEvent,
	SubscriptionCanceledEvent,
	SubscriptionUpsertedEvent,
	TransactionCompletedEvent,
	TransactionSnapshot,
} from "@/lib/billing/provider/types";
import type { PaddleTransactionCustomData } from "@/types/jsonb.types";

type Row = BillingRowState & BillingRowPatch;

/** An in-memory BillingEventStore with the same semantics as the Postgres one. */
class MemoryStore implements BillingEventStore {
	orgs = new Set<string>();
	rows = new Map<string, Row>();
	txns = new Map<string, TransactionMirrorWrite & { refundedAt?: Date | null; chargebackAt?: Date | null }>();
	grants = new Map<string, { orgId: string; userId: string; credits: number }>();
	/** `org|id` pairs our records hold: a stored Paddle customer, or a Paddle order's txn / sub id. */
	records = new Set<string>();

	/** Whether the org exists. */
	async orgExists(orgId: string) {
		return this.orgs.has(orgId);
	}
	/** The org naming the subscription. */
	async orgForSubscription(id: string) {
		for (const r of this.rows.values()) {
			if (r.paddleSubscriptionId === id || r.aiPaddleSubscriptionId === id) return r.organizationId;
		}
		return null;
	}
	/** The org holding the business id. */
	async businessOwner(id: string) {
		for (const r of this.rows.values()) if (r.paddleBusinessId === id) return r.organizationId;
		return null;
	}
	/** Whether a stored customer, an order or the mirror ties the org to one of the refs. */
	async orgHasRecordOf(orgId: string, refs: ProviderRefs) {
		for (const id of [refs.customerId, refs.transactionId, refs.subscriptionId]) {
			if (id && this.records.has(`${orgId}|${id}`)) return true;
		}
		for (const t of this.txns.values()) {
			if (t.organizationId !== orgId) continue;
			if (refs.transactionId && t.transactionId === refs.transactionId) return true;
			if (refs.subscriptionId && t.subscriptionId === refs.subscriptionId) return true;
		}
		return false;
	}
	/** Runs fn over the row with a merging write. */
	async withLockedRow<T>(orgId: string, fn: (row: BillingRowState | null, write: (p: BillingRowPatch) => Promise<void>) => Promise<T>) {
		const existing = this.rows.get(orgId) ?? null;
		return fn(existing, async (patch) => {
			const base: Row = existing ?? {
				organizationId: orgId,
				billingProvider: null,
				status: "none",
				aiSubscriptionStatus: "none",
				stripeSubscriptionId: null,
				aiStripeSubscriptionId: null,
				paddleSubscriptionId: null,
				paddleSubscriptionEventAt: null,
				aiPaddleSubscriptionId: null,
				aiPaddleSubscriptionEventAt: null,
			};
			this.rows.set(orgId, { ...base, ...patch });
		});
	}
	/** Upserts the mirror under its watermark. */
	async upsertTransaction(w: TransactionMirrorWrite) {
		const cur = this.txns.get(w.transactionId);
		if (cur && (cur.organizationId !== w.organizationId || cur.occurredAt > w.occurredAt)) return false;
		this.txns.set(w.transactionId, { ...cur, ...w });
		return true;
	}
	/** The mirrored transaction. */
	async getTransaction(id: string): Promise<TransactionMirrorState | null> {
		const t = this.txns.get(id);
		return t ? { organizationId: t.organizationId, totalMinor: t.snapshot.total.minor, customData: t.snapshot.customData } : null;
	}
	/** Stamps refund / chargeback. */
	async markTransaction(id: string, patch: { refundedAt?: Date | null; chargebackAt?: Date | null }) {
		const t = this.txns.get(id);
		if (t) this.txns.set(id, { ...t, ...patch });
	}
	/** Grants once per transaction. */
	async grantPackCredits(input: { orgId: string; userId: string; credits: number; transactionId: string }) {
		if (this.grants.has(input.transactionId)) return false;
		this.grants.set(input.transactionId, input);
		return true;
	}
	/** Zeroes a grant. */
	async reversePackCredits(id: string) {
		const g = this.grants.get(id);
		if (!g || g.credits === 0) return 0;
		this.grants.set(id, { ...g, credits: 0 });
		return g.credits;
	}
}

let store: MemoryStore;
let alert: ReturnType<typeof vi.fn<ApplyDeps["alert"]>>;
let warn: ReturnType<typeof vi.fn<ApplyDeps["warn"]>>;
let deps: ApplyDeps;
const ORG = randomUUID();
const OTHER_ORG = randomUUID();
const USER = randomUUID();

beforeEach(() => {
	store = new MemoryStore();
	store.orgs.add(ORG);
	store.orgs.add(OTHER_ORG);
	// Both orgs hold the fixtures' Paddle customer, so the rule tests below are about their own rule;
	// "a record of ours" has its own describe.
	store.records.add(`${ORG}|ctm_a`);
	store.records.add(`${OTHER_ORG}|ctm_a`);
	alert = vi.fn<ApplyDeps["alert"]>(async () => true);
	warn = vi.fn<ApplyDeps["warn"]>();
	deps = { store, alert, warn };
});

/** A time `s` seconds after a fixed origin. */
function at(s: number): Date {
	return new Date(Date.UTC(2026, 10, 25, 10, 0, s));
}

/** A plan-slot subscription upsert for ORG, overridden by `over`. */
function upsert(over: Partial<SubscriptionUpsertedEvent> = {}): SubscriptionUpsertedEvent {
	return {
		provider: "paddle",
		eventId: `evt_${randomUUID()}`,
		eventType: "subscription.updated",
		occurredAt: at(0),
		organizationId: ORG,
		kind: "subscription_upserted",
		slot: "plan",
		subscriptionId: "sub_a",
		customerId: "ctm_a",
		plan: "team",
		aiTier: null,
		status: "active",
		seats: 3,
		currentPeriodStart: at(0),
		currentPeriodEnd: at(30 * 86400),
		cancelEffectiveAt: null,
		businessId: "biz_a",
		addressId: "add_a",
		...over,
	};
}

/** A cancellation of `sub_a`. */
function canceled(over: Partial<SubscriptionCanceledEvent> = {}): SubscriptionCanceledEvent {
	return {
		provider: "paddle",
		eventId: `evt_${randomUUID()}`,
		eventType: "subscription.canceled",
		occurredAt: at(10),
		organizationId: null,
		kind: "subscription_canceled",
		slot: "plan",
		subscriptionId: "sub_a",
		...over,
	};
}

/** A transaction snapshot. */
function snapshot(customData: PaddleTransactionCustomData | null, totalMinor = 7080): TransactionSnapshot {
	return {
		status: "completed",
		origin: "web",
		subtotal: money(5900, "EUR"),
		tax: money(1180, "EUR"),
		total: money(totalMinor, "EUR"),
		invoiceNumber: "325-1",
		billedAt: at(0),
		billingPeriodStart: null,
		billingPeriodEnd: null,
		customData,
	};
}

/** A completed transaction for ORG. */
function completed(over: Partial<TransactionCompletedEvent> = {}, custom: PaddleTransactionCustomData | null = null): TransactionCompletedEvent {
	const customData = custom ?? { organizationId: ORG, kind: "plan" };
	return {
		provider: "paddle",
		eventId: `evt_${randomUUID()}`,
		eventType: "transaction.completed",
		occurredAt: at(0),
		organizationId: customData.organizationId,
		kind: "transaction_completed",
		transactionId: "txn_a",
		subscriptionId: null,
		customerId: "ctm_a",
		item: customData.kind === "credit_pack" ? { kind: "credit_pack", credits: customData.credits ?? 0 } : { kind: "plan", plan: "team" },
		total: money(7080, "EUR"),
		tax: money(1180, "EUR"),
		billingPeriodStart: null,
		billingPeriodEnd: null,
		transaction: snapshot(customData),
		...over,
	};
}

/** An adjustment on txn_a. */
function adjustment(over: Partial<AdjustmentEvent> = {}): AdjustmentEvent {
	return {
		provider: "paddle",
		eventId: `evt_${randomUUID()}`,
		eventType: "adjustment.updated",
		occurredAt: at(100),
		organizationId: null,
		kind: "adjustment",
		adjustmentId: "adj_a",
		transactionId: "txn_a",
		action: "refund",
		status: "approved",
		total: money(7080, "EUR"),
		full: true,
		...over,
	};
}

describe("org resolution", () => {
	it("creates the row for a first subscription naming an existing org", async () => {
		expect(await applyBillingEvent(upsert(), deps)).toEqual({ outcome: "applied" });
		expect(store.rows.get(ORG)).toMatchObject({
			billingProvider: "paddle",
			paddleSubscriptionId: "sub_a",
			paddleCustomerId: "ctm_a",
			paddleBusinessId: "biz_a",
			paddleAddressId: "add_a",
			plan: "team",
			status: "active",
			seats: 3,
			currentPeriodStart: at(0),
			currentPeriodEnd: at(30 * 86400),
			cancelEffectiveAt: null,
			paddleSubscriptionEventAt: at(0),
		});
	});

	it("refuses custom_data naming an org that does not exist, and alerts when it is live", async () => {
		const ghost = randomUUID();
		expect(await applyBillingEvent(upsert({ organizationId: ghost }), deps)).toEqual({
			outcome: "refused",
			reason: "unknown_org",
		});
		expect(store.rows.size).toBe(0);
		expect(alert).toHaveBeenCalledTimes(1);
	});

	it("refuses quietly when nothing names an org", async () => {
		expect(await applyBillingEvent(upsert({ organizationId: null }), deps)).toEqual({ outcome: "refused", reason: "no_org" });
		expect(alert).not.toHaveBeenCalled();
	});

	it("uses the row's org over custom_data, and refuses + alerts when custom_data names another", async () => {
		await applyBillingEvent(upsert(), deps);
		const before = structuredClone(store.rows.get(ORG));
		const r = await applyBillingEvent(upsert({ organizationId: OTHER_ORG, occurredAt: at(5), status: "canceled" }), deps);
		expect(r).toEqual({ outcome: "refused", reason: "mismatch" });
		expect(store.rows.get(ORG)).toEqual(before);
		expect(store.rows.has(OTHER_ORG)).toBe(false);
		expect(alert).toHaveBeenCalledTimes(1);
		// Later events without custom_data still find the org through the row.
		expect(await applyBillingEvent(upsert({ organizationId: null, occurredAt: at(6), seats: 5 }), deps)).toEqual({
			outcome: "applied",
		});
		expect(store.rows.get(ORG)?.seats).toBe(5);
	});
});

describe("the occurred_at watermark", () => {
	it("refuses an older event that arrives late", async () => {
		await applyBillingEvent(upsert({ occurredAt: at(20), status: "past_due" }), deps);
		const r = await applyBillingEvent(upsert({ occurredAt: at(10), status: "active" }), deps);
		expect(r.outcome).toBe("refused");
		expect(store.rows.get(ORG)?.status).toBe("past_due");
		expect(store.rows.get(ORG)?.paddleSubscriptionEventAt).toEqual(at(20));
	});

	it("re-applies a duplicate delivery to the same state (the ledger skips it before this)", async () => {
		const ev = upsert({ occurredAt: at(5) });
		await applyBillingEvent(ev, deps);
		const first = structuredClone(store.rows.get(ORG));
		await applyBillingEvent(ev, deps);
		expect(store.rows.get(ORG)).toEqual(first);
	});

	it("breaks a same-instant tie toward the later lifecycle stage", async () => {
		await applyBillingEvent(upsert({ occurredAt: at(5), status: "active" }), deps);
		expect((await applyBillingEvent(upsert({ occurredAt: at(5), status: "none" }), deps)).outcome).toBe("refused");
		expect(lifecycleRank("none")).toBeLessThan(lifecycleRank("past_due"));
		expect(lifecycleRank("past_due")).toBeLessThan(lifecycleRank("canceled"));
	});

	it("never moves the stored watermark backwards", () => {
		const row: BillingRowState = {
			organizationId: ORG,
			billingProvider: "paddle",
			status: "active",
			aiSubscriptionStatus: "none",
			stripeSubscriptionId: null,
			aiStripeSubscriptionId: null,
			paddleSubscriptionId: "sub_a",
			paddleSubscriptionEventAt: at(50),
			aiPaddleSubscriptionId: null,
			aiPaddleSubscriptionEventAt: null,
		};
		const d = decideSubscriptionCanceled(row, canceled({ occurredAt: at(50) }));
		expect(d.apply && d.patch.paddleSubscriptionEventAt).toEqual(at(50));
	});
});

describe("cancellation", () => {
	it("cancels the named subscription and drops the plan", async () => {
		await applyBillingEvent(upsert(), deps);
		expect(await applyBillingEvent(canceled(), deps)).toEqual({ outcome: "applied" });
		expect(store.rows.get(ORG)).toMatchObject({
			status: "canceled",
			plan: "community",
			currentPeriodEnd: null,
			cancelEffectiveAt: null,
			paddleSubscriptionId: "sub_a",
		});
	});

	it("is never revived by a stale live event", async () => {
		await applyBillingEvent(upsert(), deps);
		await applyBillingEvent(canceled({ occurredAt: at(10) }), deps);
		expect((await applyBillingEvent(upsert({ occurredAt: at(20) }), deps)).outcome).toBe("refused");
		expect(store.rows.get(ORG)?.status).toBe("canceled");
	});

	it("refuses a cancellation older than the newest event applied", async () => {
		await applyBillingEvent(upsert({ occurredAt: at(30) }), deps);
		expect((await applyBillingEvent(canceled({ occurredAt: at(10) }), deps)).outcome).toBe("refused");
		expect(store.rows.get(ORG)?.status).toBe("active");
	});

	it("ignores a cancellation no row names", async () => {
		expect(await applyBillingEvent(canceled(), deps)).toMatchObject({ outcome: "ignored" });
	});

	it("cancels an AI subscription back to ai_free", async () => {
		await applyBillingEvent(upsert({ slot: "ai", plan: null, aiTier: "ai_plus", subscriptionId: "sub_ai", seats: null }), deps);
		expect(store.rows.get(ORG)).toMatchObject({ aiTier: "ai_plus", aiSubscriptionStatus: "active" });
		await applyBillingEvent(canceled({ slot: "ai", subscriptionId: "sub_ai" }), deps);
		expect(store.rows.get(ORG)).toMatchObject({ aiTier: "ai_free", aiSubscriptionStatus: "canceled" });
	});
});

describe("the stored plan per status", () => {
	it("keeps the plan through past_due (the grace reads it) and drops it when paused", async () => {
		await applyBillingEvent(upsert({ occurredAt: at(1), status: "past_due" }), deps);
		expect(store.rows.get(ORG)).toMatchObject({ status: "past_due", plan: "team", currentPeriodEnd: at(30 * 86400) });
		await applyBillingEvent(upsert({ occurredAt: at(2), status: "none" }), deps);
		expect(store.rows.get(ORG)).toMatchObject({ status: "none", plan: "community", currentPeriodEnd: null });
		await applyBillingEvent(upsert({ occurredAt: at(3), status: "active" }), deps);
		expect(store.rows.get(ORG)).toMatchObject({ status: "active", plan: "team" });
	});

	it("keeps a scheduled cancellation active until its date, and clears it on resume", async () => {
		await applyBillingEvent(upsert({ occurredAt: at(1), cancelEffectiveAt: at(30 * 86400) }), deps);
		expect(store.rows.get(ORG)).toMatchObject({ status: "active", plan: "team", cancelEffectiveAt: at(30 * 86400) });
		await applyBillingEvent(upsert({ occurredAt: at(2), cancelEffectiveAt: null }), deps);
		expect(store.rows.get(ORG)?.cancelEffectiveAt).toBeNull();
	});

	it("keeps a paid AI tier only while paid (no grace on AI)", async () => {
		const ai = { slot: "ai" as const, plan: null, aiTier: "ai_max" as const, subscriptionId: "sub_ai", seats: null };
		await applyBillingEvent(upsert({ ...ai, occurredAt: at(1), status: "trialing" }), deps);
		expect(store.rows.get(ORG)?.aiTier).toBe("ai_max");
		await applyBillingEvent(upsert({ ...ai, occurredAt: at(2), status: "past_due" }), deps);
		expect(store.rows.get(ORG)).toMatchObject({ aiTier: "ai_free", aiSubscriptionStatus: "past_due" });
	});
});

describe("one subscription per slot", () => {
	it("refuses a second paid subscription beside a live one, and alerts", async () => {
		await applyBillingEvent(upsert(), deps);
		const r = await applyBillingEvent(upsert({ subscriptionId: "sub_b", occurredAt: at(5) }), deps);
		expect(r.outcome).toBe("refused");
		expect(store.rows.get(ORG)?.paddleSubscriptionId).toBe("sub_a");
		expect(alert).toHaveBeenCalledTimes(1);
	});

	it("refuses an unpaid second subscription quietly", async () => {
		await applyBillingEvent(upsert(), deps);
		await applyBillingEvent(upsert({ subscriptionId: "sub_b", status: "past_due", occurredAt: at(5) }), deps);
		expect(alert).not.toHaveBeenCalled();
	});

	it("lets a paid subscription replace a past_due one, and says so", async () => {
		await applyBillingEvent(upsert({ status: "past_due" }), deps);
		await applyBillingEvent(upsert({ subscriptionId: "sub_b", occurredAt: at(5) }), deps);
		expect(store.rows.get(ORG)).toMatchObject({ paddleSubscriptionId: "sub_b", status: "active" });
		expect(alert).toHaveBeenCalledTimes(1);
	});

	it("takes a slot whose subscription ended", async () => {
		await applyBillingEvent(upsert(), deps);
		await applyBillingEvent(canceled(), deps);
		await applyBillingEvent(upsert({ subscriptionId: "sub_b", occurredAt: at(20) }), deps);
		expect(store.rows.get(ORG)).toMatchObject({ paddleSubscriptionId: "sub_b", status: "active", plan: "team" });
		expect(alert).not.toHaveBeenCalled();
	});

	it("lets a paid subscription replace a live off-provider grant, and says so", async () => {
		store.rows.set(ORG, {
			organizationId: ORG,
			billingProvider: null,
			status: "active",
			aiSubscriptionStatus: "none",
			stripeSubscriptionId: null,
			aiStripeSubscriptionId: null,
			paddleSubscriptionId: null,
			paddleSubscriptionEventAt: null,
			aiPaddleSubscriptionId: null,
			aiPaddleSubscriptionEventAt: null,
			plan: "enterprise",
		});
		await applyBillingEvent(upsert(), deps);
		expect(store.rows.get(ORG)).toMatchObject({ billingProvider: "paddle", plan: "team", paddleSubscriptionId: "sub_a" });
		expect(alert).toHaveBeenCalledTimes(1);
	});

	it("never takes a business id another org's row holds", async () => {
		await applyBillingEvent(upsert({ organizationId: OTHER_ORG, subscriptionId: "sub_other" }), deps);
		await applyBillingEvent(upsert(), deps);
		expect(store.rows.get(OTHER_ORG)?.paddleBusinessId).toBe("biz_a");
		expect(store.rows.get(ORG)?.paddleBusinessId).toBeUndefined();
	});
});

describe("Stripe subscriptions on the row", () => {
	/** A row as today's Stripe writers leave it. */
	function stripeRow(status: "active" | "canceled", aiStatus: "none" | "active" = "none"): Row {
		return {
			organizationId: ORG,
			billingProvider: null,
			status,
			aiSubscriptionStatus: aiStatus,
			stripeSubscriptionId: "sub_stripe",
			aiStripeSubscriptionId: aiStatus === "active" ? "sub_stripe_ai" : null,
			paddleSubscriptionId: null,
			paddleSubscriptionEventAt: null,
			aiPaddleSubscriptionId: null,
			aiPaddleSubscriptionEventAt: null,
			plan: status === "active" ? "team" : "community",
		};
	}

	it("refuses to switch a row with a live Stripe plan subscription, and alerts", async () => {
		store.rows.set(ORG, stripeRow("active"));
		expect((await applyBillingEvent(upsert(), deps)).outcome).toBe("refused");
		expect(store.rows.get(ORG)?.billingProvider).toBeNull();
		expect(alert).toHaveBeenCalledTimes(1);
	});

	it("refuses beside a live Stripe AI subscription too", async () => {
		store.rows.set(ORG, stripeRow("canceled", "active"));
		expect((await applyBillingEvent(upsert(), deps)).outcome).toBe("refused");
	});

	it("clears dead Stripe ids so the row can say paddle", async () => {
		store.rows.set(ORG, stripeRow("canceled"));
		expect((await applyBillingEvent(upsert(), deps)).outcome).toBe("applied");
		expect(store.rows.get(ORG)).toMatchObject({
			billingProvider: "paddle",
			stripeSubscriptionId: null,
			paddleSubscriptionId: "sub_a",
			status: "active",
		});
	});

	it("leaves Stripe events to the Stripe handler", async () => {
		const r = await applyBillingEvent({ ...upsert(), provider: "stripe" }, deps);
		expect(r.outcome).toBe("refused");
		expect(store.rows.size).toBe(0);
	});
});

describe("transactions", () => {
	it("mirrors a completed transaction for the custom_data org", async () => {
		expect(await applyBillingEvent(completed(), deps)).toEqual({ outcome: "applied" });
		expect(store.txns.get("txn_a")).toMatchObject({ organizationId: ORG, snapshot: { status: "completed" } });
	});

	it("finds a renewal's org through its subscription", async () => {
		await applyBillingEvent(upsert(), deps);
		const r = await applyBillingEvent(
			completed({ subscriptionId: "sub_a", organizationId: null, transaction: snapshot(null) }),
			deps,
		);
		expect(r.outcome).toBe("applied");
		expect(store.txns.get("txn_a")?.organizationId).toBe(ORG);
	});

	it("refuses an older event over a newer mirror", async () => {
		await applyBillingEvent(completed({ occurredAt: at(10) }), deps);
		const r = await applyBillingEvent({ ...completed({ occurredAt: at(5) }), kind: "transaction_updated" }, deps);
		expect(r.outcome).toBe("refused");
	});

	it("alerts on a completed transaction for an unknown org, not on a mere update", async () => {
		const ghost = { organizationId: randomUUID(), kind: "plan" as const };
		await applyBillingEvent(completed({}, ghost), deps);
		expect(alert).toHaveBeenCalledTimes(1);
		await applyBillingEvent({ ...completed({}, ghost), kind: "transaction_updated" }, deps);
		expect(alert).toHaveBeenCalledTimes(1);
		expect(store.txns.size).toBe(0);
	});

	it("records a failed payment and warns", async () => {
		const ev = completed();
		await applyBillingEvent({ ...ev, kind: "transaction_payment_failed" }, deps);
		expect(store.txns.has("txn_a")).toBe(true);
		expect(warn).toHaveBeenCalledWith("[paddle] payment failed", expect.objectContaining({ transaction_id: "txn_a" }));
	});
});

describe("an org named only by custom_data needs a record of ours", () => {
	beforeEach(() => store.records.clear());

	it("refuses and alerts on a transaction no order, customer or mirror ties to the org", async () => {
		const r = await applyBillingEvent(completed({ customerId: "ctm_x" }), deps);
		expect(r).toEqual({ outcome: "refused", reason: "unrecorded_org" });
		expect(store.txns.size).toBe(0);
		expect(alert).toHaveBeenCalledTimes(1);
	});

	it("does not grant a credit pack on a transaction it cannot tie to the org", async () => {
		const pack: PaddleTransactionCustomData = { organizationId: ORG, kind: "credit_pack", credits: 5000, userId: USER };
		await applyBillingEvent(completed({ customerId: "ctm_x" }, pack), deps);
		expect(store.grants.size).toBe(0);
	});

	it("mirrors a transaction our checkout placed an order for", async () => {
		store.records.add(`${ORG}|txn_a`);
		expect(await applyBillingEvent(completed({ customerId: "ctm_x" }), deps)).toEqual({ outcome: "applied" });
		expect(store.txns.get("txn_a")?.organizationId).toBe(ORG);
	});

	it("mirrors a transaction of the org's stored Paddle customer", async () => {
		store.records.add(`${ORG}|ctm_x`);
		expect(await applyBillingEvent(completed({ customerId: "ctm_x" }), deps)).toEqual({ outcome: "applied" });
	});

	it("never takes another org's order as the record", async () => {
		store.records.add(`${OTHER_ORG}|txn_a`);
		expect((await applyBillingEvent(completed({ customerId: "ctm_x" }), deps)).outcome).toBe("refused");
	});

	it("alerts on an untied billed invoice, but not on other mere updates", async () => {
		const billed = { ...snapshot({ organizationId: ORG, kind: "plan" }), status: "billed" as const };
		await applyBillingEvent({ ...completed({ customerId: "ctm_x", transaction: billed }), kind: "transaction_updated" }, deps);
		expect(alert).toHaveBeenCalledTimes(1);
		const paid = { ...billed, status: "paid" as const };
		await applyBillingEvent({ ...completed({ customerId: "ctm_x", transaction: paid }), kind: "transaction_updated" }, deps);
		expect(alert).toHaveBeenCalledTimes(1);
	});

	it("asks for redelivery of an untied subscription transaction, whose subscription may not have landed", async () => {
		await expect(
			applyBillingEvent(completed({ customerId: "ctm_x", subscriptionId: "sub_new" }), deps),
		).rejects.toThrow(RetryableBillingEventError);
		expect(store.txns.size).toBe(0);
	});

	it("asks for redelivery of a live subscription it cannot tie yet, and applies it once its transaction is mirrored", async () => {
		const first = upsert({ customerId: "ctm_x", subscriptionId: "sub_new" });
		await expect(applyBillingEvent(first, deps)).rejects.toThrow(RetryableBillingEventError);
		expect(store.rows.size).toBe(0);
		// The checkout's transaction lands (its order is ours), carrying the subscription id.
		store.records.add(`${ORG}|txn_a`);
		await expect(
			applyBillingEvent(completed({ customerId: "ctm_x", subscriptionId: "sub_new" }), deps),
		).resolves.toEqual({ outcome: "applied" });
		expect(await applyBillingEvent(first, deps)).toEqual({ outcome: "applied" });
		expect(store.rows.get(ORG)?.paddleSubscriptionId).toBe("sub_new");
	});

	it("applies subscription.created through the order of the transaction that created it", async () => {
		store.records.add(`${ORG}|txn_checkout`);
		const r = await applyBillingEvent(
			upsert({ eventType: "subscription.created", customerId: "ctm_x", transactionId: "txn_checkout" }),
			deps,
		);
		expect(r).toEqual({ outcome: "applied" });
	});

	it("refuses quietly an ended subscription it cannot tie, with no redelivery", async () => {
		const r = await applyBillingEvent(upsert({ customerId: "ctm_x", status: "canceled" }), deps);
		expect(r).toEqual({ outcome: "refused", reason: "unrecorded_org" });
		expect(alert).not.toHaveBeenCalled();
	});
});

describe("credit packs", () => {
	const pack: PaddleTransactionCustomData = { organizationId: ORG, kind: "credit_pack", credits: 5000, userId: USER };

	it("grants a completed pack once, however often it is delivered", async () => {
		await applyBillingEvent(completed({}, pack), deps);
		await applyBillingEvent(completed({}, pack), deps);
		expect([...store.grants.values()]).toEqual([{ orgId: ORG, userId: USER, credits: 5000, transactionId: "txn_a" }]);
	});

	it("does not grant a pack size we do not sell, or one naming no user — it alerts", async () => {
		await applyBillingEvent(completed({}, { ...pack, credits: 999_999 }), deps);
		await applyBillingEvent(completed({ transactionId: "txn_b" }, { ...pack, userId: undefined }), deps);
		expect(store.grants.size).toBe(0);
		expect(alert).toHaveBeenCalledTimes(2);
	});
});

describe("adjustments", () => {
	const pack: PaddleTransactionCustomData = { organizationId: ORG, kind: "credit_pack", credits: 5000, userId: USER };

	it("asks for redelivery when the transaction is not mirrored yet", async () => {
		await expect(applyBillingEvent(adjustment(), deps)).rejects.toBeInstanceOf(RetryableBillingEventError);
	});

	it("marks a full refund and reverses the pack's credits", async () => {
		await applyBillingEvent(completed({}, pack), deps);
		await applyBillingEvent(adjustment(), deps);
		expect(store.txns.get("txn_a")?.refundedAt).toEqual(at(100));
		expect(store.grants.get("txn_a")?.credits).toBe(0);
		expect(alert).not.toHaveBeenCalled();
	});

	it("infers full from the totals when Paddle does not say", async () => {
		await applyBillingEvent(completed({}, pack), deps);
		await applyBillingEvent(adjustment({ full: null, total: money(-7080, "EUR") }), deps);
		expect(store.grants.get("txn_a")?.credits).toBe(0);
	});

	it("alerts on a partial refund and leaves the credits", async () => {
		await applyBillingEvent(completed({}, pack), deps);
		await applyBillingEvent(adjustment({ full: false, total: money(1000, "EUR") }), deps);
		expect(store.grants.get("txn_a")?.credits).toBe(5000);
		expect(store.txns.get("txn_a")?.refundedAt).toBeUndefined();
		expect(alert).toHaveBeenCalledTimes(1);
	});

	it("marks a plan refund without touching entitlements", async () => {
		await applyBillingEvent(completed(), deps);
		await applyBillingEvent(adjustment(), deps);
		expect(store.txns.get("txn_a")?.refundedAt).toEqual(at(100));
		expect(store.grants.size).toBe(0);
	});

	it("marks a chargeback, reverses pack credits and alerts; a reversal clears it and alerts", async () => {
		await applyBillingEvent(completed({}, pack), deps);
		await applyBillingEvent(adjustment({ action: "chargeback" }), deps);
		expect(store.txns.get("txn_a")?.chargebackAt).toEqual(at(100));
		expect(store.grants.get("txn_a")?.credits).toBe(0);
		await applyBillingEvent(adjustment({ action: "chargeback_reverse", adjustmentId: "adj_b" }), deps);
		expect(store.txns.get("txn_a")?.chargebackAt).toBeNull();
		expect(alert).toHaveBeenCalledTimes(2);
	});

	it("alerts on a chargeback against a plan transaction too", async () => {
		await applyBillingEvent(completed(), deps);
		await applyBillingEvent(adjustment({ action: "chargeback" }), deps);
		expect(alert).toHaveBeenCalledTimes(1);
	});

	it("ignores pending and rejected adjustments and credits; alerts on a reversed one", async () => {
		expect((await applyBillingEvent(adjustment({ status: "pending_approval" }), deps)).outcome).toBe("ignored");
		expect((await applyBillingEvent(adjustment({ status: "rejected" }), deps)).outcome).toBe("ignored");
		await applyBillingEvent(completed(), deps);
		expect((await applyBillingEvent(adjustment({ action: "credit" }), deps)).outcome).toBe("ignored");
		expect((await applyBillingEvent(adjustment({ status: "reversed" }), deps)).outcome).toBe("applied");
		expect(alert).toHaveBeenCalledTimes(1);
	});
});

describe("ignored events", () => {
	it("do nothing", async () => {
		const r = await applyBillingEvent(
			{ provider: "paddle", eventId: "evt_x", eventType: "customer.updated", occurredAt: at(0), organizationId: null, kind: "ignored", reason: "n/a" },
			deps,
		);
		expect(r).toEqual({ outcome: "ignored", reason: "n/a" });
	});
});
