// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The Stripe event dispatcher's half of #5514, and of ADR 0004 D4 and D6 (the W cases of §7).
//
// #5514: the row-level guard lives in the database write (tests/integration/billing-sync.test.ts proves
// it against real Postgres); what the first block pins is that the dispatcher FEEDS that guard — every
// subscription sync carries the event's own `created` time — and that a deletion the guard refused does
// not tell the customer their subscription was canceled.
//
// ADR 0004: the dispatcher runs over a fake Stripe holding one customer's subscriptions, and over a fake
// sync that keeps ONE org row and decides each write by the guard's rule as ADR 0004 §4.3 states it (the
// real statement is the S cases' subject). The fake reports what the guarded write decided against, as
// the real sync does through `onPlanWrite`. The two-live alert is observed at `emitAlertEvent`, through
// the real operator-alert module.

import type Stripe from "stripe";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/analytics/server", () => ({ captureServer: vi.fn() }));
vi.mock("@/lib/billing/ai-quota", () => ({ grantAiCredits: vi.fn() }));
vi.mock("@/lib/billing/invoices", () => ({
	mirrorPaidInvoice: vi.fn(),
	setInvoiceStatus: vi.fn(),
}));
vi.mock("@/lib/billing/payment-methods", () => ({ attemptBackupPayment: vi.fn() }));
const stripeMock = vi.hoisted(() => ({
	retrieve: vi.fn(),
	list: vi.fn(),
	cancel: vi.fn(),
	voidInvoice: vi.fn(),
	pay: vi.fn(),
	refundsCreate: vi.fn(),
}));
vi.mock("@/lib/billing/stripe", () => ({
	getStripe: () => ({
		subscriptions: { retrieve: stripeMock.retrieve, list: stripeMock.list, cancel: stripeMock.cancel },
		invoices: { voidInvoice: stripeMock.voidInvoice, pay: stripeMock.pay },
		refunds: { create: stripeMock.refundsCreate },
	}),
}));
vi.mock("@/lib/billing/config", () => ({
	planForPriceId: (id: string) => (id === "price_team" ? "team" : null),
	aiTierForPriceId: (id: string) => (id === "price_ai" ? "ai_plus" : null),
}));
// The real classifier and `mapStatus`; only the write is replaced.
vi.mock("@/lib/billing/sync", async (importActual) => ({
	...(await importActual<typeof import("@/lib/billing/sync")>()),
	syncSubscriptionToBilling: vi.fn(),
}));
vi.mock("@/lib/email/billing-email", () => ({
	sendCreditPackReceiptEmail: vi.fn(),
	sendPaymentFailedEmail: vi.fn(),
	sendReceiptEmail: vi.fn(),
	sendSubscriptionCanceledEmail: vi.fn(),
	sendTrialEndingEmail: vi.fn(),
}));
vi.mock("@/lib/alerts/emit", () => ({ emitAlertEvent: vi.fn(async () => 1) }));

import { captureServer } from "@/lib/analytics/server";
import { emitAlertEvent } from "@/lib/alerts/emit";
import { type HandleEventOptions, handleStripeEvent } from "@/lib/billing/webhook-handler";
import { mapStatus, type SyncOptions, syncSubscriptionToBilling } from "@/lib/billing/sync";
import type { BillingStatus } from "@/lib/db/schema/enums";
import {
	sendPaymentFailedEmail,
	sendReceiptEmail,
	sendSubscriptionCanceledEmail,
} from "@/lib/email/billing-email";

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
		"%s syncs the FRESHLY retrieved subscription, not the snapshot, at the event's created time",
		async (type) => {
			vi.mocked(syncSubscriptionToBilling).mockResolvedValue("applied");
			const { event } = subscriptionEvent(type);
			// The snapshot says canceled; Stripe now says otherwise. The sync must see Stripe's answer —
			// a stale `active` snapshot of a dead subscription would otherwise claim an empty row.
			const fresh = { id: "sub_z", status: "active", metadata: {} };
			stripeMock.retrieve.mockReset().mockResolvedValue(fresh);
			await handleStripeEvent(event);
			expect(stripeMock.retrieve).toHaveBeenCalledWith("sub_z");
			expect(syncSubscriptionToBilling).toHaveBeenCalledWith(
				fresh,
				expect.objectContaining({ eventAt: new Date(CREATED * 1000) }),
			);
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

// ── ADR 0004 D4 and D6: the superseder with a fresh read, and the two-live detector ─────────────────

const ORG = "org_o";
const CUSTOMER = "cus_o";

/** The org's one billing row, as the fake sync keeps it. Null when the org has none. */
interface FakeRow {
	subscriptionId: string | null;
	status: BillingStatus;
	plan: string;
	currentPeriodEnd: Date | null;
}

/** One sync the fake received: which subscription, in which status, with which event time. */
interface SyncCall {
	id: string;
	status: string;
	eventAt: Date | undefined;
}

/** The fake's state: the row, the syncs, and Stripe's subscriptions by id. */
const world: { row: FakeRow | null; syncs: SyncCall[]; stripe: Map<string, Stripe.Subscription> } = {
	row: null,
	syncs: [],
	stripe: new Map(),
};

/** Stored statuses under which the row holds a live plan. */
const STORED_LIVE: BillingStatus[] = ["active", "trialing", "past_due"];

/**
 * The fake guarded sync: ADR 0004 §4.3's "Guard (as built)" column over one row, with no watermark. It
 * reports the slot it decided against through `onPlanWrite`, as the real sync does, for an org-plan
 * write only.
 */
async function fakeSync(sub: Stripe.Subscription, opts: SyncOptions = {}): Promise<"applied" | "ignored"> {
	world.syncs.push({ id: sub.id, status: sub.status, eventAt: opts.eventAt });
	const orgId = sub.metadata?.organization_id;
	if (!orgId || sub.items.data.some((i) => i.price.id === "price_ai")) return "ignored";
	const status = mapStatus(sub.status);
	const paid = status === "active" || status === "trialing";
	const row = world.row;
	const before = row ? { subscriptionId: row.subscriptionId, status: row.status, currentPeriodEnd: row.currentPeriodEnd } : null;
	let applied: boolean;
	if (status === "canceled") applied = row?.subscriptionId === sub.id;
	else if (!row || row.subscriptionId === sub.id) applied = true;
	else applied = !STORED_LIVE.includes(row.status) || (paid && (row.subscriptionId === null || row.status === "past_due"));
	opts.onPlanWrite?.({ applied, before });
	if (applied) world.row = { subscriptionId: sub.id, status, plan: paid ? "team" : "community", currentPeriodEnd: null };
	return applied ? "applied" : "ignored";
}

/** True when a fixture carries the fields the dispatcher and the reconciliations read. */
function isSubscriptionFixture(x: unknown): x is Stripe.Subscription {
	return typeof x === "object" && x !== null && "id" in x && "status" in x && "items" in x && "created" in x;
}

/** A subscription on the org's customer, as Stripe reads it now; also stored in the fake Stripe. */
function subscription(
	id: string,
	status: string,
	created: number,
	over: { org?: string | null; priceId?: string; productType?: string } = {},
): Stripe.Subscription {
	const org = over.org === undefined ? ORG : over.org;
	const metadata: Record<string, string> = {};
	if (org) metadata.organization_id = org;
	if (over.productType) metadata.product_type = over.productType;
	const fixture: unknown = {
		id,
		object: "subscription",
		status,
		created,
		customer: CUSTOMER,
		metadata,
		items: { data: [{ id: `si_${id}`, price: { id: over.priceId ?? "price_team", recurring: { usage_type: "licensed" } } }] },
	};
	if (!isSubscriptionFixture(fixture)) throw new Error("subscription fixture is malformed");
	world.stripe.set(id, fixture);
	return fixture;
}

/** An event of `type` around `object`, created at CREATED. */
function eventOf(type: string, object: object): Stripe.Event {
	const fixture: unknown = { id: `evt_${type}`, object: "event", type, created: CREATED, data: { object } };
	if (!isEventFixture(fixture)) throw new Error("event fixture is malformed");
	return fixture;
}

/** A hold port with no holds: every lookup answers "none", every nudge nudges nothing. */
const noHolds: HandleEventOptions = {
	holds: {
		heldInvoice: async () => null,
		holdNamesSubscription: async () => false,
		nudgeSubscription: async () => 0,
		nudgeRefund: async () => 0,
	},
};

/** The row as a value to assert on. */
function rowNow(): Pick<FakeRow, "subscriptionId" | "status" | "plan"> | null {
	return world.row ? { subscriptionId: world.row.subscriptionId, status: world.row.status, plan: world.row.plan } : null;
}

/** The two-live alerts raised, as the operator's alert rule receives them. */
function twoLiveAlerts(): Array<{ subject: string | undefined; summary: string | undefined }> {
	return vi
		.mocked(emitAlertEvent)
		.mock.calls.filter(([, key, ctx]) => key === "system.platform.payment_needs_support" && /two live/.test(ctx.title))
		.map(([, , ctx]) => ({ subject: ctx.resource_id, summary: ctx.summary }));
}

/** The org's row names `id` in `status` (`plan` follows from it). */
function rowNames(id: string | null, status: BillingStatus): void {
	world.row = {
		subscriptionId: id,
		status,
		plan: status === "active" || status === "trialing" ? "team" : "community",
		currentPeriodEnd: id ? null : new Date(Date.now() + 30 * 86_400_000),
	};
}

/** C40: no detector path cancels, refunds or voids anything. */
function expectNoStripeWrite(): void {
	expect(stripeMock.cancel).not.toHaveBeenCalled();
	expect(stripeMock.refundsCreate).not.toHaveBeenCalled();
	expect(stripeMock.voidInvoice).not.toHaveBeenCalled();
}

describe("ADR 0004 D4 and D6 in the webhook (W)", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		process.env.ALETHIA_PLATFORM_ALERT_ORG_ID = "org_platform";
		world.row = null;
		world.syncs = [];
		world.stripe = new Map();
		vi.mocked(syncSubscriptionToBilling).mockReset().mockImplementation(fakeSync);
		stripeMock.retrieve.mockReset().mockImplementation(async (id: string) => {
			const sub = world.stripe.get(id);
			if (!sub) throw new Error(`No such subscription: ${id}`);
			return sub;
		});
		// Pages of two, in insertion order. "R1 reads page two" is proven by its own case below, which puts
		// the only live sibling there.
		stripeMock.list.mockReset().mockImplementation(async (params: Stripe.SubscriptionListParams) => {
			const all = [...world.stripe.values()].filter((s) => s.customer === params.customer);
			const from = params.starting_after ? all.findIndex((s) => s.id === params.starting_after) + 1 : 0;
			const data = all.slice(from, from + 2);
			return { data, has_more: from + 2 < all.length };
		});
	});

	afterEach(() => {
		delete process.env.ALETHIA_PLATFORM_ALERT_ORG_ID;
	});

	it("C33: Y ends while a paid X lives — R1 names X (team, active), and there is no cancellation email or revenue event", async () => {
		rowNames("sub_y", "active");
		subscription("sub_x", "active", 2_000);
		const y = subscription("sub_y", "canceled", 1_000);
		await handleStripeEvent(eventOf("customer.subscription.deleted", y), noHolds);
		expect(rowNow()).toEqual({ subscriptionId: "sub_x", status: "active", plan: "team" });
		expect(world.syncs.at(-1)).toEqual({ id: "sub_x", status: "active", eventAt: undefined });
		expect(sendSubscriptionCanceledEmail).not.toHaveBeenCalled();
		expect(captureServer).not.toHaveBeenCalled();
		expect(twoLiveAlerts()).toEqual([]);
		expectNoStripeWrite();
	});

	it("C34: Y ends with two live siblings — R1 names the newer, and one two-live alert names both", async () => {
		rowNames("sub_y", "active");
		subscription("sub_x1", "active", 2_000);
		subscription("sub_x2", "active", 3_000);
		subscription("sub_old", "canceled", 500);
		const y = subscription("sub_y", "canceled", 1_000);
		await handleStripeEvent(eventOf("customer.subscription.deleted", y), noHolds);
		expect(rowNow()?.subscriptionId).toBe("sub_x2");
		const alerts = twoLiveAlerts();
		expect(alerts).toHaveLength(1);
		expect(alerts[0]?.subject).toBe("sub_x2");
		expect(alerts[0]?.summary).toContain("sub_x1");
		expect(sendSubscriptionCanceledEmail).not.toHaveBeenCalled();
		expectNoStripeWrite();
	});

	it("C34 variant: the only sibling is past_due — R1 names it, no alert, and the cancellation email is sent", async () => {
		rowNames("sub_y", "active");
		subscription("sub_x", "past_due", 2_000);
		const y = subscription("sub_y", "canceled", 1_000);
		await handleStripeEvent(eventOf("customer.subscription.deleted", y), noHolds);
		expect(rowNow()).toEqual({ subscriptionId: "sub_x", status: "past_due", plan: "community" });
		expect(twoLiveAlerts()).toEqual([]);
		expect(sendSubscriptionCanceledEmail).toHaveBeenCalledTimes(1);
		expectNoStripeWrite();
	});

	it("C35: Y ends with no live org-plan sibling — the row stays canceled, and the email and revenue event go as today", async () => {
		rowNames("sub_y", "active");
		// Live, but not org-plan subscriptions of O: an AI one, another org's, and an unlinked one.
		subscription("sub_ai", "active", 2_000, { priceId: "price_ai", productType: "ai_subscription" });
		subscription("sub_o2", "active", 2_100, { org: "org_other" });
		subscription("sub_unlinked", "active", 2_200, { org: null });
		const y = subscription("sub_y", "canceled", 1_000);
		await handleStripeEvent(eventOf("customer.subscription.deleted", y), noHolds);
		expect(rowNow()).toEqual({ subscriptionId: "sub_y", status: "canceled", plan: "community" });
		expect(world.syncs.map((s) => s.id)).toEqual(["sub_y"]);
		expect(sendSubscriptionCanceledEmail).toHaveBeenCalledTimes(1);
		expect(captureServer).toHaveBeenCalledWith(ORG, "subscription_canceled", ORG, undefined);
		expectNoStripeWrite();
	});

	it("an AI subscription's deletion runs no R1: no list, and its email goes as today", async () => {
		const ai = subscription("sub_ai", "canceled", 1_000, { priceId: "price_ai", productType: "ai_subscription" });
		vi.mocked(syncSubscriptionToBilling).mockResolvedValueOnce("applied");
		await handleStripeEvent(eventOf("customer.subscription.deleted", ai), noHolds);
		expect(stripeMock.list).not.toHaveBeenCalled();
		expect(sendSubscriptionCanceledEmail).toHaveBeenCalledTimes(1);
		expectNoStripeWrite();
	});

	it("C36: Y ended in Stripe but its deletion is late — X's updated(active) writes Y's canceled, then X", async () => {
		rowNames("sub_y", "active");
		subscription("sub_y", "canceled", 1_000);
		const x = subscription("sub_x", "active", 2_000);
		await handleStripeEvent(eventOf("customer.subscription.updated", x), noHolds);
		expect(world.syncs).toEqual([
			{ id: "sub_x", status: "active", eventAt: new Date(CREATED * 1000) },
			{ id: "sub_y", status: "canceled", eventAt: undefined },
			{ id: "sub_x", status: "active", eventAt: new Date(CREATED * 1000) },
		]);
		expect(rowNow()).toEqual({ subscriptionId: "sub_x", status: "active", plan: "team" });
		expect(twoLiveAlerts()).toEqual([]);
		// X is a PAID successor: the org's plan did not end, so Y's cancellation is not reported.
		expect(sendSubscriptionCanceledEmail).not.toHaveBeenCalled();
		expect(captureServer).not.toHaveBeenCalled();
		expectNoStripeWrite();
	});

	it("C36 variant: X is past_due — R2 writes Y's end and X, and Y's cancellation is reported once, even though Y's late deletion is then refused", async () => {
		rowNames("sub_y", "active");
		const y = subscription("sub_y", "canceled", 1_000);
		const x = subscription("sub_x", "past_due", 2_000);
		await handleStripeEvent(eventOf("customer.subscription.updated", x), noHolds);
		expect(rowNow()).toEqual({ subscriptionId: "sub_x", status: "past_due", plan: "community" });
		expect(sendSubscriptionCanceledEmail).toHaveBeenCalledTimes(1);
		expect(sendSubscriptionCanceledEmail).toHaveBeenCalledWith(y);
		expect(captureServer).toHaveBeenCalledWith(ORG, "subscription_canceled", ORG, undefined);

		// Y's own deletion arrives late: the row names X, so it is refused, and Y is not reported twice.
		await handleStripeEvent(eventOf("customer.subscription.deleted", y), noHolds);
		expect(rowNow()?.subscriptionId).toBe("sub_x");
		expect(sendSubscriptionCanceledEmail).toHaveBeenCalledTimes(1);
		expectNoStripeWrite();
	});

	it("C36 variant, replay: R2's cancellation report honours suppressEmails", async () => {
		rowNames("sub_y", "active");
		subscription("sub_y", "canceled", 1_000);
		const x = subscription("sub_x", "unpaid", 2_000);
		await handleStripeEvent(eventOf("customer.subscription.updated", x), { ...noHolds, suppressEmails: true });
		expect(rowNow()?.subscriptionId).toBe("sub_x");
		expect(sendSubscriptionCanceledEmail).not.toHaveBeenCalled();
		expectNoStripeWrite();
	});

	it("C37: both live — X's write is refused, the row stays on Y, and one alert names X and Y; a second X event raises it with the same subject", async () => {
		rowNames("sub_y", "active");
		subscription("sub_y", "active", 1_000);
		const x = subscription("sub_x", "active", 2_000);
		await handleStripeEvent(eventOf("customer.subscription.updated", x), noHolds);
		expect(rowNow()).toEqual({ subscriptionId: "sub_y", status: "active", plan: "team" });
		let alerts = twoLiveAlerts();
		expect(alerts).toHaveLength(1);
		expect(alerts[0]?.subject).toBe("sub_x");
		expect(alerts[0]?.summary).toContain("sub_y");

		await handleStripeEvent(eventOf("invoice.payment_succeeded", invoiceOf("sub_x")), noHolds);
		alerts = twoLiveAlerts();
		expect(alerts.map((a) => a.subject)).toEqual(["sub_x", "sub_x"]);
		expect(rowNow()?.subscriptionId).toBe("sub_y");
		expectNoStripeWrite();
	});

	it("R2 beside a live off-Stripe grant: a refused live X is reported with the grant, and nothing is re-read", async () => {
		rowNames(null, "active");
		const x = subscription("sub_x", "past_due", 2_000);
		await handleStripeEvent(eventOf("customer.subscription.updated", x), noHolds);
		expect(rowNow()).toEqual({ subscriptionId: null, status: "active", plan: "team" });
		const alerts = twoLiveAlerts();
		expect(alerts).toHaveLength(1);
		expect(alerts[0]?.summary).toContain("off-Stripe grant");
		expect(stripeMock.retrieve).toHaveBeenCalledTimes(1);
		expectNoStripeWrite();
	});

	it("R2 does not run for a refused write that is not live (an incomplete checkout beside Y)", async () => {
		rowNames("sub_y", "active");
		subscription("sub_y", "active", 1_000);
		const x = subscription("sub_x", "incomplete", 2_000);
		await handleStripeEvent(eventOf("customer.subscription.created", x), noHolds);
		expect(stripeMock.retrieve).toHaveBeenCalledTimes(1);
		expect(twoLiveAlerts()).toEqual([]);
		expectNoStripeWrite();
	});

	it("C41: R2's read of Y fails — the handler throws before any email, and nothing past X's guarded write changed", async () => {
		rowNames("sub_y", "active");
		const x = subscription("sub_x", "active", 2_000);
		stripeMock.retrieve.mockImplementation(async (id: string) => {
			if (id === "sub_x") return x;
			throw new Error("Stripe is unreachable");
		});
		await expect(
			handleStripeEvent(eventOf("invoice.payment_failed", invoiceOf("sub_x")), noHolds),
		).rejects.toThrow("Stripe is unreachable");
		expect(world.syncs.map((s) => s.id)).toEqual(["sub_x"]);
		expect(rowNow()).toEqual({ subscriptionId: "sub_y", status: "active", plan: "team" });
		expect(sendPaymentFailedEmail).not.toHaveBeenCalled();
		expect(sendReceiptEmail).not.toHaveBeenCalled();
		expect(twoLiveAlerts()).toEqual([]);
		expectNoStripeWrite();
	});

	it("C41, R1: a failed list throws before the cancellation email", async () => {
		rowNames("sub_y", "active");
		const y = subscription("sub_y", "canceled", 1_000);
		stripeMock.list.mockRejectedValue(new Error("Stripe is unreachable"));
		await expect(handleStripeEvent(eventOf("customer.subscription.deleted", y), noHolds)).rejects.toThrow(
			"Stripe is unreachable",
		);
		expect(sendSubscriptionCanceledEmail).not.toHaveBeenCalled();
		expect(captureServer).not.toHaveBeenCalled();
		expectNoStripeWrite();
	});

	it("C46: a paid X replaces a Y stored `none` that reads paused — one two-live alert", async () => {
		rowNames("sub_y", "none");
		subscription("sub_y", "paused", 1_000);
		const x = subscription("sub_x", "active", 2_000);
		await handleStripeEvent(eventOf("customer.subscription.updated", x), noHolds);
		expect(rowNow()?.subscriptionId).toBe("sub_x");
		expect(stripeMock.retrieve).toHaveBeenCalledWith("sub_y");
		const alerts = twoLiveAlerts();
		expect(alerts).toHaveLength(1);
		expect(alerts[0]?.subject).toBe("sub_x");
		expect(alerts[0]?.summary).toContain("sub_y");
		expectNoStripeWrite();
	});

	it.each(["canceled", "incomplete_expired"])(
		"C46: the replaced Y reads %s — not paused, so no alert",
		async (status) => {
			rowNames("sub_y", "none");
			subscription("sub_y", status, 1_000);
			const x = subscription("sub_x", "active", 2_000);
			await handleStripeEvent(eventOf("customer.subscription.updated", x), noHolds);
			expect(stripeMock.retrieve).toHaveBeenCalledWith("sub_y");
			expect(twoLiveAlerts()).toEqual([]);
			expectNoStripeWrite();
		},
	);

	it("C46: the replaced Y reads incomplete — no alert", async () => {
		rowNames("sub_y", "none");
		subscription("sub_y", "incomplete", 1_000);
		const x = subscription("sub_x", "active", 2_000);
		await handleStripeEvent(eventOf("customer.subscription.updated", x), noHolds);
		expect(rowNow()?.subscriptionId).toBe("sub_x");
		expect(stripeMock.retrieve).toHaveBeenCalledWith("sub_y");
		expect(twoLiveAlerts()).toEqual([]);
		expectNoStripeWrite();
	});

	it("C46: the replaced Y cannot be read — the event still succeeds, and one alert names X and Y and says Y could not be read", async () => {
		rowNames("sub_y", "none");
		const x = subscription("sub_x", "active", 2_000);
		await expect(handleStripeEvent(eventOf("customer.subscription.updated", x), noHolds)).resolves.toEqual({
			nudged: 0,
		});
		expect(rowNow()?.subscriptionId).toBe("sub_x");
		const alerts = twoLiveAlerts();
		expect(alerts).toHaveLength(1);
		expect(alerts[0]?.subject).toBe("sub_x");
		expect(alerts[0]?.summary).toContain("sub_y");
		expect(alerts[0]?.summary).toMatch(/could not be read/);
		expectNoStripeWrite();
	});

	it("C46 boundary: an unpaid X over a stored-`none` Y reads nothing", async () => {
		rowNames("sub_y", "none");
		subscription("sub_y", "paused", 1_000);
		const x = subscription("sub_x", "past_due", 2_000);
		await handleStripeEvent(eventOf("customer.subscription.updated", x), noHolds);
		expect(stripeMock.retrieve).toHaveBeenCalledTimes(1);
		expect(twoLiveAlerts()).toEqual([]);
		expectNoStripeWrite();
	});

	it("R1 follows `has_more`: the only live sibling sits on the second page", async () => {
		rowNames("sub_y", "active");
		subscription("sub_old1", "canceled", 100);
		subscription("sub_old2", "incomplete_expired", 200);
		const y = subscription("sub_y", "canceled", 1_000);
		subscription("sub_x", "active", 2_000);
		await handleStripeEvent(eventOf("customer.subscription.deleted", y), noHolds);
		expect(stripeMock.list).toHaveBeenCalledTimes(2);
		expect(rowNow()).toEqual({ subscriptionId: "sub_x", status: "active", plan: "team" });
		expect(sendSubscriptionCanceledEmail).not.toHaveBeenCalled();
		expectNoStripeWrite();
	});

	it("R1 names only a LIVE sibling: newer ended org-plan siblings are passed over for an older past_due one", async () => {
		rowNames("sub_y", "active");
		subscription("sub_x", "past_due", 1_500);
		subscription("sub_gone", "canceled", 3_000);
		subscription("sub_expired", "incomplete_expired", 3_500);
		subscription("sub_checkout", "incomplete", 4_000);
		const y = subscription("sub_y", "canceled", 1_000);
		await handleStripeEvent(eventOf("customer.subscription.deleted", y), noHolds);
		expect(rowNow()).toEqual({ subscriptionId: "sub_x", status: "past_due", plan: "community" });
		expect(twoLiveAlerts()).toEqual([]);
		expectNoStripeWrite();
	});

	it("R1's re-read of its successor fails AFTER the write applied: no throw, an operator alert, and the email decision uses the listed read", async () => {
		rowNames("sub_y", "active");
		subscription("sub_x", "active", 2_000);
		const y = subscription("sub_y", "canceled", 1_000);
		stripeMock.retrieve.mockRejectedValue(new Error("Stripe is unreachable"));
		await expect(handleStripeEvent(eventOf("customer.subscription.deleted", y), noHolds)).resolves.toEqual({
			nudged: 0,
		});
		expect(rowNow()).toEqual({ subscriptionId: "sub_x", status: "active", plan: "team" });
		const reread = vi
			.mocked(emitAlertEvent)
			.mock.calls.filter(([, , ctx]) => /could not be re-read/.test(ctx.title));
		expect(reread).toHaveLength(1);
		expect(reread[0]?.[2].resource_id).toBe("sub_x");
		expect(reread[0]?.[2].summary).toContain("sub_y");
		// The listed read says X is active: a paid successor, so Y's cancellation is not reported.
		expect(sendSubscriptionCanceledEmail).not.toHaveBeenCalled();
		expectNoStripeWrite();
	});

	it("R1's failed re-read with a past_due successor still sends Y's email", async () => {
		rowNames("sub_y", "active");
		subscription("sub_x", "past_due", 2_000);
		const y = subscription("sub_y", "canceled", 1_000);
		stripeMock.retrieve.mockRejectedValue(new Error("Stripe is unreachable"));
		await handleStripeEvent(eventOf("customer.subscription.deleted", y), noHolds);
		expect(rowNow()?.subscriptionId).toBe("sub_x");
		expect(sendSubscriptionCanceledEmail).toHaveBeenCalledTimes(1);
		expectNoStripeWrite();
	});

	it("R1 race: the named sibling is deleted between R1's list and its write — R1 re-reads it and writes its end, and the email goes", async () => {
		rowNames("sub_y", "active");
		const listed = subscription("sub_x", "active", 2_000);
		const y = subscription("sub_y", "canceled", 1_000);
		// The list still shows X active; every read after it shows X canceled.
		const gone = { ...listed, status: "canceled" };
		stripeMock.retrieve.mockImplementation(async (id: string) => {
			if (id === "sub_x") return gone;
			const sub = world.stripe.get(id);
			if (!sub) throw new Error(`No such subscription: ${id}`);
			return sub;
		});
		await handleStripeEvent(eventOf("customer.subscription.deleted", y), noHolds);
		expect(world.syncs).toEqual([
			{ id: "sub_y", status: "canceled", eventAt: new Date(CREATED * 1000) },
			{ id: "sub_x", status: "active", eventAt: undefined },
			{ id: "sub_x", status: "canceled", eventAt: undefined },
		]);
		expect(rowNow()).toEqual({ subscriptionId: "sub_x", status: "canceled", plan: "community" });
		expect(sendSubscriptionCanceledEmail).toHaveBeenCalledTimes(1);
		expect(twoLiveAlerts()).toEqual([]);
		expectNoStripeWrite();
	});

	it("C47: Y is deleted; an older active X1 and a newer trialing T — R1 names X1, with one two-live alert", async () => {
		rowNames("sub_y", "active");
		subscription("sub_x1", "active", 2_000);
		subscription("sub_t", "trialing", 3_000);
		const y = subscription("sub_y", "canceled", 1_000);
		await handleStripeEvent(eventOf("customer.subscription.deleted", y), noHolds);
		expect(rowNow()).toEqual({ subscriptionId: "sub_x1", status: "active", plan: "team" });
		const alerts = twoLiveAlerts();
		expect(alerts).toHaveLength(1);
		// The newer subscription is the subject, so the rule's throttle collapses repeats.
		expect(alerts[0]?.subject).toBe("sub_t");
		expect(sendSubscriptionCanceledEmail).not.toHaveBeenCalled();
	expectNoStripeWrite();
	});
});

/** An invoice of `subscriptionId`, as an `invoice.*` event carries it. */
function invoiceOf(subscriptionId: string) {
	return {
		id: `in_${subscriptionId}`,
		object: "invoice",
		customer: CUSTOMER,
		amount_paid: 2900,
		amount_due: 2900,
		currency: "usd",
		billing_reason: "subscription_cycle",
		default_payment_method: null,
		metadata: {},
		parent: { subscription_details: { subscription: subscriptionId } },
	};
}
