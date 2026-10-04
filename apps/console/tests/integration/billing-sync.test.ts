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
// Needs a migrated Postgres on ALETHIA_DATABASE_URL; skips when unreachable (CI requires it).

import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import type Stripe from "stripe";
import { afterAll, expect, it, vi } from "vitest";
import { getServiceDb } from "@/lib/db";
import { organization, organizationBilling } from "@/lib/db/schema";
import { syncSubscriptionToBilling } from "@/lib/billing/sync";
import { describeIfDb } from "./db";

// The write under test is the database statement; its neighbours reach Stripe or mail, so they
// are stubbed. Price→plan resolution is stubbed to two fixed prices: one org plan, one AI tier.
vi.mock("@/lib/billing/credit-grants", () => ({ ensureIncludedCredit: vi.fn() }));
vi.mock("@/lib/email/billing-email", () => ({ sendPlanWelcomeEmail: vi.fn() }));
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
