// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// lib/billing/org-plan-row.ts on its own (ADR 0004 D4, D6): the org-plan classification of §2, R1's
// choice order, and the two-live report's contract. The webhook's use of them is
// tests/lib/billing/webhook-handler.test.ts (W); the guarded write's is
// tests/integration/billing-sync.test.ts (S).

import type Stripe from "stripe";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/billing/config", () => ({
	planForPriceId: () => "team",
	aiTierForPriceId: (id: string) => (id === "price_ai" ? "ai_plus" : null),
}));
vi.mock("@/lib/billing/operator-alert", () => ({ alertOperator: vi.fn(async () => true) }));
vi.mock("@/lib/billing/sync", async (importActual) => ({
	...(await importActual<typeof import("@/lib/billing/sync")>()),
	syncSubscriptionToBilling: vi.fn(async () => "applied"),
}));

// org-plan-row is imported BEFORE sync on purpose. The two modules import each other, and the sync mock's
// factory loads the real sync: imported first, the real sync would load org-plan-row while the mock is
// still being built, and org-plan-row would bind the real sync instead of the mock.
import {
	chooseSuccessor,
	isOrgPlanSubscriptionOf,
	type OrgPlanStripe,
	reconcileAfterSync,
	reportReplacedLivePlan,
	reportTwoLive,
} from "@/lib/billing/org-plan-row";
import { alertOperator } from "@/lib/billing/operator-alert";
import type { PlanSlotWrite } from "@/lib/billing/queries";
import { syncSubscriptionToBilling } from "@/lib/billing/sync";

/** True when a fixture carries what the module reads off a subscription. */
function isSubscriptionFixture(x: unknown): x is Stripe.Subscription {
	return typeof x === "object" && x !== null && "id" in x && "status" in x && "created" in x && "items" in x;
}

/** A subscription with one licensed line on `priceId`, and the given metadata. */
function sub(
	id: string,
	status: string,
	created: number,
	metadata: Record<string, string> = { organization_id: "org_1" },
	priceId = "price_team",
): Stripe.Subscription {
	const fixture: unknown = {
		id,
		status,
		created,
		customer: "cus_1",
		metadata,
		items: { data: [{ id: `si_${id}`, price: { id: priceId, recurring: { usage_type: "licensed" } } }] },
	};
	if (!isSubscriptionFixture(fixture)) throw new Error("subscription fixture is malformed");
	return fixture;
}

describe("isOrgPlanSubscriptionOf (ADR 0004 §2)", () => {
	it("is the org's own non-AI subscription, linked create-a-team ones included", () => {
		expect(isOrgPlanSubscriptionOf(sub("a", "active", 1), "org_1")).toBe(true);
		expect(isOrgPlanSubscriptionOf(sub("b", "active", 1, { organization_id: "org_1", created_by: "u" }), "org_1")).toBe(true);
	});

	it("is not another org's, an unlinked one, one with a product_type, or one on an AI price", () => {
		expect(isOrgPlanSubscriptionOf(sub("a", "active", 1, { organization_id: "org_2" }), "org_1")).toBe(false);
		expect(isOrgPlanSubscriptionOf(sub("b", "active", 1, { created_by: "u" }), "org_1")).toBe(false);
		expect(
			isOrgPlanSubscriptionOf(sub("c", "active", 1, { organization_id: "org_1", product_type: "ai_subscription" }), "org_1"),
		).toBe(false);
		expect(isOrgPlanSubscriptionOf(sub("d", "active", 1, { organization_id: "org_1" }, "price_ai"), "org_1")).toBe(false);
	});
});

describe("chooseSuccessor — R1's order: active, then trialing, then any other live (C47)", () => {
	it("names the newest active one over a newer trial", () => {
		const named = chooseSuccessor([sub("x1", "active", 1), sub("t", "trialing", 9), sub("x2", "active", 5)]);
		expect(named?.id).toBe("x2");
	});

	it("names the newest trialing one when nothing is active, and else the newest other live one", () => {
		expect(chooseSuccessor([sub("p", "past_due", 9), sub("t", "trialing", 1)])?.id).toBe("t");
		expect(chooseSuccessor([sub("p1", "past_due", 1), sub("u", "unpaid", 7), sub("z", "paused", 3)])?.id).toBe("u");
		expect(chooseSuccessor([])).toBeNull();
	});
});

describe("reportTwoLive and reportReplacedLivePlan (D6)", () => {
	beforeEach(() => {
		vi.mocked(alertOperator).mockReset().mockResolvedValue(true);
		vi.spyOn(console, "info").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
	});
	afterEach(() => vi.restoreAllMocks());

	it("logs billing.org_plan.two_live with both ids, and alerts with the newer subscription as subject", async () => {
		await reportTwoLive(
			"org_1",
			{ subscriptionId: "sub_old", status: "active", created: 1 },
			{ subscriptionId: "sub_new", status: "active", created: 2 },
		);
		expect(console.info).toHaveBeenCalledWith(expect.stringContaining('"event":"billing.org_plan.two_live"'));
		expect(console.info).toHaveBeenCalledWith(expect.stringContaining("sub_old"));
		expect(alertOperator).toHaveBeenCalledTimes(1);
		const [alert] = vi.mocked(alertOperator).mock.calls[0] ?? [];
		expect(alert?.subject).toEqual({ type: "stripe_subscription", id: "sub_new" });
		expect(alert?.summary).toContain("sub_old");
		expect(alert?.summary).not.toMatch(/purchase flow cancelled/);
	});

	it("never throws, even when the alert does", async () => {
		vi.mocked(alertOperator).mockRejectedValue(new Error("boom"));
		await expect(
			reportTwoLive("org_1", { subscriptionId: "a", status: "active", created: null }, { subscriptionId: null, status: "active", created: null }),
		).resolves.toBeUndefined();
	});

	it("D6b reports a replaced past_due subscription and a live grant, never a lapsed grant, an ended slot or no row", async () => {
		const x = sub("sub_x", "active", 5);
		await reportReplacedLivePlan("org_1", x, { subscriptionId: "sub_y", status: "past_due", currentPeriodEnd: null });
		await reportReplacedLivePlan("org_1", x, {
			subscriptionId: null,
			status: "past_due",
			currentPeriodEnd: new Date(Date.now() + 86_400_000),
		});
		expect(alertOperator).toHaveBeenCalledTimes(2);

		await reportReplacedLivePlan("org_1", x, {
			subscriptionId: null,
			status: "active",
			currentPeriodEnd: new Date(Date.now() - 86_400_000),
		});
		await reportReplacedLivePlan("org_1", x, { subscriptionId: "sub_y", status: "canceled", currentPeriodEnd: null });
		await reportReplacedLivePlan("org_1", x, { subscriptionId: "sub_y", status: "none", currentPeriodEnd: null });
		await reportReplacedLivePlan("org_1", x, null);
		expect(alertOperator).toHaveBeenCalledTimes(2);
	});
});

describe("reconcileAfterSync — R2 returns the ended Y only when its end applied and no PAID successor took the row", () => {
	/** A Stripe that reads only Y, as ended. */
	const stripe: OrgPlanStripe = {
		subscriptions: {
			list: async () => ({ data: [], has_more: false }),
			retrieve: async (id: string) => sub(id, "canceled", 1),
		},
	};
	/** The refused write of `x` beside a row that names live Y. */
	const refusedBesideY: PlanSlotWrite = {
		applied: false,
		before: { subscriptionId: "sub_y", status: "active", currentPeriodEnd: null },
	};

	/** Scripts the two syncs R2 makes: Y's end, then X again. */
	function syncs(yOutcome: "applied" | "ignored", xOutcome: "applied" | "ignored"): void {
		vi.mocked(syncSubscriptionToBilling).mockReset().mockResolvedValueOnce(yOutcome).mockResolvedValueOnce(xOutcome);
	}

	it("Y's end applied and an unpaid X took the row: Y is returned, so its cancellation is reported", async () => {
		syncs("applied", "applied");
		const y = await reconcileAfterSync(stripe, sub("sub_x", "past_due", 2), "ignored", refusedBesideY, {});
		expect(y?.id).toBe("sub_y");
	});

	it("Y's end applied and a PAID X took the row: nothing is returned (the plan did not end)", async () => {
		syncs("applied", "applied");
		expect(await reconcileAfterSync(stripe, sub("sub_x", "active", 2), "ignored", refusedBesideY, {})).toBeNull();
	});

	it("Y's end did NOT apply (the row moved meanwhile): nothing is returned, so nothing is reported", async () => {
		syncs("ignored", "applied");
		expect(await reconcileAfterSync(stripe, sub("sub_x", "past_due", 2), "ignored", refusedBesideY, {})).toBeNull();
	});

	it("a PAID X whose re-sync was refused did not take the row: Y's end is still reported", async () => {
		syncs("applied", "ignored");
		const y = await reconcileAfterSync(stripe, sub("sub_x", "active", 2), "ignored", refusedBesideY, {});
		expect(y?.id).toBe("sub_y");
	});
});
