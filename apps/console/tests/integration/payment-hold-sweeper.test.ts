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
//        landed after the end, lists the rest without writing, and a re-run writes nothing new. ADR 0004
//        C43 (§9 step 5): B1 covers org-plan subscriptions too, so a linked create-a-team one is held as
//        an `org_plan` hold of its org.
//   C6   (ADR 0004 D1 rule 5) a due `org_plan` hold is advanced under `org-plan:<O>`; with that lease
//        held, the hold is skipped as busy and left unchanged.
//   C32  (ADR 0004 D8, the sender half) an `org_plan` hold in `refund_pending` is mailed once, to its
//        Stripe customer's email, in the org-plan copy (#6011); a `released(adopted)` `org_plan` hold is mailed nothing, even beside an
//        open create-a-team setup with no org naming its subscription.
//   C3   (ADR 0004, the link's half) the link's refusal beside a live Y meets an `org_plan` hold on X whose
//        payer key is the creator's id: it is not taken for the creator's own hold — no clause claims its
//        alert, and the refusal names no hold.
//   C91  (S9, §5.6 "When a hold ends") T2o adopts a `needs_operator` hold on a live X and the visit runs
//        the link's core: with an org, X is linked (`linked_at`, the row names X); with no org, or a
//        creator who lost `manage_billing`, the setup stays open. Beside a live Y the re-link opens a
//        `link_refused` hold that T2o never adopts (C80). `release` of a live X links it first.
//   #6043 the re-link's refusal after the sync (X's metadata already names O) whose lease is lost before
//        the hold opens: the lost lease is thrown, no hold is open, and the operator is alerted once.
//   C112 (#6078) a re-link that throws once is recorded (`attempts` 1, `last_error`, the 5-minute
//        backoff), is not retried before its check is due, and the relink pass links X once it is — with
//        no alert at all.
//   C113 a re-link that keeps throwing is retried on the backoff schedule and gives up at the sixth
//        attempt with ONE alert stamped in `alerted_at`, however many ticks follow and with two ticks
//        overlapping.
//   C114 the pass never retries a hold whose setup is already linked (no Stripe read), while an open
//        setup's due hold beside it is linked.
//   C115 a decided re-link (a creator without manage_billing) alerts ONCE across ticks and is not
//        retried: the check is cleared and `alerted_at` stamped.
//   C116 an adopted hold whose relink never ran (the release's own schedule, nothing recorded) is linked by
//        the next tick's pass.
//
// The link's core reaches Stripe through the purchase client (`getPurchaseStripe`), faked here over
// `linkWorld`; the sync applies X to the org's row with the real guarded write
// (`applySubscriptionToBilling`); and the sessionless manage_billing check answers `linkWorld.allowed`.
//
// Every tick here is scoped to the test's own payer (`payerKey`), so no other file's rows are touched.

import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";

/** What the link's core reads and writes in Stripe, and whether the creator holds manage_billing. */
const linkWorld = vi.hoisted(() => ({
	subs: new Map<string, { id: string; status: string; customer: string; latest_invoice: string; metadata: Record<string, string> }>(),
	updates: [] as string[],
	allowed: true,
	/** customer id → its Stripe email (C32's recipient). */
	customerEmails: new Map<string, string>(),
	/** Runs once at the start of the next sync, before it writes: the race a test stages (#6043). */
	onSync: null as null | (() => Promise<void>),
	/** How many of the next `subscriptions.retrieve` calls throw, as Stripe being down does (#6078). */
	retrieveFailures: 0,
	/** Every `subscriptions.retrieve` the link's core made. */
	retrieves: [] as string[],
}));
vi.mock("@/lib/billing/stripe", () => {
	const client = {
		subscriptions: {
			retrieve: async (id: string) => {
				linkWorld.retrieves.push(id);
				if (linkWorld.retrieveFailures > 0) {
					linkWorld.retrieveFailures -= 1;
					throw new Error("An error occurred with our connection to Stripe.");
				}
				const s = linkWorld.subs.get(id);
				if (!s) throw Object.assign(new Error(`No such subscription: ${id}`), { code: "resource_missing" });
				return { ...s, metadata: { ...s.metadata } };
			},
			update: async (id: string, params: { metadata: Record<string, string> }) => {
				const s = linkWorld.subs.get(id);
				if (!s) throw new Error(`No such subscription: ${id}`);
				linkWorld.updates.push(`subscriptions.update:${id}`);
				s.metadata = { ...s.metadata, ...params.metadata };
				return { ...s, metadata: { ...s.metadata } };
			},
		},
		customers: {
			retrieve: async (id: string) => {
				const owner = [...linkWorld.subs.values()].find((s) => s.customer === id)?.metadata.created_by;
				return { id, deleted: false, email: linkWorld.customerEmails.get(id) ?? null, metadata: { created_by: owner ?? "" } };
			},
			update: async (id: string) => {
				linkWorld.updates.push(`customers.update:${id}`);
				return { id };
			},
		},
	};
	return { getStripe: () => client, getPurchaseStripe: () => client, STRIPE_REQUEST_TIMEOUT_MS: 20_000, STRIPE_MAX_NETWORK_RETRIES: 1 };
});
vi.mock("@/lib/billing/sync", async (importActual) => {
	const actual = await importActual<typeof import("@/lib/billing/sync")>();
	// `applySubscriptionToBilling` is this file's own import (below), read when a sync runs, not here.
	return {
		...actual,
		syncSubscriptionToBilling: async (sub: { id: string; status: string; customer: string; metadata: Record<string, string> }) => {
			const race = linkWorld.onSync;
			linkWorld.onSync = null;
			await race?.();
			const orgId = sub.metadata.organization_id;
			if (!orgId) return "ignored";
			const live = sub.status === "active" || sub.status === "trialing";
			const applied = await applySubscriptionToBilling({
				organizationId: orgId,
				plan: live ? "team" : "community",
				status: actual.mapStatus(sub.status),
				stripeCustomerId: sub.customer,
				stripeSubscriptionId: sub.id,
				seats: null,
				currentPeriodEnd: null,
				eventAt: null,
			});
			return applied ? "applied" : "ignored";
		},
	};
});
// The Q3 email's transport: C32 runs the real sender (`deliverHoldNotice`) and reads who it mailed.
vi.mock("@/lib/email/billing-email", async (importActual) => ({
	...(await importActual<typeof import("@/lib/email/billing-email")>()),
	sendPaymentHoldNoticeEmail: vi.fn(async () => undefined),
	sendOrgPlanHoldNoticeEmail: vi.fn(async () => undefined),
}));
// The operator alert the link's core raises itself (`alertPaymentNeedsSupport`, not the sweep's `alert`
// dep): recorded here, and answering false as the real one does with no operator org configured.
vi.mock("@/lib/billing/payment-alert", () => ({ alertPaymentNeedsSupport: vi.fn(async () => false) }));
vi.mock("@/lib/auth/scope", () => ({
	getActiveScope: async (userId: string, orgId?: string) => ({ userId, orgId: orgId ?? userId }),
}));
vi.mock("@/lib/authz", async (importActual) => {
	const actual = await importActual<typeof import("@/lib/authz")>();
	return { ...actual, getPdp: () => ({ can: async () => ({ allowed: linkWorld.allowed }) }) };
});

import { alertPaymentNeedsSupport } from "@/lib/billing/payment-alert";
import { HOLD_REFUND_METADATA_KEY } from "@/lib/billing/payment-holds/observe";
import * as store from "@/lib/billing/payment-holds/store";
import { deliverHoldNotice } from "@/lib/billing/payment-holds/emails";
import { nudgeHold, openHold } from "@/lib/billing/payment-holds/store";
import { sendOrgPlanHoldNoticeEmail, sendPaymentHoldNoticeEmail } from "@/lib/email/billing-email";
import * as sweeper from "@/lib/billing/payment-holds/sweeper";
import { runPaymentHoldSweep, type SweepDeps } from "@/lib/billing/payment-holds/sweeper";
import {
	acquirePurchaseLease,
	PurchaseLeaseLostError,
	releasePurchaseLease,
	tryAcquirePurchaseLease,
} from "@/lib/billing/purchase-lease";
import { getServiceDb } from "@/lib/db";
import { applySubscriptionToBilling } from "@/lib/billing/queries";
import {
	member,
	organization,
	organizationBilling,
	type PaymentHoldRow,
	paymentHolds,
	pendingOrgSetups,
	purchaseLeases,
	user,
} from "@/lib/db/schema";
import { listLiveOrgHasPlanClosures, releaseHoldCommand, runBackfill, type ServerDeps } from "@/scripts/payment-holds";
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

/** A create-a-team payer's lease key, written out rather than derived from the code under test. */
function payerLeaseKey(payer: string): string {
	return `user:${payer}`;
}

/** An org's org-plan lease key (ADR 0004 §2 "Lease key"), written out for the same reason. */
function orgPlanLeaseKey(orgId: string): string {
	return `org-plan:${orgId}`;
}

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

/** Opens an `org_plan` hold for the org `org` on `sub` (E0, `closing`), under its org-plan lease. */
async function orgPlanHold(org: string, sub: string, over: Partial<typeof paymentHolds.$inferInsert> = {}): Promise<PaymentHoldRow> {
	const lease = await tryAcquirePurchaseLease(orgPlanLeaseKey(org));
	if (!lease) throw new Error("fixture: the org's lease was not free");
	const opened = await openHold(lease, {
		scope: "org_plan",
		subscriptionId: sub,
		customerId: `cus_${sub}`,
		payerKey: org,
		invoiceId: `in_${sub}`,
		state: "closing",
		nextCheckAt: new Date(Date.now() - 1000),
		openedBy: "purchase",
	});
	await releasePurchaseLease(lease);
	if (opened.kind !== "opened") throw new Error(`fixture: the open returned ${opened.kind}`);
	if (Object.keys(over).length === 0) return opened.hold;
	const [row] = await getServiceDb().update(paymentHolds).set(over).where(eq(paymentHolds.id, opened.hold.id)).returning();
	if (!row) throw new Error("fixture: the hold is gone");
	return row;
}

const orgs: string[] = [];

/** A team org owned by `owner` (a setup's `created_org_id` needs one), cleaned up after the file. */
async function newOrg(owner: string): Promise<string> {
	const id = randomUUID();
	orgs.push(id);
	await getServiceDb().insert(organization).values({ id, name: "Relinked", slug: `it-relink-${id.slice(0, 8)}` });
	await getServiceDb().insert(member).values({ organizationId: id, userId: owner, role: "owner" });
	return id;
}

/** Records `payer`'s OPEN create-a-team setup for `sub`, created for the team `orgId`. */
async function recordSetupWithOrg(payer: string, sub: string, orgId: string): Promise<void> {
	await getServiceDb().insert(pendingOrgSetups).values({
		user_id: payer,
		subscription_id: sub,
		customer_id: "cus_it_sweep",
		intended_name: "Held",
		intended_slug: `held-${sub.slice(-8)}`,
		created_org_id: orgId,
	});
}

/** The setup of `sub` as the database has it now. */
async function setupOf(sub: string) {
	const [row] = await getServiceDb().select().from(pendingOrgSetups).where(eq(pendingOrgSetups.subscription_id, sub));
	if (!row) throw new Error(`no setup names ${sub}`);
	return row;
}

/**
 * Puts X, live and minted by `payer`, in both fakes: the machine's (status only) and the core's. X's
 * customer is its own, as a create-a-team customer is: the link syncs X to its team's row, and
 * `organization_billing.stripe_customer_id` is unique across teams.
 */
function liveX(stripe: FakeStripe, payer: string, sub: string): void {
	stripe.add({ id: sub, status: "active", customer: `cus_${sub}`, metadata: { created_by: payer } }, { status: "paid", pis: [] });
	linkWorld.subs.set(sub, { id: sub, status: "active", customer: `cus_${sub}`, latest_invoice: `in_${sub}`, metadata: { created_by: payer } });
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
		await db.delete(purchaseLeases).where(inArray(purchaseLeases.key, payers.map(orgPlanLeaseKey)));
	}
	if (orgs.length) {
		await db.delete(pendingOrgSetups).where(inArray(pendingOrgSetups.created_org_id, orgs));
		await db.delete(organizationBilling).where(inArray(organizationBilling.organizationId, orgs));
		await db.delete(organization).where(inArray(organization.id, orgs));
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

// ── ADR 0004 D1 rule 5 and D8: the sweeper and the sender per scope ─────────────────────────────────

describeIfDb("payment-hold sweeper — ADR 0004 C6: an org_plan hold is advanced under org-plan:<O>", () => {
	it("advances a due org_plan hold under the org's lease; with that lease held it is busy and unchanged", async () => {
		const stripe = new FakeStripe();
		const org = newPayer();
		const sub = newSub();
		stripe.add({ id: sub, customer: `cus_${sub}`, metadata: { organization_id: org } });
		const h = await orgPlanHold(org, sub);

		const held = await tryAcquirePurchaseLease(orgPlanLeaseKey(org));
		if (!held) throw new Error("fixture: the org's lease was not free");
		try {
			expect(await runPaymentHoldSweep({ scope: "org_plan", payerKey: org, deps: depsOver(stripe) })).toMatchObject({
				due: 1,
				advanced: 0,
				busy: 1,
			});
			expect(await read(h.id)).toMatchObject({ state: "closing", version: 0 });
			expect(stripe.writesFor(sub)).toEqual([]);
		} finally {
			await releasePurchaseLease(held);
		}

		// A user lease keyed on the same id is no lease of this hold's: the tick takes the org's.
		const userKeyed = await tryAcquirePurchaseLease(payerLeaseKey(org));
		if (!userKeyed) throw new Error("fixture: the user-keyed lease was not free");
		try {
			expect(await runPaymentHoldSweep({ scope: "org_plan", payerKey: org, deps: depsOver(stripe) })).toMatchObject({
				due: 1,
				advanced: 1,
				released: 1,
			});
		} finally {
			await releasePurchaseLease(userKeyed);
		}
		expect(await read(h.id)).toMatchObject({ state: "released", release_reason: "voided_unpaid" });
		expect(stripe.writesFor(sub)).toEqual([
			`invoices.voidInvoice:in_${sub}`,
			`subscriptions.cancel:${sub}:alethia:checkout_closed:${h.id}`,
		]);
	});

	it("a scoped tick selects only that scope's holds", async () => {
		const stripe = new FakeStripe();
		const shared = newPayer();
		const orgSub = newSub();
		const userSub = newSub();
		stripe.add({ id: orgSub, customer: `cus_${orgSub}`, metadata: { organization_id: shared } });
		stripe.add({ id: userSub });
		const orgHold = await orgPlanHold(shared, orgSub);
		const userHold = await hold(shared, userSub);
		expect(await runPaymentHoldSweep({ scope: "new_org", payerKey: shared, deps: depsOver(stripe) })).toMatchObject({ due: 1, released: 1 });
		expect(await read(userHold.id)).toMatchObject({ state: "released" });
		expect(await read(orgHold.id)).toMatchObject({ state: "closing", version: 0 });
	});
});

describeIfDb("payment-hold sweeper — ADR 0004 C32, the sender half: an org_plan notice goes to the customer's email", () => {
	afterEach(() => {
		vi.mocked(sendPaymentHoldNoticeEmail).mockClear();
		vi.mocked(sendOrgPlanHoldNoticeEmail).mockClear();
		linkWorld.customerEmails.clear();
	});

	/** Sweep deps that send through the real sender. */
	const realSender = (stripe: FakeStripe): SweepDeps => ({ ...depsOver(stripe), deliver: deliverHoldNotice });

	it("refund_pending is mailed ONCE, to the Stripe customer's email, in the org-plan copy", async () => {
		const stripe = new FakeStripe();
		const org = newPayer();
		const sub = newSub();
		linkWorld.customerEmails.set(`cus_${sub}`, "billing@team.example");
		const h = await orgPlanHold(org, sub, { state: "refund_pending", next_check_at: new Date(Date.now() + HOUR) });
		expect((await runPaymentHoldSweep({ scope: "org_plan", payerKey: org, deps: realSender(stripe) })).notices).toBe(1);
		expect((await runPaymentHoldSweep({ scope: "org_plan", payerKey: org, deps: realSender(stripe) })).notices).toBe(0);
		expect(vi.mocked(sendOrgPlanHoldNoticeEmail).mock.calls).toEqual([[{ to: "billing@team.example", notice: "refund_pending" }]]);
		expect(sendPaymentHoldNoticeEmail).not.toHaveBeenCalled();
		expect(await read(h.id)).toMatchObject({ notified_state: "refund_pending" });
	});

	it("released(adopted) is mailed nothing, even beside an open setup with no org naming its subscription", async () => {
		const stripe = new FakeStripe();
		const org = newPayer();
		const creator = await newUser();
		const sub = newSub();
		linkWorld.customerEmails.set(`cus_${sub}`, "billing@team.example");
		await recordSetup(creator, sub);
		const h = await orgPlanHold(org, sub, { state: "released", release_reason: "adopted", released_at: new Date(), next_check_at: null });
		expect((await runPaymentHoldSweep({ scope: "org_plan", payerKey: org, deps: realSender(stripe) })).notices).toBe(0);
		expect(sendPaymentHoldNoticeEmail).not.toHaveBeenCalled();
		expect(sendOrgPlanHoldNoticeEmail).not.toHaveBeenCalled();
		expect(await read(h.id)).toMatchObject({ notified_state: null });
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

// ── C91, C80: an adoption re-links its setup (§5.6 "When a hold ends", S9) ───────────────────────────

describeIfDb("payment-hold sweeper — C91: an adopted hold's setup is re-linked under the same lease", () => {
	afterEach(() => {
		linkWorld.subs.clear();
		linkWorld.updates = [];
		linkWorld.allowed = true;
	});

	it("T2o adopts a needs_operator hold on a live X, and with an org the core links X: linked_at set, the row names X", async () => {
		const stripe = new FakeStripe();
		const payer = await newUser();
		const sub = newSub();
		const orgId = await newOrg(payer);
		liveX(stripe, payer, sub);
		await recordSetupWithOrg(payer, sub, orgId);
		const h = await hold(payer, sub, { state: "needs_operator" });

		expect(await tick(payer, stripe)).toMatchObject({ advanced: 1, released: 1 });
		expect(await read(h.id)).toMatchObject({ state: "released", release_reason: "adopted" });
		expect(linkWorld.updates).toEqual([`customers.update:cus_${sub}`, `subscriptions.update:${sub}`]);
		expect(linkWorld.subs.get(sub)?.metadata).toEqual({ created_by: payer, organization_id: orgId });
		expect(await setupOf(sub)).toMatchObject({ closed_at: null, linked_at: expect.any(Date) });
		const [row] = await getServiceDb().select().from(organizationBilling).where(eq(organizationBilling.organizationId, orgId));
		expect(row).toMatchObject({ stripeSubscriptionId: sub, status: "active" });
	});

	it("with no org the setup stays open and nothing is written to Stripe", async () => {
		const stripe = new FakeStripe();
		const payer = await newUser();
		const sub = newSub();
		liveX(stripe, payer, sub);
		await recordSetup(payer, sub);
		const h = await hold(payer, sub, { state: "needs_operator" });

		expect(await tick(payer, stripe)).toMatchObject({ released: 1 });
		expect(await read(h.id)).toMatchObject({ release_reason: "adopted" });
		expect(linkWorld.updates).toEqual([]);
		expect(await setupOf(sub)).toMatchObject({ closed_at: null, linked_at: null });
	});

	it("a creator who no longer holds manage_billing gets no link: an alert with X as the subject, the setup open", async () => {
		const stripe = new FakeStripe();
		const payer = await newUser();
		const sub = newSub();
		const orgId = await newOrg(payer);
		liveX(stripe, payer, sub);
		await recordSetupWithOrg(payer, sub, orgId);
		await hold(payer, sub, { state: "needs_operator" });
		linkWorld.allowed = false;

		await tick(payer, stripe);
		expect(linkWorld.updates).toEqual([]);
		expect(await setupOf(sub)).toMatchObject({ closed_at: null, linked_at: null });
		expect(alert.mock.calls.some((c) => c[0].subscriptionId === sub && /manage_billing/.test(c[0].detail))).toBe(true);
	});

	it("BLOCKER: a creator removed from the recorded team is not linked — an alert, the setup open, and `release` names why", async () => {
		const stripe = new FakeStripe();
		const payer = await newUser();
		const sub = newSub();
		const orgId = await newOrg(payer);
		const other = await newUser();
		await getServiceDb().insert(member).values({ organizationId: orgId, userId: other, role: "owner" });
		await getServiceDb().delete(member).where(and(eq(member.organizationId, orgId), eq(member.userId, payer)));
		liveX(stripe, payer, sub);
		await recordSetupWithOrg(payer, sub, orgId);
		await hold(payer, sub, { state: "needs_operator" });

		await tick(payer, stripe);
		expect(linkWorld.updates).toEqual([]);
		expect(await setupOf(sub)).toMatchObject({ closed_at: null, linked_at: null });
		expect(alert.mock.calls.some((c) => c[0].subscriptionId === sub && /no longer an active member/.test(c[0].detail))).toBe(true);
	});

	it("a team deleted before the visit reads as no org (created_org_id is ON DELETE SET NULL): the setup stays open and the Q3 email is owed", async () => {
		const stripe = new FakeStripe();
		const payer = await newUser();
		const sub = newSub();
		const orgId = await newOrg(payer);
		liveX(stripe, payer, sub);
		await recordSetupWithOrg(payer, sub, orgId);
		const h = await hold(payer, sub, { state: "needs_operator" });
		await getServiceDb().delete(organization).where(eq(organization.id, orgId));

		await tick(payer, stripe);
		expect(await read(h.id)).toMatchObject({ release_reason: "adopted" });
		expect(linkWorld.updates).toEqual([]);
		expect(await setupOf(sub)).toMatchObject({ created_org_id: null, closed_at: null, linked_at: null });
		expect(deliver.mock.calls.map((c) => [c[0].id, c[1]])).toContainEqual([h.id, "released:adopted"]);
	});

	it("advisory 6: a team with NO members is never repaired by the sweeper — no member row is written, no link, an alert", async () => {
		const stripe = new FakeStripe();
		const payer = await newUser();
		const sub = newSub();
		const orgId = await newOrg(payer);
		await getServiceDb().delete(member).where(eq(member.organizationId, orgId));
		liveX(stripe, payer, sub);
		await recordSetupWithOrg(payer, sub, orgId);
		await hold(payer, sub, { state: "needs_operator" });

		await tick(payer, stripe);
		const members = await getServiceDb().select().from(member).where(eq(member.organizationId, orgId));
		expect(members).toEqual([]);
		expect(linkWorld.updates).toEqual([]);
		expect(await setupOf(sub)).toMatchObject({ closed_at: null, linked_at: null });
		expect(alert.mock.calls.some((c) => c[0].subscriptionId === sub && /has no members/.test(c[0].detail))).toBe(true);
	});

	it("C3: an org_plan hold on X whose payer key EQUALS the creator's id is not taken for the creator's hold", async () => {
		const stripe = new FakeStripe();
		const payer = await newUser();
		const sub = newSub();
		const orgId = await newOrg(payer);
		await applySubscriptionToBilling({
			organizationId: orgId,
			plan: "team",
			status: "active",
			stripeCustomerId: `cus_${sub}_y`,
			stripeSubscriptionId: `${sub}_y`,
			seats: null,
			currentPeriodEnd: null,
			eventAt: null,
		});
		liveX(stripe, payer, sub);
		await recordSetupWithOrg(payer, sub, orgId);
		// An org_plan hold on X, alerted in its current entry, whose payer key is the same string as the
		// creator's user id.
		const orgHold = await orgPlanHold(payer, sub, { state: "needs_operator", alerted_at: new Date(Date.now() + 1000) });

		const lease = await tryAcquirePurchaseLease(payerLeaseKey(payer));
		if (!lease) throw new Error("fixture: the creator's lease was not free");
		try {
			const result = await sweeper.relinkAdoptedSetup(lease, orgHold, alert);
			expect(result).toMatchObject({ kind: "refused", hold: null });
			if (result.kind !== "refused") throw new Error("expected a refusal");
			expect(result.clause).not.toContain(sweeper.LINK_REFUSED_ALERTED.trim());
		} finally {
			await releasePurchaseLease(lease);
		}
		// Nothing new was opened beside it, and the org's hold is untouched.
		const open = await getServiceDb()
			.select()
			.from(paymentHolds)
			.where(sql`${paymentHolds.subscription_id} = ${sub} AND ${paymentHolds.state} <> 'released'`);
		expect(open.map((h) => [h.id, h.scope, h.version])).toEqual([[orgHold.id, "org_plan", orgHold.version]]);
	});

	it("C80: beside a live Y the re-link opens a link_refused hold and leaves the setup open (refused_reason), and T2o never adopts it", async () => {
		const stripe = new FakeStripe();
		const payer = await newUser();
		const sub = newSub();
		const orgId = await newOrg(payer);
		await applySubscriptionToBilling({
			organizationId: orgId,
			plan: "team",
			status: "active",
			stripeCustomerId: `cus_${sub}_y`,
			stripeSubscriptionId: `${sub}_y`,
			seats: null,
			currentPeriodEnd: null,
			eventAt: null,
		});
		liveX(stripe, payer, sub);
		await recordSetupWithOrg(payer, sub, orgId);
		await hold(payer, sub, { state: "needs_operator" });

		await tick(payer, stripe);
		const [refusedHold] = await getServiceDb()
			.select()
			.from(paymentHolds)
			.where(sql`${paymentHolds.subscription_id} = ${sub} AND ${paymentHolds.state} <> 'released'`);
		expect(refusedHold).toMatchObject({ state: "needs_operator", open_note: "link_refused", opened_by: "link", payer_key: payer });
		expect(await setupOf(sub)).toMatchObject({ closed_at: null, linked_at: null, refused_reason: "org_has_plan" });
		expect(linkWorld.updates).toEqual([]);

		if (!refusedHold) throw new Error("no hold");
		await makeDue(refusedHold.id);
		await tick(payer, stripe);
		expect(await read(refusedHold.id)).toMatchObject({ state: "needs_operator" });
	});

	it("#6043: Y takes the row during the re-link's sync and the payer's lease is lost before the hold opens — the lost lease is thrown, no hold, and the operator is alerted once naming X and O", async () => {
		const payer = await newUser();
		const sub = newSub();
		const orgId = await newOrg(payer);
		liveX(new FakeStripe(), payer, sub);
		await recordSetupWithOrg(payer, sub, orgId);
		// Inside the sync, after X's metadata write: Y takes O's row, and the lease's row expires (another
		// caller may now take it), so the hold's FOR SHARE read of the lease finds nothing.
		linkWorld.onSync = async () => {
			await applySubscriptionToBilling({
				organizationId: orgId,
				plan: "team",
				status: "active",
				stripeCustomerId: `cus_${sub}_y`,
				stripeSubscriptionId: `${sub}_y`,
				seats: null,
				currentPeriodEnd: null,
				eventAt: null,
			});
			await getServiceDb()
				.update(purchaseLeases)
				.set({ expires_at: new Date(Date.now() - 1000) })
				.where(eq(purchaseLeases.key, payerLeaseKey(payer)));
		};

		const lease = await tryAcquirePurchaseLease(payerLeaseKey(payer));
		if (!lease) throw new Error("fixture: the creator's lease was not free");
		try {
			await expect(sweeper.relinkAdoptedSetup(lease, { payer_key: payer, subscription_id: sub, customer_id: `cus_${sub}` }, alert)).rejects.toBeInstanceOf(PurchaseLeaseLostError);
		} finally {
			await releasePurchaseLease(lease);
		}

		// X's metadata names O, and nothing records the refusal in the database: no open hold, the setup
		// neither refused nor linked.
		expect(linkWorld.subs.get(sub)?.metadata.organization_id).toBe(orgId);
		const open = await getServiceDb()
			.select()
			.from(paymentHolds)
			.where(sql`${paymentHolds.subscription_id} = ${sub} AND ${paymentHolds.state} <> 'released'`);
		expect(open).toEqual([]);
		expect(await setupOf(sub)).toMatchObject({ closed_at: null, linked_at: null, refused_reason: null });
		// So the operator is told at once, about X, naming O.
		const raised = vi.mocked(alertPaymentNeedsSupport).mock.calls.map((c) => c[0]).filter((a) => a.subscriptionId === sub);
		expect(raised).toHaveLength(1);
		expect(raised[0]).toMatchObject({ context: "link_refused", customerId: `cus_${sub}` });
		expect(raised[0]?.detail).toContain(`team ${orgId}`);
	});

	it("§5.4: `release` of a live X whose setup has an org links it FIRST, then releases; beside a live Y it refuses and releases nothing", async () => {
		const stripe = new FakeStripe();
		const payer = await newUser();
		const sub = newSub();
		const orgId = await newOrg(payer);
		liveX(stripe, payer, sub);
		await recordSetupWithOrg(payer, sub, orgId);
		const h = await hold(payer, sub, { state: "needs_operator", open_note: "link_refused" });
		const args = { subscriptionId: sub, reason: "Y refunded by hand", operator: "op-it" };
		const quiet = () => undefined;

		await applySubscriptionToBilling({
			organizationId: orgId,
			plan: "team",
			status: "active",
			stripeCustomerId: `cus_${sub}_y`,
			stripeSubscriptionId: `${sub}_y`,
			seats: null,
			currentPeriodEnd: null,
			eventAt: null,
		});
		expect(await releaseHoldCommand(args, serverDeps(stripe), quiet)).toMatchObject({ kind: "refused" });
		expect(await read(h.id)).toMatchObject({ state: "needs_operator" });
		expect(await setupOf(sub)).toMatchObject({ closed_at: null, linked_at: null });

		// The operator cancels Y; the row no longer holds a live plan.
		await getServiceDb().update(organizationBilling).set({ status: "canceled" }).where(eq(organizationBilling.organizationId, orgId));
		expect(await releaseHoldCommand(args, serverDeps(stripe), quiet)).toMatchObject({ kind: "released" });
		expect(await read(h.id)).toMatchObject({ state: "released", release_reason: "operator" });
		expect(await setupOf(sub)).toMatchObject({ closed_at: null, linked_at: expect.any(Date) });
		expect(linkWorld.subs.get(sub)?.metadata.organization_id).toBe(orgId);
	});
});

// ── §8: the S1-era closures ─────────────────────────────────────────────────────────────────────────

// ── #6078: the relink of an adopted hold is retried (§4.1 amendment 2026-10-14) ────────────────────────

describeIfDb("payment-hold sweeper — #6078: a failed re-link is retried with backoff, then alerted once", () => {
	beforeEach(() => {
		linkWorld.retrieves = [];
	});

	afterEach(() => {
		linkWorld.subs.clear();
		linkWorld.updates = [];
		linkWorld.allowed = true;
		linkWorld.retrieveFailures = 0;
		linkWorld.retrieves = [];
	});

	/** The sweep alerts raised with `sub` as the subject. */
	function alertsOn(sub: string) {
		return alert.mock.calls.map((c) => c[0]).filter((a) => a.subscriptionId === sub);
	}

	/** Milliseconds from now until `at`. */
	function msUntil(at: Date | null): number {
		if (!at) throw new Error("expected a scheduled relink check");
		return at.getTime() - Date.now();
	}

	/** A live X with an org, its open setup, and an open needs_operator hold the next tick adopts. */
	async function adoptable(stripe: FakeStripe) {
		const payer = await newUser();
		const sub = newSub();
		const orgId = await newOrg(payer);
		liveX(stripe, payer, sub);
		await recordSetupWithOrg(payer, sub, orgId);
		const h = await hold(payer, sub, { state: "needs_operator" });
		return { payer, sub, orgId, h };
	}

	it("C112: a re-link that throws once is recorded, waits for its backoff, and the relink pass links X — no alert", async () => {
		const stripe = new FakeStripe();
		const { payer, sub, orgId, h } = await adoptable(stripe);
		linkWorld.retrieveFailures = 1;

		expect(await tick(payer, stripe)).toMatchObject({ released: 1 });
		const failed = await read(h.id);
		expect(failed).toMatchObject({ state: "released", release_reason: "adopted", attempts: 1 });
		expect(failed.last_error).toMatch(/connection to Stripe/);
		expect(msUntil(failed.next_check_at)).toBeGreaterThan(4 * 60_000);
		expect(msUntil(failed.next_check_at)).toBeLessThanOrEqual(5 * 60_000);
		expect(await setupOf(sub)).toMatchObject({ linked_at: null, closed_at: null });
		expect(alertsOn(sub)).toEqual([]);

		// Not due yet: the next tick does not touch it.
		await tick(payer, stripe);
		expect(linkWorld.retrieves).toEqual([sub]);

		await makeDue(h.id);
		await tick(payer, stripe);
		expect(await setupOf(sub)).toMatchObject({ closed_at: null, linked_at: expect.any(Date) });
		expect(linkWorld.subs.get(sub)?.metadata).toEqual({ created_by: payer, organization_id: orgId });
		expect(await read(h.id)).toMatchObject({ next_check_at: null, attempts: 1 });
		expect(alertsOn(sub)).toEqual([]);
		expect(vi.mocked(alertPaymentNeedsSupport).mock.calls.filter((c) => c[0].subscriptionId === sub)).toEqual([]);
	});

	it("C113: a re-link that keeps throwing is retried on the backoff schedule, then ONE alert, across ticks and overlapping ticks", async () => {
		const stripe = new FakeStripe();
		const { payer, sub, h } = await adoptable(stripe);
		linkWorld.retrieveFailures = 1_000;
		const delays = [5, 15, 60, 240, 720].map((m) => m * 60_000);

		await tick(payer, stripe);
		for (let attempt = 1; attempt <= 5; attempt += 1) {
			const row = await read(h.id);
			expect(row.attempts).toBe(attempt);
			const delay = delays[attempt - 1] ?? 0;
			expect(msUntil(row.next_check_at)).toBeGreaterThan(delay - 60_000);
			expect(msUntil(row.next_check_at)).toBeLessThanOrEqual(delay);
			expect(alertsOn(sub)).toEqual([]);
			await makeDue(h.id);
			if (attempt === 5) {
				// The sixth attempt, from two ticks at once (two instances): the payer's lease admits one.
				await Promise.all([tick(payer, stripe), tick(payer, stripe)]);
			} else {
				await tick(payer, stripe);
			}
		}

		const gaveUp = await read(h.id);
		expect(gaveUp).toMatchObject({ attempts: 6, next_check_at: null });
		expect(gaveUp.alerted_at).toBeInstanceOf(Date);
		expect(linkWorld.retrieves).toHaveLength(6);
		const alerts = alertsOn(sub);
		expect(alerts).toHaveLength(1);
		expect(alerts[0]?.detail).toMatch(/failed 6 times/);

		// Nothing retries it again, and nothing alerts again.
		await tick(payer, stripe);
		await tick(payer, stripe);
		expect(linkWorld.retrieves).toHaveLength(6);
		expect(alertsOn(sub)).toHaveLength(1);
		expect(await setupOf(sub)).toMatchObject({ linked_at: null, closed_at: null });
	});

	it("C114: no retry for a hold whose setup is already linked, while an open setup's due hold beside it is linked", async () => {
		const stripe = new FakeStripe();
		const linked = await adoptable(stripe);
		const open = await adoptable(stripe);
		linkWorld.retrieveFailures = 2;
		await tick(linked.payer, stripe);
		await tick(open.payer, stripe);
		expect(linkWorld.retrieves).toEqual([linked.sub, open.sub]);
		// The first setup is linked by another path (the creator's own link), and both checks fall due.
		await getServiceDb().update(pendingOrgSetups).set({ linked_at: new Date() }).where(eq(pendingOrgSetups.subscription_id, linked.sub));
		await makeDue(linked.h.id);
		await makeDue(open.h.id);

		await tick(linked.payer, stripe);
		await tick(open.payer, stripe);
		expect(linkWorld.retrieves).toEqual([linked.sub, open.sub, open.sub]);
		expect(linkWorld.updates).toEqual([`customers.update:cus_${open.sub}`, `subscriptions.update:${open.sub}`]);
		expect(await read(linked.h.id)).toMatchObject({ attempts: 1 });
		expect(await setupOf(open.sub)).toMatchObject({ linked_at: expect.any(Date) });
		expect(alertsOn(linked.sub)).toEqual([]);
	});

	it("C115: a creator without manage_billing is decided: ONE alert across ticks, the check cleared, no retry", async () => {
		const stripe = new FakeStripe();
		const { payer, sub, h } = await adoptable(stripe);
		linkWorld.allowed = false;

		await tick(payer, stripe);
		const decided = await read(h.id);
		await tick(payer, stripe);
		await tick(payer, stripe);

		expect(decided.alerted_at).toBeInstanceOf(Date);
		expect(decided.last_error).toMatch(/manage_billing/);
		expect(alertsOn(sub)).toHaveLength(1);
		expect(alertsOn(sub)[0]?.detail).toMatch(/manage_billing/);
		expect(linkWorld.updates).toEqual([]);
		expect(await setupOf(sub)).toMatchObject({ linked_at: null, closed_at: null });
	});

	it("C116: an adopted hold whose relink never ran is linked by the next tick's pass", async () => {
		const stripe = new FakeStripe();
		const { payer, sub, h } = await adoptable(stripe);
		// The release ran (as T2o writes it) and the process stopped before its relink: nothing recorded.
		const lease = await tryAcquirePurchaseLease(payerLeaseKey(payer));
		if (!lease) throw new Error("fixture: the payer's lease was not free");
		const released = await store.releaseHold(lease, { id: h.id, version: h.version }, { reason: "adopted" });
		await releasePurchaseLease(lease);
		expect(released?.hold.next_check_at).toBeInstanceOf(Date);

		await tick(payer, stripe);
		expect(await setupOf(sub)).toMatchObject({ linked_at: expect.any(Date) });
		expect(await read(h.id)).toMatchObject({ next_check_at: null });
		expect(alertsOn(sub)).toEqual([]);
	});
});

describeIfDb("payment-holds reconcile --backfill — §8: the S1-era org_has_plan closures whose X is live", () => {
	it("prints each such setup whose subscription reads live, skips an ended one, and writes nothing", async () => {
		const stripe = new FakeStripe();
		const payer = await newUser();
		const live = newSub();
		const ended = newSub();
		stripe.add({ id: live, status: "active" });
		stripe.add({ id: ended, status: "canceled" });
		for (const sub of [live, ended]) {
			await recordSetup(payer, sub);
			await getServiceDb()
				.update(pendingOrgSetups)
				.set({ closed_at: new Date(), closed_reason: "org_has_plan", refused_reason: "org_has_plan" })
				.where(eq(pendingOrgSetups.subscription_id, sub));
		}
		const printed: string[] = [];

		await listLiveOrgHasPlanClosures(stripe, (line) => printed.push(line));

		expect(printed.some((l) => l.startsWith(`S1-ERA ${live}: reads active`) && l.includes(`user ${payer}`))).toBe(true);
		expect(printed.some((l) => l.includes(ended))).toBe(false);
		expect(stripe.log).toEqual([]);
		const held = await getServiceDb().select().from(paymentHolds).where(inArray(paymentHolds.subscription_id, [live, ended]));
		expect(held).toEqual([]);
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
		const orgId = randomUUID();
		const aiOwned = newSub();
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
			metadata: { created_by: payer, organization_id: orgId },
			cancellation_details: requested,
		});
		// An AI subscription of the same org, built like `orgOwned` (an open invoice, no payment), which B2–B6
		// would hold for an operator. Only B1 keeps it out: it is not covered on both runs, and no hold names it.
		stripe.add({
			id: aiOwned,
			status: "canceled",
			ended_at: 1000,
			metadata: { organization_id: orgId, product_type: "ai_subscription" },
			cancellation_details: requested,
		});
		const printed: string[] = [];
		const print = (line: string) => {
			printed.push(line);
		};

		const first = await runBackfill(serverDeps(stripe), stripe, print);
		// ADR 0004 §9 step 5 (C43): a linked create-a-team subscription carries `organization_id`, so it is an
		// org-plan subscription of that org. Its open invoice has no PaymentIntent, so B5 proves nothing: it
		// is held as `org_plan` for an operator, never advanced.
		expect(first).toEqual({ held: 2, toOperator: 1, listed: 2, alreadyHeld: 0, notCovered: 1 });

		const rows = await getServiceDb()
			.select()
			.from(paymentHolds)
			.where(inArray(paymentHolds.subscription_id, [neverPaid, paidAfter, paidBefore, bankDebit, orgOwned, aiOwned]));
		const bySub = new Map(rows.map((r) => [r.subscription_id, r]));
		expect(rows).toHaveLength(3);
		expect(bySub.get(orgOwned)).toMatchObject({
			scope: "org_plan",
			payer_key: orgId,
			state: "needs_operator",
			opened_by: "backfill",
			open_note: expect.stringMatching(new RegExp(`^backfill: B1 org-plan subscription of ${orgId}; .*B5 unproven`)),
		});
		expect(bySub.get(orgOwned)?.alerted_at).not.toBeNull();
		expect(alert.mock.calls.filter((c) => c[0].subscriptionId === orgOwned)).toHaveLength(1);
		expect(stripe.writesFor(orgOwned)).toEqual([]);
		expect(bySub.has(aiOwned)).toBe(false);
		expect(stripe.writesFor(aiOwned)).toEqual([]);
		expect(printed.some((l) => l.includes(aiOwned))).toBe(false);
		expect(bySub.get(neverPaid)).toMatchObject({
			state: "released",
			release_reason: "voided_unpaid",
			opened_by: "backfill",
			scope: "new_org",
			payer_key: payer,
			invoice_id: `in_${neverPaid}`,
			open_note: expect.stringMatching(new RegExp(`^backfill: B1 create-a-team subscription of ${payer}; B2 canceled`)),
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
		expect(second).toEqual({ held: 0, toOperator: 0, listed: 2, alreadyHeld: 3, notCovered: 1 });
		expect(stripe.log.length).toBe(writesBefore);
		const [after] = await getServiceDb()
			.select({ count: sql<number>`count(*)::int` })
			.from(paymentHolds)
			.where(inArray(paymentHolds.subscription_id, [neverPaid, paidAfter, paidBefore, bankDebit, orgOwned, aiOwned]));
		expect(after?.count).toBe(3);
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
