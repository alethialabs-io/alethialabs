// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Integration (real Postgres): a Stripe subscription's events may only change the org's
// organization_billing row when they are about the subscription the row names, or when that
// subscription is no longer live (#5514).
//
// The defect: syncSubscriptionToBilling upserted on organization_id alone, so ANY subscription's
// event replaced the row. An org paying for Y that also had a second subscription Z (an
// `incomplete` purchase attempt, an orphan) had Y's row overwritten by Z — and Z's cancellation
// then wrote `canceled`/`community` onto an org still paying for Y. Stale or redelivered events
// regressed the row the same way. The AI columns had the identical shape.
//
// Each case below replays a sequence of syncs exactly as the webhook dispatcher issues them (the
// subscription object plus the event's `created` time) and asserts the ROW, read back from the
// database. Every sequence ends in a row the old unconditional upsert could not have produced.
//
// ADR 0004 (D4, D6) adds the S cases at the end: the superseder's fresh read (R1, R2) and the
// two-live detector's report from the guarded write (D6b), each against the same real statement. R1
// and R2 are driven through the webhook dispatcher over a fake Stripe; the alert is observed at
// `emitAlertEvent`, through the real operator-alert module.
//
// Needs a migrated Postgres on ALETHIA_DATABASE_URL; skips when unreachable (CI requires it).

import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import type Stripe from "stripe";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import { getServiceDb } from "@/lib/db";
import { organization, organizationBilling } from "@/lib/db/schema";
import { syncSubscriptionToBilling } from "@/lib/billing/sync";
import { writeSubscriptionToBilling } from "@/lib/billing/queries";
import { type HandleEventOptions, handleStripeEvent } from "@/lib/billing/webhook-handler";
import { emitAlertEvent } from "@/lib/alerts/emit";
import { sendSubscriptionCanceledEmail } from "@/lib/email/billing-email";
import { describeIfDb } from "./db";

// The write under test is the database statement; its neighbours reach Stripe or mail, so they
// are stubbed. Price→plan resolution is stubbed to two fixed prices: one org plan, one AI tier.
vi.mock("@/lib/billing/credit-grants", () => ({ ensureIncludedCredit: vi.fn() }));
vi.mock("@/lib/email/billing-email", () => ({
	sendPlanWelcomeEmail: vi.fn(),
	sendCreditPackReceiptEmail: vi.fn(),
	sendPaymentFailedEmail: vi.fn(),
	sendReceiptEmail: vi.fn(),
	sendSubscriptionCanceledEmail: vi.fn(),
	sendTrialEndingEmail: vi.fn(),
}));
// The dispatcher's other neighbours, for the ADR 0004 cases that drive it.
vi.mock("@/lib/analytics/server", () => ({ captureServer: vi.fn() }));
vi.mock("@/lib/billing/ai-quota", () => ({ grantAiCredits: vi.fn() }));
vi.mock("@/lib/billing/invoices", () => ({ mirrorPaidInvoice: vi.fn(), setInvoiceStatus: vi.fn() }));
vi.mock("@/lib/billing/payment-methods", () => ({ attemptBackupPayment: vi.fn(async () => null) }));
vi.mock("@/lib/alerts/emit", () => ({ emitAlertEvent: vi.fn(async () => 1) }));
// A fake Stripe holding the subscriptions a case puts in it: R1's list and R2's retrieve read it.
const fakeStripe = vi.hoisted(() => ({ subs: new Map<string, unknown>() }));
vi.mock("@/lib/billing/stripe", () => ({
	getStripe: () => ({
		subscriptions: {
			retrieve: async (id: string) => {
				const sub = fakeStripe.subs.get(id);
				if (!sub) throw new Error(`No such subscription: ${id}`);
				return sub;
			},
			list: async (params: { customer: string }) => ({
				data: [...fakeStripe.subs.values()].filter(
					(s) => typeof s === "object" && s !== null && Reflect.get(s, "customer") === params.customer,
				),
				has_more: false,
			}),
		},
	}),
}));
vi.mock("@/lib/billing/config", async (importOriginal) => {
	const real = await importOriginal<typeof import("@/lib/billing/config")>();
	return {
		...real,
		planForPriceId: (id: string) => (id === "price_it_team" ? "team" : null),
		aiTierForPriceId: (id: string) => (id === "price_it_ai_plus" ? "ai_plus" : null),
	};
});

const PRICE_TEAM = "price_it_team";
const PRICE_AI_PLUS = "price_it_ai_plus";

const touchedOrgs: string[] = [];

/** A fresh org with no billing row (tracked for teardown). */
async function freshOrg(): Promise<string> {
	const id = randomUUID();
	touchedOrgs.push(id);
	await getServiceDb()
		.insert(organization)
		.values({ id, name: `it-bsync-${id.slice(0, 8)}` });
	return id;
}

/** The fields a fixture carries — exactly what syncSubscriptionToBilling reads. */
interface FixtureInput {
	id: string;
	orgId: string;
	status: Stripe.Subscription.Status;
	priceId?: string;
	seats?: number;
}

/** True when a fixture carries the fields syncSubscriptionToBilling reads off a subscription. */
function isSubscriptionFixture(x: unknown): x is Stripe.Subscription {
	return (
		typeof x === "object" &&
		x !== null &&
		"id" in x &&
		"status" in x &&
		"customer" in x &&
		"metadata" in x &&
		"items" in x
	);
}

/** A subscription for `orgId` with one licensed plan line, as a webhook delivers it. */
function subscription(input: FixtureInput): Stripe.Subscription {
	const fixture: unknown = {
		id: input.id,
		object: "subscription",
		status: input.status,
		customer: `cus_${input.orgId.slice(0, 8)}`,
		metadata: { organization_id: input.orgId },
		items: {
			data: [
				{
					id: `si_${input.id}`,
					quantity: input.seats ?? 3,
					current_period_end: 1_900_000_000,
					price: { id: input.priceId ?? PRICE_TEAM, recurring: { usage_type: "licensed" } },
				},
			],
		},
	};
	if (!isSubscriptionFixture(fixture)) throw new Error("subscription fixture is malformed");
	return fixture;
}

/** A unique subscription id, so suites never collide on the unique stripe_subscription_id. */
function subId(label: string): string {
	return `sub_it_${label}_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

/** Stripe's event time `seconds` after a fixed base — the order the events were CREATED in. */
function at(seconds: number): { eventAt: Date } {
	return { eventAt: new Date(Date.UTC(2026, 9, 1, 12, 0, seconds)) };
}

/** The org's billing row as stored. */
async function row(orgId: string) {
	const [r] = await getServiceDb()
		.select()
		.from(organizationBilling)
		.where(eq(organizationBilling.organizationId, orgId))
		.limit(1);
	return r;
}

describeIfDb("billing sync: one subscription's events cannot overwrite another's row (#5514)", () => {
	afterAll(async () => {
		const db = getServiceDb();
		if (touchedOrgs.length === 0) return;
		await db
			.delete(organizationBilling)
			.where(inArray(organizationBilling.organizationId, touchedOrgs));
		await db.delete(organization).where(inArray(organization.id, touchedOrgs));
	});

	it("a second subscription Z created over a live Y leaves Y's row unchanged", async () => {
		const org = await freshOrg();
		const y = subId("y");
		const z = subId("z");
		await syncSubscriptionToBilling(subscription({ id: y, orgId: org, status: "active", seats: 5 }), at(1));

		// Z's purchase attempt: `incomplete`, then (a racing second checkout) `active`.
		await syncSubscriptionToBilling(subscription({ id: z, orgId: org, status: "incomplete" }), at(2));
		await syncSubscriptionToBilling(subscription({ id: z, orgId: org, status: "active", seats: 1 }), at(3));

		const r = await row(org);
		expect(r?.stripeSubscriptionId).toBe(y);
		expect(r?.status).toBe("active");
		expect(r?.plan).toBe("team");
		expect(r?.seats).toBe(5);
	});

	it("Z's deletion does not touch the row naming live Y — the paying org stays on its plan", async () => {
		const org = await freshOrg();
		const y = subId("y");
		const z = subId("z");
		await syncSubscriptionToBilling(subscription({ id: y, orgId: org, status: "active" }), at(1));
		await syncSubscriptionToBilling(subscription({ id: z, orgId: org, status: "incomplete" }), at(2));
		await syncSubscriptionToBilling(subscription({ id: z, orgId: org, status: "canceled" }), at(3));

		const r = await row(org);
		expect(r?.stripeSubscriptionId).toBe(y);
		expect(r?.status).toBe("active");
		expect(r?.plan).toBe("team");
	});

	it("an ended subscription the org has no row for creates no row", async () => {
		const org = await freshOrg();
		await syncSubscriptionToBilling(
			subscription({ id: subId("z"), orgId: org, status: "canceled" }),
			at(1),
		);
		expect(await row(org)).toBeUndefined();
	});

	it("Y's own update applies, and a redelivered OLDER Y event cannot undo it", async () => {
		const org = await freshOrg();
		const y = subId("y");
		await syncSubscriptionToBilling(subscription({ id: y, orgId: org, status: "active", seats: 2 }), at(1));
		// Y's newer update: dunning, more seats. This applies.
		await syncSubscriptionToBilling(subscription({ id: y, orgId: org, status: "past_due", seats: 7 }), at(5));
		expect((await row(org))?.status).toBe("past_due");

		// The t=1 snapshot is redelivered late. It is older than what the row holds — refused.
		const outcome = await syncSubscriptionToBilling(
			subscription({ id: y, orgId: org, status: "active", seats: 2 }),
			at(1),
		);
		expect(outcome).toBe("ignored");
		const r = await row(org);
		expect(r?.status).toBe("past_due");
		expect(r?.seats).toBe(7);
	});

	it("an out-of-order `incomplete` stamped the same second as `active` does not regress it", async () => {
		const org = await freshOrg();
		const y = subId("y");
		// Stripe's `created` has one-second resolution: subscription.created (incomplete) and the
		// activating subscription.updated are routinely stamped the same second, and arrive either way.
		await syncSubscriptionToBilling(subscription({ id: y, orgId: org, status: "active" }), at(4));
		await syncSubscriptionToBilling(subscription({ id: y, orgId: org, status: "incomplete" }), at(4));

		const r = await row(org);
		expect(r?.status).toBe("active");
		expect(r?.plan).toBe("team");
	});

	it("an ended subscription is not revived by a late live event, even one with no event time", async () => {
		const org = await freshOrg();
		const y = subId("y");
		await syncSubscriptionToBilling(subscription({ id: y, orgId: org, status: "active" }), at(1));
		await syncSubscriptionToBilling(subscription({ id: y, orgId: org, status: "canceled" }), at(2));
		// A server-action sync carries no event time; `canceled` is terminal in Stripe all the same.
		await syncSubscriptionToBilling(subscription({ id: y, orgId: org, status: "active" }));

		const r = await row(org);
		expect(r?.status).toBe("canceled");
		expect(r?.plan).toBe("community");
	});

	// ── A write with NO event time — a server action's sync (#5547) ─────────────────────────────
	// The create-a-team link and the trial start sync what Stripe returned to THEIR call, with no
	// event time. That read can be older than a webhook that already landed, so without a time it
	// may hold or raise the subscription's lifecycle rank (none < live < canceled), never lower it.

	it("C76: a link's stale `incomplete` with no event time cannot demote the `active` webhook already applied", async () => {
		const org = await freshOrg();
		const y = subId("y");
		// The `customer.subscription.updated(active)` webhook lands first, with its event time…
		await syncSubscriptionToBilling(subscription({ id: y, orgId: org, status: "active", seats: 5 }), at(1));
		// …then the link writes the `incomplete` its own `subscriptions.update` returned earlier.
		const outcome = await syncSubscriptionToBilling(subscription({ id: y, orgId: org, status: "incomplete" }));

		expect(outcome).toBe("ignored");
		const r = await row(org);
		expect(r?.stripeSubscriptionId).toBe(y);
		expect(r?.status).toBe("active");
		expect(r?.plan).toBe("team");
		expect(r?.seats).toBe(5);
	});

	it("C76, AI columns: a stale `incomplete` with no event time cannot lapse a live AI subscription", async () => {
		const org = await freshOrg();
		const y = subId("aiy");
		await syncSubscriptionToBilling(
			subscription({ id: y, orgId: org, status: "active", priceId: PRICE_AI_PLUS }),
			at(1),
		);
		await syncSubscriptionToBilling(
			subscription({ id: y, orgId: org, status: "incomplete", priceId: PRICE_AI_PLUS }),
		);
		const r = await row(org);
		expect(r?.aiSubscriptionStatus).toBe("active");
		expect(r?.aiTier).toBe("ai_plus");
	});

	it("`canceled` with no event time still ends the subscription the row names", async () => {
		const org = await freshOrg();
		const y = subId("y");
		await syncSubscriptionToBilling(subscription({ id: y, orgId: org, status: "active" }), at(1));
		const outcome = await syncSubscriptionToBilling(subscription({ id: y, orgId: org, status: "canceled" }));

		expect(outcome).toBe("applied");
		const r = await row(org);
		expect(r?.status).toBe("canceled");
		expect(r?.plan).toBe("community");
	});

	it("a move within the live band with no event time still applies (active → past_due)", async () => {
		const org = await freshOrg();
		const y = subId("y");
		await syncSubscriptionToBilling(subscription({ id: y, orgId: org, status: "active" }), at(1));
		await syncSubscriptionToBilling(subscription({ id: y, orgId: org, status: "past_due" }));
		expect((await row(org))?.status).toBe("past_due");
	});

	it("a same-rank re-apply with no event time still applies (past_due → active, both live)", async () => {
		const org = await freshOrg();
		const y = subId("y");
		await syncSubscriptionToBilling(subscription({ id: y, orgId: org, status: "past_due" }), at(1));
		const outcome = await syncSubscriptionToBilling(subscription({ id: y, orgId: org, status: "active" }));

		expect(outcome).toBe("applied");
		const r = await row(org);
		expect(r?.status).toBe("active");
		expect(r?.plan).toBe("team");
	});

	it("first write with no event time: a trial start creates the row", async () => {
		const org = await freshOrg();
		const y = subId("trial");
		const outcome = await syncSubscriptionToBilling(subscription({ id: y, orgId: org, status: "trialing" }));

		expect(outcome).toBe("applied");
		const r = await row(org);
		expect(r?.stripeSubscriptionId).toBe(y);
		expect(r?.status).toBe("trialing");
		expect(r?.plan).toBe("team");
		expect(r?.stripeSubscriptionEventAt).toBeNull();
	});

	it("first write with no event time: a link's `incomplete` creates the row, and its `active` then raises it", async () => {
		const org = await freshOrg();
		const y = subId("link");
		await syncSubscriptionToBilling(subscription({ id: y, orgId: org, status: "incomplete" }));
		let r = await row(org);
		expect(r?.stripeSubscriptionId).toBe(y);
		expect(r?.status).toBe("none");
		expect(r?.plan).toBe("community");

		await syncSubscriptionToBilling(subscription({ id: y, orgId: org, status: "active" }));
		r = await row(org);
		expect(r?.status).toBe("active");
		expect(r?.plan).toBe("team");
	});

	it("first write with no event time: a row naming nothing live is taken by the new subscription", async () => {
		const org = await freshOrg();
		const x = subId("x");
		const y = subId("y");
		await syncSubscriptionToBilling(subscription({ id: x, orgId: org, status: "active" }), at(1));
		await syncSubscriptionToBilling(subscription({ id: x, orgId: org, status: "canceled" }), at(2));
		await syncSubscriptionToBilling(subscription({ id: y, orgId: org, status: "trialing" }));

		const r = await row(org);
		expect(r?.stripeSubscriptionId).toBe(y);
		expect(r?.status).toBe("trialing");
		expect(r?.plan).toBe("team");
	});

	it("a PAID superseder replaces a canceled Y, and Y's late events then cannot reclaim the row", async () => {
		const org = await freshOrg();
		const y = subId("y");
		const z = subId("z");
		await syncSubscriptionToBilling(subscription({ id: y, orgId: org, status: "active" }), at(1));
		await syncSubscriptionToBilling(subscription({ id: y, orgId: org, status: "canceled" }), at(2));
		// The org buys again: Z is the superseder and takes the row.
		await syncSubscriptionToBilling(subscription({ id: z, orgId: org, status: "active", seats: 4 }), at(3));
		let r = await row(org);
		expect(r?.stripeSubscriptionId).toBe(z);
		expect(r?.status).toBe("active");
		expect(r?.plan).toBe("team");

		// Y's deletion is redelivered after Z took over: it names Y, the row names Z — untouched.
		await syncSubscriptionToBilling(subscription({ id: y, orgId: org, status: "canceled" }), at(2));
		r = await row(org);
		expect(r?.stripeSubscriptionId).toBe(z);
		expect(r?.status).toBe("active");
		expect(r?.seats).toBe(4);
	});

	it("a PAID subscription supersedes a past_due one, and the unpaid one's cancellation is then ignored", async () => {
		const org = await freshOrg();
		const y = subId("y");
		const z = subId("z");
		await syncSubscriptionToBilling(subscription({ id: y, orgId: org, status: "past_due" }), at(1));
		// An `incomplete` replacement does NOT supersede an unpaid-but-live subscription…
		await syncSubscriptionToBilling(subscription({ id: z, orgId: org, status: "incomplete" }), at(2));
		expect((await row(org))?.stripeSubscriptionId).toBe(y);
		// …once it is paid, it does.
		await syncSubscriptionToBilling(subscription({ id: z, orgId: org, status: "active" }), at(3));
		expect((await row(org))?.stripeSubscriptionId).toBe(z);

		await syncSubscriptionToBilling(subscription({ id: y, orgId: org, status: "canceled" }), at(4));
		const r = await row(org);
		expect(r?.stripeSubscriptionId).toBe(z);
		expect(r?.status).toBe("active");
		expect(r?.plan).toBe("team");
	});

	it("an off-Stripe grant is not overwritten by an unpaid subscription", async () => {
		const org = await freshOrg();
		// The operator plane's Enterprise grant: live, no Stripe subscription id.
		await getServiceDb()
			.insert(organizationBilling)
			.values({ organizationId: org, plan: "enterprise", status: "active" });
		await syncSubscriptionToBilling(
			subscription({ id: subId("z"), orgId: org, status: "incomplete" }),
			at(1),
		);
		const r = await row(org);
		expect(r?.plan).toBe("enterprise");
		expect(r?.status).toBe("active");
		expect(r?.stripeSubscriptionId).toBeNull();
	});

	it("the AI columns: a second AI subscription's create and delete leave the live one's columns alone", async () => {
		const org = await freshOrg();
		const y = subId("aiy");
		const z = subId("aiz");
		await syncSubscriptionToBilling(
			subscription({ id: y, orgId: org, status: "active", priceId: PRICE_AI_PLUS }),
			at(1),
		);
		await syncSubscriptionToBilling(
			subscription({ id: z, orgId: org, status: "incomplete", priceId: PRICE_AI_PLUS }),
			at(2),
		);
		await syncSubscriptionToBilling(
			subscription({ id: z, orgId: org, status: "canceled", priceId: PRICE_AI_PLUS }),
			at(3),
		);
		const r = await row(org);
		expect(r?.aiStripeSubscriptionId).toBe(y);
		expect(r?.aiSubscriptionStatus).toBe("active");
		expect(r?.aiTier).toBe("ai_plus");
		// The AI write never touches the org-plan columns.
		expect(r?.plan).toBe("community");
		expect(r?.stripeSubscriptionId).toBeNull();
	});

	it("the AI columns: a redelivered older AI event cannot regress a newer one", async () => {
		const org = await freshOrg();
		const y = subId("aiy");
		await syncSubscriptionToBilling(
			subscription({ id: y, orgId: org, status: "active", priceId: PRICE_AI_PLUS }),
			at(1),
		);
		await syncSubscriptionToBilling(
			subscription({ id: y, orgId: org, status: "past_due", priceId: PRICE_AI_PLUS }),
			at(6),
		);
		await syncSubscriptionToBilling(
			subscription({ id: y, orgId: org, status: "active", priceId: PRICE_AI_PLUS }),
			at(1),
		);
		const r = await row(org);
		expect(r?.aiSubscriptionStatus).toBe("past_due");
		expect(r?.aiTier).toBe("ai_free");
	});
});

// ── ADR 0004 D4 and D6: the superseder with a fresh read, and the two-live detector (S) ────────────

/** Stripe's `created` (seconds) of an event `seconds` after the fixtures' base time. */
function eventSeconds(seconds: number): number {
	return Date.UTC(2026, 9, 1, 12, 0, seconds) / 1000;
}

/** True when a fixture has the fields the dispatcher reads off an event. */
function isEventFixture(x: unknown): x is Stripe.Event {
	return typeof x === "object" && x !== null && "type" in x && "created" in x && "data" in x;
}

/** An event of `type` around `object`, created `seconds` after the base time. */
function eventOf(type: string, object: Stripe.Subscription, seconds: number): Stripe.Event {
	const fixture: unknown = { id: `evt_${object.id}_${type}`, object: "event", type, created: eventSeconds(seconds), data: { object } };
	if (!isEventFixture(fixture)) throw new Error("event fixture is malformed");
	return fixture;
}

/** `subscription(...)` with a `created` time, stored in the fake Stripe as it reads now. */
function inStripe(input: FixtureInput, created: number): Stripe.Subscription {
	const sub = { ...subscription(input), created };
	fakeStripe.subs.set(sub.id, sub);
	return sub;
}

/** A hold port with no holds, so the dispatcher's hold reads stay out of these cases. */
const noHolds: HandleEventOptions = {
	holds: {
		heldInvoice: async () => null,
		holdNamesSubscription: async () => false,
		nudgeSubscription: async () => 0,
		nudgeRefund: async () => 0,
	},
};

/** The two-live alerts raised so far: their subject and summary. */
function twoLiveAlerts(): Array<{ subject: string | undefined; summary: string | undefined }> {
	return vi
		.mocked(emitAlertEvent)
		.mock.calls.filter(([, key, ctx]) => key === "system.platform.payment_needs_support" && /two live/.test(ctx.title))
		.map(([, , ctx]) => ({ subject: ctx.resource_id, summary: ctx.summary }));
}

describeIfDb("ADR 0004: the superseder with a fresh read, and the two-live detector (S)", () => {
	beforeEach(() => {
		vi.mocked(emitAlertEvent).mockClear();
		vi.mocked(sendSubscriptionCanceledEmail).mockClear();
		fakeStripe.subs.clear();
		process.env.ALETHIA_PLATFORM_ALERT_ORG_ID = "org_platform";
		vi.spyOn(console, "warn").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
		vi.spyOn(console, "info").mockImplementation(() => {});
	});
	afterEach(() => {
		delete process.env.ALETHIA_PLATFORM_ALERT_ORG_ID;
		vi.restoreAllMocks();
	});
	afterAll(async () => {
		const db = getServiceDb();
		if (touchedOrgs.length === 0) return;
		await db.delete(organizationBilling).where(inArray(organizationBilling.organizationId, touchedOrgs));
		await db.delete(organization).where(inArray(organization.id, touchedOrgs));
	});

	it("C33: Y ends while a paid X lives — Y's deletion writes canceled, then R1 names X: team, active, and no email", async () => {
		const org = await freshOrg();
		const y = subId("y");
		const x = subId("x");
		await syncSubscriptionToBilling(subscription({ id: y, orgId: org, status: "active" }), at(1));
		// X's write is refused: the row names live Y.
		expect(await syncSubscriptionToBilling(subscription({ id: x, orgId: org, status: "active", seats: 6 }), at(2))).toBe(
			"ignored",
		);
		inStripe({ id: x, orgId: org, status: "active", seats: 6 }, 200);
		const ended = inStripe({ id: y, orgId: org, status: "canceled" }, 100);

		await handleStripeEvent(eventOf("customer.subscription.deleted", ended, 10), noHolds);

		const r = await row(org);
		expect(r?.stripeSubscriptionId).toBe(x);
		expect(r?.status).toBe("active");
		expect(r?.plan).toBe("team");
		expect(r?.seats).toBe(6);
		expect(sendSubscriptionCanceledEmail).not.toHaveBeenCalled();
		expect(twoLiveAlerts()).toEqual([]);
	});

	it("C36: Y ended in Stripe with its deletion late — X's updated(active) applies Y's canceled, then X", async () => {
		const org = await freshOrg();
		const y = subId("y");
		const x = subId("x");
		await syncSubscriptionToBilling(subscription({ id: y, orgId: org, status: "active" }), at(1));
		inStripe({ id: y, orgId: org, status: "canceled" }, 100);
		const live = inStripe({ id: x, orgId: org, status: "active", seats: 2 }, 200);

		await handleStripeEvent(eventOf("customer.subscription.updated", live, 10), noHolds);

		const r = await row(org);
		expect(r?.stripeSubscriptionId).toBe(x);
		expect(r?.status).toBe("active");
		expect(r?.plan).toBe("team");
		expect(r?.stripeSubscriptionEventAt).toEqual(new Date(eventSeconds(10) * 1000));
		// Y's late deletion now names a subscription the row does not: refused, and silent.
		await handleStripeEvent(eventOf("customer.subscription.deleted", { ...live, id: y, status: "canceled" }, 11), noHolds);
		expect((await row(org))?.stripeSubscriptionId).toBe(x);
		expect(sendSubscriptionCanceledEmail).not.toHaveBeenCalled();
	});

	it("C38: a paid X supersedes a past_due Y — the row as #5518 built it, plus one two-live alert", async () => {
		const org = await freshOrg();
		const y = subId("y");
		const z = subId("z");
		await syncSubscriptionToBilling(subscription({ id: y, orgId: org, status: "past_due" }), at(1));
		await syncSubscriptionToBilling(subscription({ id: z, orgId: org, status: "incomplete" }), at(2));
		expect((await row(org))?.stripeSubscriptionId).toBe(y);
		expect(twoLiveAlerts()).toEqual([]);
		await syncSubscriptionToBilling(subscription({ id: z, orgId: org, status: "active" }), at(3));
		const r = await row(org);
		expect(r?.stripeSubscriptionId).toBe(z);
		expect(r?.status).toBe("active");
		const alerts = twoLiveAlerts();
		expect(alerts).toHaveLength(1);
		expect(alerts[0]?.subject).toBe(z);
		expect(alerts[0]?.summary).toContain(y);
		// Its own later events replace nothing, so they report nothing.
		await syncSubscriptionToBilling(subscription({ id: z, orgId: org, status: "active" }), at(4));
		expect(twoLiveAlerts()).toHaveLength(1);
	});

	it("C39: a paid X supersedes a live off-Stripe grant — the row names X, and one alert names X and the grant", async () => {
		const org = await freshOrg();
		await getServiceDb()
			.insert(organizationBilling)
			.values({ organizationId: org, plan: "enterprise", status: "active", currentPeriodEnd: new Date(Date.now() + 86_400_000) });
		const x = subId("x");
		await syncSubscriptionToBilling(subscription({ id: x, orgId: org, status: "active" }), at(1));
		const r = await row(org);
		expect(r?.stripeSubscriptionId).toBe(x);
		expect(r?.plan).toBe("team");
		const alerts = twoLiveAlerts();
		expect(alerts).toHaveLength(1);
		expect(alerts[0]?.subject).toBe(x);
		expect(alerts[0]?.summary).toContain("off-Stripe grant");
	});

	it("D6b boundary: a paid X taking a LAPSED grant, or a row naming nothing live, raises nothing", async () => {
		const lapsed = await freshOrg();
		await getServiceDb()
			.insert(organizationBilling)
			.values({ organizationId: lapsed, plan: "enterprise", status: "active", currentPeriodEnd: new Date(Date.now() - 86_400_000) });
		await syncSubscriptionToBilling(subscription({ id: subId("x"), orgId: lapsed, status: "active" }), at(1));
		const ended = await freshOrg();
		const y = subId("y");
		await syncSubscriptionToBilling(subscription({ id: y, orgId: ended, status: "active" }), at(1));
		await syncSubscriptionToBilling(subscription({ id: y, orgId: ended, status: "canceled" }), at(2));
		await syncSubscriptionToBilling(subscription({ id: subId("x"), orgId: ended, status: "active" }), at(3));
		expect(twoLiveAlerts()).toEqual([]);
	});

	it("the reporting write: a first write against no row reports nothing replaced; a refused one reports what the row names", async () => {
		const org = await freshOrg();
		const y = subId("y");
		const seen: Array<{ applied: boolean; before: unknown }> = [];
		const onPlanWrite = (w: { applied: boolean; before: unknown }) => {
			seen.push(w);
		};
		await syncSubscriptionToBilling(subscription({ id: y, orgId: org, status: "active" }), { ...at(1), onPlanWrite });
		await syncSubscriptionToBilling(subscription({ id: subId("x"), orgId: org, status: "active" }), { ...at(2), onPlanWrite });
		expect(seen).toEqual([
			{ applied: true, before: null },
			{ applied: false, before: { subscriptionId: y, status: "active", currentPeriodEnd: new Date(1_900_000_000 * 1000) } },
		]);
	});

	it("C36 variant: X is past_due — R2 writes Y's end, X takes the row, and Y's cancellation is reported once", async () => {
		const org = await freshOrg();
		const y = subId("y");
		const x = subId("x");
		await syncSubscriptionToBilling(subscription({ id: y, orgId: org, status: "active" }), at(1));
		const ended = inStripe({ id: y, orgId: org, status: "canceled" }, 100);
		const dunning = inStripe({ id: x, orgId: org, status: "past_due" }, 200);

		await handleStripeEvent(eventOf("customer.subscription.updated", dunning, 10), noHolds);
		const r = await row(org);
		expect(r?.stripeSubscriptionId).toBe(x);
		expect(r?.status).toBe("past_due");
		expect(r?.plan).toBe("community");
		expect(sendSubscriptionCanceledEmail).toHaveBeenCalledTimes(1);

		// Y's late deletion is refused (the row names X) and does not report Y again.
		await handleStripeEvent(eventOf("customer.subscription.deleted", ended, 11), noHolds);
		expect((await row(org))?.stripeSubscriptionId).toBe(x);
		expect(sendSubscriptionCanceledEmail).toHaveBeenCalledTimes(1);
	});

	it("two concurrent FIRST writes for one org: one inserts and reports nothing replaced, the other reports the row the first wrote", async () => {
		const org = await freshOrg();
		const a = subId("a");
		const b = subId("b");
		/** One first write of `id`, as `active`, with no row yet. */
		const first = (id: string) =>
			writeSubscriptionToBilling({
				organizationId: org,
				plan: "team",
				status: "active",
				stripeCustomerId: `cus_${org.slice(0, 8)}`,
				stripeSubscriptionId: id,
				seats: 1,
				currentPeriodEnd: null,
				eventAt: null,
			});
		const reports = await Promise.all([first(a), first(b)]);
		const inserted = reports.filter((w) => w.before === null);
		const refused = reports.filter((w) => w.before !== null);
		// Whichever way the race went, the loser decided against the winner's row, read under its lock —
		// never against "no row", which is what a lost insert would report without the re-lock.
		expect(inserted).toEqual([{ applied: true, before: null }]);
		expect(refused).toHaveLength(1);
		const winner = (await row(org))?.stripeSubscriptionId;
		expect(refused[0]).toEqual({ applied: false, before: { subscriptionId: winner, status: "active", currentPeriodEnd: null } });
	});
});
