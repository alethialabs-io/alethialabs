// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Integration: the payment-hold sweeper, its emails and the operator command against real Postgres —
// the real store, the real purchase lease and the real compare-and-sets — with Stripe, the alert and the
// email transport faked (ADR 0002 §5.4, §8, Q3; S6 #5783):
//
//   C53  (the sweeper half) one tick advances a due hold under its payer's lease; a hold that is not due
//        is left alone until a nudge makes it due; overlapping ticks advance one hold once; a hold
//        whose payer's lease is held is skipped.
//   C59  a refund in `requires_action` alerts once, 25h after it went so, and the hold stays
//        `refund_pending`.
//   C61  a T4-shaped hold (a payment in flight) is not alerted at 72h, and is, once, at 14 days.
//   C95  the Q3 email: two ticks — sequential or overlapping — send one email per hold and state; a send
//        that throws gives the claim back and the next tick sends it; `released(refunded)` and an
//        adoption with no org are mailed once each.
//   C19  (the release) `release` writes `released_by`, `release_note` and the audit event once; a
//        second run writes nothing; it refuses beside an open setup whose subscription may still go
//        live, and while the payer's lease is busy.
//   C58  `reconcile --backfill` holds only the never-live checkouts (B1–B6), refunds only a payment that
//        landed after the end, lists the rest without writing, and a re-run writes nothing new.
//
// Every tick here is scoped to the test's own payer (`payerKey`), so no other file's rows are touched.

import { randomUUID } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { HOLD_REFUND_METADATA_KEY } from "@/lib/billing/payment-holds/observe";
import * as store from "@/lib/billing/payment-holds/store";
import { nudgeHold, openHold, payerLeaseKey } from "@/lib/billing/payment-holds/store";
import * as sweeper from "@/lib/billing/payment-holds/sweeper";
import { runPaymentHoldSweep, type SweepDeps } from "@/lib/billing/payment-holds/sweeper";
import {
	acquirePurchaseLease,
	releasePurchaseLease,
	tryAcquirePurchaseLease,
} from "@/lib/billing/purchase-lease";
import { getServiceDb } from "@/lib/db";
import { type PaymentHoldRow, paymentHolds, pendingOrgSetups, purchaseLeases, user } from "@/lib/db/schema";
import { releaseHoldCommand, runBackfill, type ServerDeps } from "@/scripts/payment-holds";
import { describeIfDb } from "./db";

// ── A fake Stripe account: the machine's reads and writes, and the backfill's listing ───────────────

interface FakePi {
	id: string;
	status: string;
	amount: number;
	pm: string | null;
	refunds: Array<{ status: string; amount: number; metadata: Record<string, string> }>;
}
interface FakeInvoice {
	id: string;
	status: string;
	billing_reason: string;
	paid_at: number | null;
	pis: FakePi[];
}
interface FakeSub {
	id: string;
	status: string;
	customer: string;
	ended_at: number | null;
	metadata: Record<string, string>;
	cancellation_details: { reason: string | null } | null;
	invoices: FakeInvoice[];
}

/** One fake Stripe account; every write is logged. */
class FakeStripe {
	readonly subs = new Map<string, FakeSub>();
	readonly log: string[] = [];

	/** Adds a subscription with one first invoice (`in_<sub id>`). */
	add(over: Partial<FakeSub> & { id: string }, invoice: Partial<FakeInvoice> = {}): FakeSub {
		const sub: FakeSub = {
			status: "incomplete",
			customer: "cus_it_sweep",
			ended_at: null,
			metadata: {},
			cancellation_details: null,
			invoices: [{ id: `in_${over.id}`, status: "open", billing_reason: "subscription_create", paid_at: null, pis: [], ...invoice }],
			...over,
		};
		this.subs.set(sub.id, sub);
		return sub;
	}

	/** The invoice with `id`, wherever it is. */
	private invoice(id: string): FakeInvoice {
		for (const s of this.subs.values()) {
			const found = s.invoices.find((i) => i.id === id);
			if (found) return found;
		}
		throw Object.assign(new Error(`No such invoice: ${id}`), { code: "resource_missing" });
	}

	/** The PaymentIntent with `id`, wherever it is. */
	private pi(id: string): FakePi {
		for (const s of this.subs.values()) {
			for (const i of s.invoices) {
				const found = i.pis.find((p) => p.id === id);
				if (found) return found;
			}
		}
		throw Object.assign(new Error(`No such payment_intent: ${id}`), { code: "resource_missing" });
	}

	/** The subscription with `id`. */
	private sub(id: string): FakeSub {
		const found = this.subs.get(id);
		if (!found) throw Object.assign(new Error(`No such subscription: ${id}`), { code: "resource_missing" });
		return found;
	}

	/** The PaymentIntent as an invoice payment expands it. */
	private expanded(p: FakePi) {
		return {
			id: p.id,
			status: p.status,
			amount_received: p.status === "succeeded" ? p.amount : 0,
			payment_method: p.pm === null ? null : { type: p.pm },
		};
	}

	readonly subscriptions = {
		retrieve: async (id: string) => ({ status: this.sub(id).status }),
		cancel: async (id: string, params: { cancellation_details: { comment: string } }) => {
			this.log.push(`subscriptions.cancel:${id}:${params.cancellation_details.comment}`);
			this.sub(id).status = "canceled";
			return {};
		},
		list: (params: { status: "canceled" | "incomplete_expired"; limit: number }) => {
			const matching = [...this.subs.values()].filter((s) => s.status === params.status);
			return {
				async *[Symbol.asyncIterator]() {
					for (const s of matching) yield s;
				},
			};
		},
	};

	readonly invoices = {
		retrieve: async (id: string) => ({ status: this.invoice(id).status }),
		voidInvoice: async (id: string) => {
			this.log.push(`invoices.voidInvoice:${id}`);
			const inv = this.invoice(id);
			if (inv.status !== "open" && inv.status !== "uncollectible") throw new Error("invoice is not open");
			inv.status = "void";
			for (const p of inv.pis) if (p.status.startsWith("requires_")) p.status = "canceled";
			return {};
		},
		del: async (id: string) => {
			this.log.push(`invoices.del:${id}`);
			return {};
		},
		list: async (params: { subscription: string; limit: number }) => {
			const all = this.sub(params.subscription).invoices;
			return {
				has_more: all.length > params.limit,
				data: all.slice(0, params.limit).map((i) => ({
					id: i.id,
					status: i.status,
					billing_reason: i.billing_reason,
					status_transitions: { paid_at: i.paid_at },
				})),
			};
		},
	};

	readonly invoicePayments = {
		list: async (params: { invoice: string; limit: number; expand: string[] }) => ({
			has_more: false,
			data: this.invoice(params.invoice).pis.map((p) => ({
				status: p.status === "succeeded" ? "paid" : "open",
				payment: { type: "payment_intent", payment_intent: this.expanded(p) },
			})),
		}),
	};

	readonly paymentIntents = {
		retrieve: async (id: string) => this.expanded(this.pi(id)),
		cancel: async (id: string) => {
			this.log.push(`paymentIntents.cancel:${id}`);
			this.pi(id).status = "canceled";
			return {};
		},
	};

	readonly refunds = {
		list: async (params: { payment_intent: string; limit: number }) => ({
			has_more: false,
			data: this.pi(params.payment_intent).refunds,
		}),
		create: async (
			params: { payment_intent: string; amount: number; metadata: Record<string, string> },
			options: { idempotencyKey: string },
		) => {
			this.log.push(`refunds.create:${options.idempotencyKey}`);
			this.pi(params.payment_intent).refunds.push({ status: "succeeded", amount: params.amount, metadata: params.metadata });
			return {};
		},
	};

	/** The writes logged for one subscription or its invoice. */
	writesFor(subId: string): string[] {
		return this.log.filter((l) => l.includes(subId));
	}
}

// ── Fixtures ────────────────────────────────────────────────────────────────────────────────────────

const payers: string[] = [];
const subscriptions: string[] = [];
const users: string[] = [];

/** A fresh payer id. */
function newPayer(): string {
	const payer = randomUUID();
	payers.push(payer);
	return payer;
}

/** A fresh subscription id, cleaned up after the file. */
function newSub(): string {
	const id = `sub_it_sweep_${randomUUID().slice(0, 12)}`;
	subscriptions.push(id);
	return id;
}

/** A user row (a setup needs one), cleaned up after the file. */
async function newUser(): Promise<string> {
	const id = randomUUID();
	users.push(id);
	payers.push(id);
	await getServiceDb().insert(user).values({ id, email: `it-sweep-${id}@example.test` });
	return id;
}

/** Opens a hold for `payer` on `sub` (E0, `closing`), under a lease it then gives back. */
async function hold(payer: string, sub: string, over: Partial<typeof paymentHolds.$inferInsert> = {}): Promise<PaymentHoldRow> {
	const lease = await tryAcquirePurchaseLease(payerLeaseKey(payer));
	if (!lease) throw new Error("fixture: the payer's lease was not free");
	const opened = await openHold(lease, {
		subscriptionId: sub,
		customerId: "cus_it_sweep",
		payerKey: payer,
		invoiceId: `in_${sub}`,
		state: "closing",
		nextCheckAt: new Date(Date.now() - 1000),
		openedBy: "purchase",
		openedByUserId: payer,
	});
	await releasePurchaseLease(lease);
	if (opened.kind !== "opened") throw new Error(`fixture: the open returned ${opened.kind}`);
	if (Object.keys(over).length === 0) return opened.hold;
	const [row] = await getServiceDb().update(paymentHolds).set(over).where(eq(paymentHolds.id, opened.hold.id)).returning();
	if (!row) throw new Error("fixture: the hold is gone");
	return row;
}

/** Records `payer`'s create-a-team setup for `sub`, open unless `linkedAt` is given. */
async function recordSetup(payer: string, sub: string, linkedAt: Date | null = null): Promise<void> {
	await getServiceDb().insert(pendingOrgSetups).values({
		user_id: payer,
		subscription_id: sub,
		customer_id: "cus_it_sweep",
		intended_name: "Held",
		intended_slug: `held-${sub.slice(-8)}`,
		linked_at: linkedAt,
	});
}

/** The row as the database has it now. */
async function read(id: string): Promise<PaymentHoldRow> {
	const [row] = await getServiceDb().select().from(paymentHolds).where(eq(paymentHolds.id, id));
	if (!row) throw new Error(`hold ${id} is gone`);
	return row;
}

/** Makes `id` due now, without touching its state or version. */
async function makeDue(id: string): Promise<void> {
	await getServiceDb().update(paymentHolds).set({ next_check_at: new Date(Date.now() - 1000) }).where(eq(paymentHolds.id, id));
}

/** A timestamp `ms` ago. */
const ago = (ms: number) => new Date(Date.now() - ms);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const alert = vi.fn<SweepDeps["alert"]>(async () => true);
const deliver = vi.fn<SweepDeps["deliver"]>(async () => undefined);

/** Sweep deps over `stripe`. */
function depsOver(stripe: FakeStripe): SweepDeps {
	return { stripe: () => stripe, alert, deliver, now: () => new Date() };
}

/** One tick for `payer` only. */
function tick(payer: string, stripe: FakeStripe) {
	return runPaymentHoldSweep({ payerKey: payer, deps: depsOver(stripe) });
}

afterEach(() => {
	alert.mockClear();
	deliver.mockReset();
	deliver.mockResolvedValue(undefined);
});

afterAll(async () => {
	const db = getServiceDb();
	if (subscriptions.length) {
		await db.delete(paymentHolds).where(inArray(paymentHolds.subscription_id, subscriptions));
		await db.delete(pendingOrgSetups).where(inArray(pendingOrgSetups.subscription_id, subscriptions));
	}
	if (payers.length) {
		await db.delete(paymentHolds).where(inArray(paymentHolds.payer_key, payers));
		await db.delete(purchaseLeases).where(inArray(purchaseLeases.key, payers.map(payerLeaseKey)));
	}
	if (users.length) await db.delete(user).where(inArray(user.id, users));
});

// ── C53: the sweeper advances what is due ───────────────────────────────────────────────────────────

describeIfDb("payment-hold sweeper — C53: one tick advances every due hold, under its payer's lease", () => {
	it("advances a due hold (void, then the stamped cancel, then released); a hold not due waits for its nudge", async () => {
		const stripe = new FakeStripe();
		const payer = newPayer();
		const due = newSub();
		const later = newSub();
		stripe.add({ id: due });
		stripe.add({ id: later });
		const a = await hold(payer, due);
		const b = await hold(payer, later, { next_check_at: new Date(Date.now() + HOUR) });

		const first = await tick(payer, stripe);
		expect(first).toMatchObject({ due: 1, advanced: 1, released: 1, busy: 0 });
		expect(await read(a.id)).toMatchObject({ state: "released", release_reason: "voided_unpaid" });
		expect(stripe.writesFor(due)).toEqual([
			`invoices.voidInvoice:in_${due}`,
			`subscriptions.cancel:${due}:alethia:checkout_closed:${a.id}`,
		]);
		expect(await read(b.id)).toMatchObject({ state: "closing", version: 0 });
		expect(stripe.writesFor(later)).toEqual([]);

		// The webhook's hint makes it due at once (nudged_at > observed_at), with no schedule change.
		expect(await nudgeHold(later)).toBe(1);
		const second = await tick(payer, stripe);
		expect(second).toMatchObject({ due: 1, released: 1 });
		expect(await read(b.id)).toMatchObject({ state: "released", release_reason: "voided_unpaid" });
	});

	it("two overlapping ticks advance one hold ONCE: one void, one cancel", async () => {
		const stripe = new FakeStripe();
		const payer = newPayer();
		const sub = newSub();
		stripe.add({ id: sub });
		const h = await hold(payer, sub);
		const [r1, r2] = await Promise.all([tick(payer, stripe), tick(payer, stripe)]);
		expect(r1.released + r2.released).toBe(1);
		expect(stripe.writesFor(sub).filter((w) => w.startsWith("invoices.voidInvoice"))).toHaveLength(1);
		expect(stripe.writesFor(sub).filter((w) => w.startsWith("subscriptions.cancel"))).toHaveLength(1);
		expect((await read(h.id)).state).toBe("released");
	});

	it("skips a hold whose payer's lease another caller holds, and leaves it due", async () => {
		const stripe = new FakeStripe();
		const payer = newPayer();
		const sub = newSub();
		stripe.add({ id: sub });
		const h = await hold(payer, sub);
		const held = await tryAcquirePurchaseLease(payerLeaseKey(payer));
		if (!held) throw new Error("fixture: lease not free");
		try {
			expect(await tick(payer, stripe)).toMatchObject({ due: 1, advanced: 0, busy: 1 });
			expect(await read(h.id)).toMatchObject({ state: "closing", version: 0 });
			expect(stripe.writesFor(sub)).toEqual([]);
		} finally {
			await releasePurchaseLease(held);
		}
		expect(await tick(payer, stripe)).toMatchObject({ released: 1 });
	});
});

// ── C59, C61: the age alerts ────────────────────────────────────────────────────────────────────────

describeIfDb("payment-hold sweeper — the age alerts (§5.4, I11)", () => {
	it("C59: a refund in requires_action for 25h alerts ONCE, and the hold stays refund_pending", async () => {
		const stripe = new FakeStripe();
		const payer = newPayer();
		const sub = newSub();
		stripe.add(
			{ id: sub, status: "canceled" },
			{
				status: "paid",
				pis: [{ id: `pi_${sub}`, status: "succeeded", amount: 1000, pm: "card", refunds: [{ status: "requires_action", amount: 1000, metadata: {} }] }],
			},
		);
		const h = await hold(payer, sub, {
			state: "refund_pending",
			state_since: ago(2 * DAY),
			last_pay: "succeeded",
			refund_action_since: ago(25 * HOUR),
			notified_state: "refund_pending",
		});

		expect(await tick(payer, stripe)).toMatchObject({ advanced: 1, ageAlerts: 1 });
		expect(alert).toHaveBeenCalledTimes(1);
		expect(alert.mock.calls[0]?.[0]).toMatchObject({ subscriptionId: sub, detail: expect.stringMatching(/requires_action/) });
		const after = await read(h.id);
		expect(after.state).toBe("refund_pending");
		expect(after.age_alerted_at).not.toBeNull();
		expect(stripe.writesFor(sub)).toEqual([]);

		await makeDue(h.id);
		expect(await tick(payer, stripe)).toMatchObject({ advanced: 1, ageAlerts: 0 });
		expect(alert).toHaveBeenCalledTimes(1);
	});

	it("C61: a T4-shaped hold (a payment in flight) is not alerted at 72h, and is, once, at 14 days", async () => {
		const stripe = new FakeStripe();
		const payer = newPayer();
		const sub = newSub();
		stripe.add({ id: sub }, { pis: [{ id: `pi_${sub}`, status: "processing", amount: 1000, pm: "card", refunds: [] }] });
		const h = await hold(payer, sub, { state_since: ago(72 * HOUR), last_pay: "in_flight" });

		expect(await tick(payer, stripe)).toMatchObject({ advanced: 1, ageAlerts: 0 });
		expect(alert).not.toHaveBeenCalled();
		expect((await read(h.id)).state).toBe("closing");

		await getServiceDb()
			.update(paymentHolds)
			.set({ state_since: ago(15 * DAY), next_check_at: ago(1000) })
			.where(eq(paymentHolds.id, h.id));
		expect(await tick(payer, stripe)).toMatchObject({ ageAlerts: 1 });
		expect(alert).toHaveBeenCalledTimes(1);
		await makeDue(h.id);
		expect(await tick(payer, stripe)).toMatchObject({ ageAlerts: 0 });
		expect(alert).toHaveBeenCalledTimes(1);
		expect(stripe.writesFor(sub)).toEqual([]);
	});
});

// ── C95: the Q3 emails, at most once per hold and state ─────────────────────────────────────────────

describeIfDb("payment-hold sweeper — C95: the Q3 emails go out at most once per hold and state", () => {
	/** A `refund_pending` hold that is not due for observation, so only the email pass touches it. */
	async function pendingRefund(payer: string): Promise<PaymentHoldRow> {
		return hold(payer, newSub(), { state: "refund_pending", next_check_at: new Date(Date.now() + HOUR) });
	}

	it("two sequential ticks send ONE refund_pending email, and the claim is recorded", async () => {
		const stripe = new FakeStripe();
		const payer = newPayer();
		const h = await pendingRefund(payer);
		expect((await tick(payer, stripe)).notices).toBe(1);
		expect((await tick(payer, stripe)).notices).toBe(0);
		expect(deliver).toHaveBeenCalledTimes(1);
		expect(deliver.mock.calls[0]?.[1]).toBe("refund_pending");
		expect(deliver.mock.calls[0]?.[0]).toMatchObject({ id: h.id });
		expect(await read(h.id)).toMatchObject({ notified_state: "refund_pending", version: h.version });
	});

	it("two OVERLAPPING ticks send one email per hold", async () => {
		const stripe = new FakeStripe();
		const payer = newPayer();
		const holds = [await pendingRefund(payer), await pendingRefund(payer), await pendingRefund(payer)];
		const results = await Promise.all([tick(payer, stripe), tick(payer, stripe), tick(payer, stripe)]);
		expect(results.reduce((n, r) => n + r.notices, 0)).toBe(3);
		expect(deliver).toHaveBeenCalledTimes(3);
		expect(new Set(deliver.mock.calls.map((c) => c[0].id))).toEqual(new Set(holds.map((h) => h.id)));
	});

	it("a send that throws gives the claim back, and the next tick sends it", async () => {
		const stripe = new FakeStripe();
		const payer = newPayer();
		const h = await pendingRefund(payer);
		deliver.mockRejectedValueOnce(new Error("ses down"));
		expect((await tick(payer, stripe)).notices).toBe(0);
		expect((await read(h.id)).notified_state).toBeNull();
		expect((await tick(payer, stripe)).notices).toBe(1);
		expect((await read(h.id)).notified_state).toBe("refund_pending");
		expect(deliver).toHaveBeenCalledTimes(2);
	});

	it("released(refunded) is mailed once after refund_pending was; voided_unpaid is never mailed", async () => {
		const stripe = new FakeStripe();
		const payer = newPayer();
		const refunded = await hold(payer, newSub(), {
			state: "released",
			release_reason: "refunded",
			released_at: new Date(),
			next_check_at: null,
			notified_state: "refund_pending",
		});
		await hold(payer, newSub(), { state: "released", release_reason: "voided_unpaid", released_at: new Date(), next_check_at: null });
		expect((await tick(payer, stripe)).notices).toBe(1);
		expect((await tick(payer, stripe)).notices).toBe(0);
		expect(deliver.mock.calls.map((c) => [c[0].id, c[1]])).toEqual([[refunded.id, "released:refunded"]]);
	});

	it("an adoption is mailed once while its setup has no org, and not at all once the setup is linked", async () => {
		const stripe = new FakeStripe();
		const payer = await newUser();
		const orphan = newSub();
		const linked = newSub();
		await recordSetup(payer, orphan);
		await recordSetup(payer, linked, new Date());
		const adoptedOrphan = await hold(payer, orphan, { state: "released", release_reason: "adopted", released_at: new Date(), next_check_at: null });
		await hold(payer, linked, { state: "released", release_reason: "adopted", released_at: new Date(), next_check_at: null });
		expect((await tick(payer, stripe)).notices).toBe(1);
		expect((await tick(payer, stripe)).notices).toBe(0);
		expect(deliver.mock.calls.map((c) => [c[0].id, c[1]])).toEqual([[adoptedOrphan.id, "released:adopted"]]);
	});
});

// ── C19: the operator's release (T16) ───────────────────────────────────────────────────────────────

/** The real server modules over `stripe`, with a short lease wait so a busy lease is refused quickly. */
function serverDeps(stripe: FakeStripe): ServerDeps {
	return {
		store,
		lease: { acquirePurchaseLease: (key: string) => acquirePurchaseLease(key, 300), releasePurchaseLease },
		sweeper,
		sweepDeps: depsOver(stripe),
	};
}

describeIfDb("payment-holds release — C19: T16, audited", () => {
	let info: ReturnType<typeof vi.spyOn>;
	let printed: string[];
	const print = (line: string) => {
		printed.push(line);
	};
	beforeAll(() => {
		info = vi.spyOn(console, "info").mockImplementation(() => undefined);
	});
	afterEach(() => {
		info.mockClear();
		printed = [];
	});
	afterAll(() => {
		info.mockRestore();
	});
	printed = [];

	/** The audit events written. */
	const audits = () =>
		info.mock.calls.map((c: unknown[]) => String(c[0])).filter((l: string) => l.includes('"billing.payment_hold.released"'));

	it("an unpaid subscription's needs_operator hold: released_by, release_note, operator — and the audit event ONCE", async () => {
		const stripe = new FakeStripe();
		const payer = newPayer();
		const sub = newSub();
		stripe.add({ id: sub, status: "unpaid" });
		const h = await hold(payer, sub, { state: "needs_operator" });
		const args = { subscriptionId: sub, reason: "AC9: unpaid; refunded by hand", operator: "op-it" };

		expect(await releaseHoldCommand(args, serverDeps(stripe), print)).toEqual({ kind: "released", holdId: h.id });
		expect(await read(h.id)).toMatchObject({
			state: "released",
			release_reason: "operator",
			released_by: "op-it",
			release_note: "AC9: unpaid; refunded by hand",
			version: h.version + 1,
		});
		expect(audits()).toHaveLength(1);
		expect(JSON.parse(audits()[0] ?? "{}")).toMatchObject({ subscription_id: sub, operator: "op-it", from_state: "needs_operator" });
		expect(stripe.log).toEqual([]);

		expect(await releaseHoldCommand(args, serverDeps(stripe), print)).toEqual({ kind: "not_open" });
		expect(audits()).toHaveLength(1);
	});

	it("needs a reason: no row changes", async () => {
		const stripe = new FakeStripe();
		const payer = newPayer();
		const sub = newSub();
		stripe.add({ id: sub, status: "unpaid" });
		const h = await hold(payer, sub, { state: "needs_operator" });
		expect(await releaseHoldCommand({ subscriptionId: sub, reason: " ", operator: "op-it" }, serverDeps(stripe), print)).toMatchObject({
			kind: "refused",
		});
		expect(await read(h.id)).toMatchObject({ state: "needs_operator", version: h.version });
		expect(audits()).toEqual([]);
	});

	it("refuses beside an open setup whose subscription is live, and while the payer's lease is busy", async () => {
		const stripe = new FakeStripe();
		const payer = await newUser();
		const sub = newSub();
		stripe.add({ id: sub, status: "active" });
		await recordSetup(payer, sub);
		const h = await hold(payer, sub, { state: "needs_operator" });
		const args = { subscriptionId: sub, reason: "try", operator: "op-it" };
		expect(await releaseHoldCommand(args, serverDeps(stripe), print)).toMatchObject({ kind: "refused" });
		expect(await read(h.id)).toMatchObject({ state: "needs_operator", version: h.version });
		const [setup] = await getServiceDb().select().from(pendingOrgSetups).where(eq(pendingOrgSetups.subscription_id, sub));
		expect(setup?.closed_at).toBeNull();

		// Once Stripe reads it ended, the lease decides: busy refuses, free releases (and closes the setup).
		stripe.add({ id: sub, status: "canceled" });
		const busy = await tryAcquirePurchaseLease(payerLeaseKey(payer));
		if (!busy) throw new Error("fixture: lease not free");
		try {
			expect(await releaseHoldCommand(args, serverDeps(stripe), print)).toMatchObject({ kind: "refused" });
		} finally {
			await releasePurchaseLease(busy);
		}
		expect(audits()).toEqual([]);
		expect(await releaseHoldCommand(args, serverDeps(stripe), print)).toMatchObject({ kind: "released" });
		const [closed] = await getServiceDb().select().from(pendingOrgSetups).where(eq(pendingOrgSetups.subscription_id, sub));
		expect(closed?.closed_reason).toBe("hold_released");
	});
});

// ── C58: the backfill ───────────────────────────────────────────────────────────────────────────────

describeIfDb("payment-holds reconcile --backfill — C58: holds only the never-live checkouts, and re-runs safely", () => {
	it("holds and settles B1–B6 hits, refunds only a payment that landed after the end, lists the rest", async () => {
		const stripe = new FakeStripe();
		const payer = newPayer();
		const mine = { created_by: payer };
		const requested = { reason: "cancellation_requested" };
		const neverPaid = newSub();
		const paidAfter = newSub();
		const paidBefore = newSub();
		const bankDebit = newSub();
		const orgOwned = newSub();
		stripe.add(
			{ id: neverPaid, status: "canceled", ended_at: 1000, metadata: mine, cancellation_details: requested },
			{ pis: [{ id: `pi_${neverPaid}`, status: "requires_payment_method", amount: 1000, pm: null, refunds: [] }] },
		);
		stripe.add(
			{ id: paidAfter, status: "canceled", ended_at: 1000, metadata: mine, cancellation_details: requested },
			{ status: "paid", paid_at: 2000, pis: [{ id: `pi_${paidAfter}`, status: "succeeded", amount: 1500, pm: "card", refunds: [] }] },
		);
		stripe.add(
			{ id: paidBefore, status: "canceled", ended_at: 1000, metadata: mine, cancellation_details: requested },
			{ status: "paid", paid_at: 500, pis: [{ id: `pi_${paidBefore}`, status: "succeeded", amount: 1500, pm: "card", refunds: [] }] },
		);
		stripe.add(
			{ id: bankDebit, status: "canceled", ended_at: 1000, metadata: mine, cancellation_details: requested },
			{ pis: [{ id: `pi_${bankDebit}`, status: "processing", amount: 1500, pm: "us_bank_account", refunds: [] }] },
		);
		stripe.add({
			id: orgOwned,
			status: "canceled",
			ended_at: 1000,
			metadata: { created_by: payer, organization_id: randomUUID() },
			cancellation_details: requested,
		});
		const printed: string[] = [];
		const print = (line: string) => {
			printed.push(line);
		};

		const first = await runBackfill(serverDeps(stripe), stripe, print);
		expect(first).toEqual({ held: 2, toOperator: 0, listed: 2, alreadyHeld: 0, notCreateATeam: 1 });

		const rows = await getServiceDb()
			.select()
			.from(paymentHolds)
			.where(inArray(paymentHolds.subscription_id, [neverPaid, paidAfter, paidBefore, bankDebit, orgOwned]));
		const bySub = new Map(rows.map((r) => [r.subscription_id, r]));
		expect(rows).toHaveLength(2);
		expect(bySub.get(neverPaid)).toMatchObject({
			state: "released",
			release_reason: "voided_unpaid",
			opened_by: "backfill",
			payer_key: payer,
			invoice_id: `in_${neverPaid}`,
			open_note: expect.stringMatching(/^backfill: B2 canceled/),
		});
		const refundedHold = bySub.get(paidAfter);
		expect(refundedHold).toMatchObject({ state: "released", release_reason: "refunded", opened_by: "backfill" });
		expect(stripe.writesFor(`pi_${paidAfter}`)).toEqual([`refunds.create:hold-refund-pi_${paidAfter}-0`]);
		expect(stripe.subs.get(paidAfter)?.invoices[0]?.pis[0]?.refunds[0]?.metadata).toEqual({
			[HOLD_REFUND_METADATA_KEY]: refundedHold?.id,
		});
		// Legitimate revenue and a bank debit are listed, with the failed test named — never held, never refunded.
		expect(printed.some((l) => l.startsWith(`LISTED ${paidBefore}: B4`))).toBe(true);
		expect(printed.some((l) => l.startsWith(`LISTED ${bankDebit}: B5`))).toBe(true);
		expect(stripe.writesFor(paidBefore)).toEqual([]);
		expect(stripe.writesFor(bankDebit)).toEqual([]);

		// A second run writes nothing: every subscription a hold has named is skipped.
		const writesBefore = stripe.log.length;
		const second = await runBackfill(serverDeps(stripe), stripe, print);
		expect(second).toEqual({ held: 0, toOperator: 0, listed: 2, alreadyHeld: 2, notCreateATeam: 1 });
		expect(stripe.log.length).toBe(writesBefore);
		const [after] = await getServiceDb()
			.select({ count: sql<number>`count(*)::int` })
			.from(paymentHolds)
			.where(inArray(paymentHolds.subscription_id, [neverPaid, paidAfter, paidBefore, bankDebit, orgOwned]));
		expect(after?.count).toBe(2);
	});

	it("two backfills at once open ONE hold per subscription; an invoice with no PaymentIntent is held for an operator and alerted", async () => {
		const stripe = new FakeStripe();
		const payer = newPayer();
		const mine = { created_by: payer };
		const requested = { reason: "cancellation_requested" };
		const neverPaid = newSub();
		const noPi = newSub();
		stripe.add(
			{ id: neverPaid, status: "canceled", ended_at: 1000, metadata: mine, cancellation_details: requested },
			{ pis: [{ id: `pi_${neverPaid}`, status: "requires_payment_method", amount: 1000, pm: null, refunds: [] }] },
		);
		stripe.add({ id: noPi, status: "canceled", ended_at: 1000, metadata: mine, cancellation_details: requested });
		const quiet = () => undefined;
		const [a, b] = await Promise.all([
			runBackfill(serverDeps(stripe), stripe, quiet),
			runBackfill(serverDeps(stripe), stripe, quiet),
		]);
		expect(a.held + b.held).toBe(1);
		expect(a.toOperator + b.toOperator).toBe(1);

		const rows = await getServiceDb().select().from(paymentHolds).where(inArray(paymentHolds.subscription_id, [neverPaid, noPi]));
		expect(rows).toHaveLength(2);
		const bySub = new Map(rows.map((r) => [r.subscription_id, r]));
		expect(bySub.get(neverPaid)).toMatchObject({ state: "released", release_reason: "voided_unpaid" });
		expect(bySub.get(noPi)).toMatchObject({ state: "needs_operator", open_note: expect.stringMatching(/B5 unproven/) });
		expect(bySub.get(noPi)?.alerted_at).not.toBeNull();
		expect(alert.mock.calls.filter((c) => c[0].subscriptionId === noPi)).toHaveLength(1);
		expect(stripe.writesFor(noPi)).toEqual([]);
		expect(stripe.writesFor(neverPaid).filter((w) => w.startsWith("invoices.voidInvoice"))).toHaveLength(1);
	});
});
