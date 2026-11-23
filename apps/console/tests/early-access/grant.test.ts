// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The grant half of EA-3 (#7325): set-plan with an AI tier and the Early Access notice, through
// provision.setOrgPlan. The acceptance line this file holds: a grant creates no Stripe customer,
// subscription or invoice — the Stripe SDK is replaced by a constructor that records any use.

import { beforeEach, describe, expect, it, vi } from "vitest";

const stripeUse = vi.hoisted(() => ({ constructed: 0 }));
vi.mock("stripe", () => ({
	default: vi.fn(function StripeCtor() {
		stripeUse.constructed += 1;
		throw new Error("a grant must not reach Stripe");
	}),
}));
vi.mock("@/lib/billing/stripe", () => ({
	getStripe: () => {
		stripeUse.constructed += 1;
		throw new Error("a grant must not reach Stripe");
	},
}));

const db = vi.hoisted(() => ({
	/** Results for successive `.select()…limit()` reads, in call order. */
	reads: [] as unknown[][],
	inserts: [] as { values: unknown; set: unknown }[],
}));
vi.mock("@/lib/db", () => ({
	getServiceDb: () => ({
		select: () => ({
			from: () => ({ where: () => ({ limit: async () => db.reads.shift() ?? [] }) }),
		}),
		insert: () => ({
			values: (values: unknown) => ({
				onConflictDoUpdate: async ({ set }: { set: unknown }) => {
					db.inserts.push({ values, set });
				},
			}),
		}),
	}),
}));

const billing = vi.hoisted(() => ({
	upsertOrgBilling: vi.fn(async () => undefined),
	claimPlanWelcome: vi.fn(async () => true),
}));
vi.mock("@/lib/billing/queries", () => billing);

const emails = vi.hoisted(() => ({
	sendPlanWelcomeEmailForOrg: vi.fn(async () => undefined),
	sendEarlyAccessGrantedEmail: vi.fn(async () => true),
}));
vi.mock("@/lib/email/billing-email", () => ({ sendPlanWelcomeEmailForOrg: emails.sendPlanWelcomeEmailForOrg }));
vi.mock("@/lib/early-access/notify", () => ({ sendEarlyAccessGrantedEmail: emails.sendEarlyAccessGrantedEmail }));
vi.mock("@/lib/email/notify-email", () => ({ sendInviteEmail: vi.fn() }));

vi.mock("@/lib/auth/internal-auth", () => ({ isPlatformProvisionAuthorized: () => true }));

import { POST } from "@/app/api/internal/platform/set-plan/route";
import { ProvisionError, setOrgPlan } from "@/lib/platform/provision";

const ORG = "11111111-1111-4111-8111-111111111111";
const END = new Date("2027-02-21T00:00:00.000Z");

/** A POST to set-plan with `body`. */
function post(body: unknown): Request {
	return new Request("http://console/api/internal/platform/set-plan", {
		method: "POST",
		body: JSON.stringify(body),
	});
}

beforeEach(() => {
	stripeUse.constructed = 0;
	db.reads = [];
	db.inserts = [];
	billing.upsertOrgBilling.mockClear();
	billing.claimPlanWelcome.mockClear();
	emails.sendPlanWelcomeEmailForOrg.mockClear();
	emails.sendEarlyAccessGrantedEmail.mockClear();
	process.env.PLATFORM_PROVISION_SECRET = "test";
});

describe("setOrgPlan — the complimentary Team grant", () => {
	it("sets the plan with its term end, sends the complimentary email instead of the welcome, and never touches Stripe", async () => {
		db.reads = [[{ id: ORG }]];
		await setOrgPlan({ orgId: ORG, plan: "team", status: "active", periodEnd: END, earlyAccessGrant: "team" });
		expect(billing.upsertOrgBilling).toHaveBeenCalledWith({
			organizationId: ORG,
			plan: "team",
			status: "active",
			seats: null,
			currentPeriodEnd: END,
		});
		expect(emails.sendEarlyAccessGrantedEmail).toHaveBeenCalledWith({ orgId: ORG, plan: "team", periodEnd: END });
		// The welcome is not claimed, so an organization that subscribes later still gets it then.
		expect(billing.claimPlanWelcome).not.toHaveBeenCalled();
		expect(emails.sendPlanWelcomeEmailForOrg).not.toHaveBeenCalled();
		expect(stripeUse.constructed).toBe(0);
	});

	it("still sends the ordinary welcome for a grant that is not Early Access", async () => {
		db.reads = [[{ id: ORG }]];
		await setOrgPlan({ orgId: ORG, plan: "enterprise", status: "active", periodEnd: END });
		expect(billing.claimPlanWelcome).toHaveBeenCalledWith(ORG);
		expect(emails.sendPlanWelcomeEmailForOrg).toHaveBeenCalled();
		expect(emails.sendEarlyAccessGrantedEmail).not.toHaveBeenCalled();
	});
});

describe("setOrgPlan — an AI tier", () => {
	it("writes only the AI columns plus the term end, with no subscription id, and never touches Stripe", async () => {
		db.reads = [[{ id: ORG }], []];
		await setOrgPlan({
			orgId: ORG,
			ai: { tier: "ai_plus", status: "active" },
			periodEnd: END,
			earlyAccessGrant: "ai_plus",
		});
		expect(billing.upsertOrgBilling).not.toHaveBeenCalled();
		expect(db.inserts).toHaveLength(1);
		expect(db.inserts[0]?.set).toMatchObject({
			aiTier: "ai_plus",
			aiSubscriptionStatus: "active",
			aiStripeSubscriptionId: null,
			currentPeriodEnd: END,
		});
		expect(emails.sendEarlyAccessGrantedEmail).toHaveBeenCalledWith({ orgId: ORG, plan: "ai_plus", periodEnd: END });
		expect(stripeUse.constructed).toBe(0);
	});

	it("refuses to overwrite a Stripe AI subscription", async () => {
		db.reads = [[{ id: ORG }], [{ aiStripeSubscriptionId: "sub_ai", stripeSubscriptionId: null }]];
		await expect(setOrgPlan({ orgId: ORG, ai: { tier: "ai_max", status: "active" }, periodEnd: END })).rejects.toThrow(
			ProvisionError,
		);
		expect(db.inserts).toEqual([]);
	});

	it("refuses a time-limited AI grant on a Stripe plan subscription, where it could never lapse", async () => {
		db.reads = [[{ id: ORG }], [{ aiStripeSubscriptionId: null, stripeSubscriptionId: "sub_plan", plan: "team", status: "active" }]];
		await expect(setOrgPlan({ orgId: ORG, ai: { tier: "ai_plus", status: "active" }, periodEnd: END })).rejects.toThrow(
			/never lapse/,
		);
	});

	it("refuses to silently move the term of a live off-Stripe plan grant", async () => {
		db.reads = [
			[{ id: ORG }],
			[
				{
					aiStripeSubscriptionId: null,
					stripeSubscriptionId: null,
					plan: "team",
					status: "active",
					currentPeriodEnd: new Date("2027-05-01T00:00:00Z"),
				},
			],
		];
		await expect(setOrgPlan({ orgId: ORG, ai: { tier: "ai_plus", status: "active" }, periodEnd: END })).rejects.toThrow(
			/different term end/,
		);
	});

	it("refuses an empty or half-given write", async () => {
		await expect(setOrgPlan({ orgId: ORG })).rejects.toThrow(ProvisionError);
		await expect(setOrgPlan({ orgId: ORG, plan: "team" })).rejects.toThrow(ProvisionError);
	});
});

describe("set-plan route", () => {
	it("accepts an AI-tier-only Early Access grant", async () => {
		db.reads = [[{ id: ORG }], []];
		const res = await POST(
			post({
				orgId: ORG,
				aiTier: "ai_max",
				aiStatus: "active",
				periodEnd: END.toISOString(),
				earlyAccessGrant: "ai_max",
			}),
		);
		expect(res.status).toBe(200);
		expect(db.inserts[0]?.set).toMatchObject({ aiTier: "ai_max", aiSubscriptionStatus: "active" });
		expect(stripeUse.constructed).toBe(0);
	});

	it("still accepts the existing plan-only body", async () => {
		db.reads = [[{ id: ORG }]];
		const res = await POST(post({ orgId: ORG, plan: "team", status: "active", periodEnd: null }));
		expect(res.status).toBe(200);
		expect(billing.upsertOrgBilling).toHaveBeenCalled();
	});

	it("refuses a body that splits a pair or sets nothing", async () => {
		for (const body of [
			{ orgId: ORG },
			{ orgId: ORG, plan: "team" },
			{ orgId: ORG, aiTier: "ai_plus" },
			{ orgId: ORG, aiTier: "ai_ultra", aiStatus: "active" },
			{ orgId: ORG, plan: "team", status: "active", earlyAccessGrant: "enterprise" },
		]) {
			const res = await POST(post(body));
			expect(res.status).toBe(400);
		}
	});

	it("answers 409 with the refusal when the grant would overwrite a Stripe AI subscription", async () => {
		db.reads = [[{ id: ORG }], [{ aiStripeSubscriptionId: "sub_ai" }]];
		const res = await POST(post({ orgId: ORG, aiTier: "ai_plus", aiStatus: "active" }));
		expect(res.status).toBe(409);
	});
});
