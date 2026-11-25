// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Integration (real Postgres): applyBillingEvent over the Postgres store (lib/billing/events/store.ts).
// The unit suite (tests/lib/billing/apply-billing-event.test.ts) proves the rules over an in-memory
// store; this proves the real store gives them the same answers against the real schema, its CHECK
// constraints (a Paddle id requires billing_provider = 'paddle'; one subscription per slot) and its
// unique keys:
//  1. A first subscription inserts the row; an out-of-order older event is refused; cancel drops the plan.
//  2. A row left by a dead Stripe subscription is switched to Paddle (its Stripe id cleared) without
//     violating organization_billing_stripe_sub_is_stripe.
//  3. The transaction mirror upserts under its own watermark and never moves to another org.
//  4. A credit pack is granted once per transaction and zeroed by a full refund.
//  5. A business id another org holds is never written to a second row (the column is unique).
//
// Needs `pnpm db:up` (or any migrated Postgres on ALETHIA_DATABASE_URL); skips when unreachable.

import { randomUUID } from "node:crypto";
import { money } from "@repo/format";
import { eq, inArray } from "drizzle-orm";
import { afterAll, expect, it, vi } from "vitest";
import { type ApplyDeps, applyBillingEvent } from "@/lib/billing/events/apply";
import { postgresBillingEventStore } from "@/lib/billing/events/store";
import type {
	AdjustmentEvent,
	SubscriptionUpsertedEvent,
	TransactionCompletedEvent,
} from "@/lib/billing/provider/types";
import { getServiceDb } from "@/lib/db";
import { aiCreditGrant, organization, organizationBilling, paddleTransaction } from "@/lib/db/schema";
import type { PaddleTransactionCustomData } from "@/types/jsonb.types";
import { describeIfDb } from "./db";

const touchedOrgs: string[] = [];
const touchedTxns: string[] = [];

/** Inserts a fresh organization (tracked for teardown). */
async function seedOrg(): Promise<string> {
	const id = randomUUID();
	touchedOrgs.push(id);
	await getServiceDb().insert(organization).values({ id, name: `paddle-it-${id.slice(0, 8)}` });
	return id;
}

/** A unique Paddle-style id. */
function pid(prefix: string): string {
	return `${prefix}_it${randomUUID().replace(/-/g, "").slice(0, 20)}`;
}

/** The org's billing row. */
async function rowOf(orgId: string) {
	const [row] = await getServiceDb()
		.select()
		.from(organizationBilling)
		.where(eq(organizationBilling.organizationId, orgId))
		.limit(1);
	return row;
}

/** A time `s` seconds after a fixed origin. */
function at(s: number): Date {
	return new Date(Date.UTC(2026, 10, 25, 10, 0, s));
}

/** Deps over the real store, with the alert sink recorded. */
function deps(): ApplyDeps {
	return { store: postgresBillingEventStore, alert: vi.fn(async () => true), warn: vi.fn() };
}

/** A plan-slot upsert. */
function upsert(orgId: string | null, subscriptionId: string, over: Partial<SubscriptionUpsertedEvent> = {}): SubscriptionUpsertedEvent {
	return {
		provider: "paddle",
		eventId: pid("evt"),
		eventType: "subscription.updated",
		occurredAt: at(0),
		organizationId: orgId,
		kind: "subscription_upserted",
		slot: "plan",
		subscriptionId,
		customerId: "ctm_it",
		plan: "team",
		aiTier: null,
		status: "active",
		seats: 2,
		currentPeriodStart: at(0),
		currentPeriodEnd: at(30 * 86400),
		cancelEffectiveAt: null,
		businessId: null,
		addressId: null,
		...over,
	};
}

/** A completed transaction. */
function completed(transactionId: string, custom: PaddleTransactionCustomData, occurredAt = at(0)): TransactionCompletedEvent {
	touchedTxns.push(transactionId);
	return {
		provider: "paddle",
		eventId: pid("evt"),
		eventType: "transaction.completed",
		occurredAt,
		organizationId: custom.organizationId,
		kind: "transaction_completed",
		transactionId,
		subscriptionId: null,
		customerId: "ctm_it",
		item: custom.kind === "credit_pack" ? { kind: "credit_pack", credits: custom.credits ?? 0 } : null,
		total: money(1900, "EUR"),
		tax: money(0, "EUR"),
		billingPeriodStart: null,
		billingPeriodEnd: null,
		transaction: {
			status: "completed",
			origin: "web",
			subtotal: money(1900, "EUR"),
			tax: money(0, "EUR"),
			total: money(1900, "EUR"),
			invoiceNumber: null,
			billedAt: occurredAt,
			billingPeriodStart: null,
			billingPeriodEnd: null,
			customData: custom,
		},
	};
}

describeIfDb("applyBillingEvent over Postgres", () => {
	afterAll(async () => {
		const db = getServiceDb();
		if (touchedTxns.length > 0) {
			await db.delete(aiCreditGrant).where(inArray(aiCreditGrant.paddle_transaction_id, touchedTxns));
		}
		if (touchedOrgs.length > 0) await db.delete(organization).where(inArray(organization.id, touchedOrgs));
	});

	it("inserts, refuses an older event, and cancels", async () => {
		const org = await seedOrg();
		const sub = pid("sub");
		const d = deps();
		expect(await applyBillingEvent(upsert(org, sub, { occurredAt: at(10), status: "past_due" }), d)).toEqual({
			outcome: "applied",
		});
		expect((await applyBillingEvent(upsert(org, sub, { occurredAt: at(5) }), d)).outcome).toBe("refused");
		expect(await rowOf(org)).toMatchObject({
			billingProvider: "paddle",
			paddleSubscriptionId: sub,
			status: "past_due",
			plan: "team",
			paddleSubscriptionEventAt: at(10),
		});
		await applyBillingEvent(
			{ provider: "paddle", eventId: pid("evt"), eventType: "subscription.canceled", occurredAt: at(20), organizationId: null, kind: "subscription_canceled", slot: "plan", subscriptionId: sub },
			d,
		);
		expect(await rowOf(org)).toMatchObject({ status: "canceled", plan: "community", currentPeriodEnd: null });
	});

	it("switches a row left by a dead Stripe subscription to Paddle", async () => {
		const org = await seedOrg();
		const stripeSub = `sub_stripe_${randomUUID()}`;
		await getServiceDb().insert(organizationBilling).values({
			organizationId: org,
			plan: "community",
			status: "canceled",
			stripeSubscriptionId: stripeSub,
		});
		const sub = pid("sub");
		expect((await applyBillingEvent(upsert(org, sub), deps())).outcome).toBe("applied");
		expect(await rowOf(org)).toMatchObject({
			billingProvider: "paddle",
			stripeSubscriptionId: null,
			paddleSubscriptionId: sub,
			status: "active",
		});
	});

	it("keeps the transaction mirror on its watermark and its org", async () => {
		const org = await seedOrg();
		const other = await seedOrg();
		const txn = pid("txn");
		const d = deps();
		await applyBillingEvent(completed(txn, { organizationId: org, kind: "plan" }, at(10)), d);
		const older = completed(txn, { organizationId: org, kind: "plan" }, at(5));
		expect((await applyBillingEvent({ ...older, kind: "transaction_updated", transaction: { ...older.transaction, status: "paid" } }, d)).outcome).toBe(
			"refused",
		);
		expect((await applyBillingEvent(completed(txn, { organizationId: other, kind: "plan" }, at(20)), d)).outcome).toBe(
			"refused",
		);
		const [row] = await getServiceDb()
			.select()
			.from(paddleTransaction)
			.where(eq(paddleTransaction.paddleTransactionId, txn));
		expect(row).toMatchObject({ organizationId: org, status: "completed", totalMinor: 1900, eventOccurredAt: at(10) });
	});

	it("grants a credit pack once and zeroes it on a full refund", async () => {
		const org = await seedOrg();
		const txn = pid("txn");
		const d = deps();
		const pack: PaddleTransactionCustomData = { organizationId: org, kind: "credit_pack", credits: 5000, userId: randomUUID() };
		await applyBillingEvent(completed(txn, pack), d);
		await applyBillingEvent(completed(txn, pack), d);
		const grants = () => getServiceDb().select().from(aiCreditGrant).where(eq(aiCreditGrant.paddle_transaction_id, txn));
		expect((await grants()).map((g) => g.credits)).toEqual([5000]);
		const refund: AdjustmentEvent = {
			provider: "paddle",
			eventId: pid("evt"),
			eventType: "adjustment.updated",
			occurredAt: at(100),
			organizationId: null,
			kind: "adjustment",
			adjustmentId: pid("adj"),
			transactionId: txn,
			action: "refund",
			status: "approved",
			total: money(1900, "EUR"),
			full: true,
		};
		await applyBillingEvent(refund, d);
		expect((await grants()).map((g) => g.credits)).toEqual([0]);
		const [mirror] = await getServiceDb().select().from(paddleTransaction).where(eq(paddleTransaction.paddleTransactionId, txn));
		expect(mirror?.refundedAt).toEqual(at(100));
	});

	it("never writes a business id another org already holds", async () => {
		const a = await seedOrg();
		const b = await seedOrg();
		const biz = pid("biz");
		await applyBillingEvent(upsert(a, pid("sub"), { businessId: biz }), deps());
		expect((await applyBillingEvent(upsert(b, pid("sub"), { businessId: biz }), deps())).outcome).toBe("applied");
		expect((await rowOf(a))?.paddleBusinessId).toBe(biz);
		expect((await rowOf(b))?.paddleBusinessId).toBeNull();
	});
});
