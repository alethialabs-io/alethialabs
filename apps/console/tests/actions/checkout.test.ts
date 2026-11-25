// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The provider-neutral purchase actions (app/server/actions/checkout.ts, Paddle L4), over a mocked
// boundary: the seam's routing, our own consents (the purchase gate) BEFORE Paddle is asked anything,
// the order written before the transaction and cancelled when it cannot be opened, the Stripe path
// left to its existing flow, and the plan card's lifecycle writes on whichever provider holds them.

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
	const updates: unknown[] = [];
	/** A drizzle-shaped chain: every call returns the chain; awaiting it yields `rows`. */
	function chain(rows: unknown[]) {
		const target: Record<string, unknown> = {};
		const proxy: unknown = new Proxy(target, {
			get(_t, prop) {
				if (prop === "then") return (resolve: (v: unknown) => void) => resolve(rows);
				return (...args: unknown[]) => {
					if (prop === "set") updates.push(args[0]);
					return proxy;
				};
			},
		});
		return proxy;
	}
	return {
		updates,
		chain,
		authorize: vi.fn(),
		authorizeInOrg: vi.fn(),
		currentActor: vi.fn(),
		getOrgBilling: vi.fn(),
		providerForOrg: vi.fn(),
		providerById: vi.fn(),
		salesProvider: vi.fn(),
		assertGate: vi.fn(),
		prepareMorOrder: vi.fn(),
		recordPaidOrder: vi.fn(),
		attachPaddleTransaction: vi.fn(),
		cancelUnopenedOrder: vi.fn(),
		resolveAiTier: vi.fn(),
		cancelSubscription: vi.fn(),
		resumeSubscription: vi.fn(),
		changeSubscriptionPlan: vi.fn(),
		createBillingPortalSession: vi.fn(),
	};
});

vi.mock("@/lib/authz/guard", () => ({
	authorize: h.authorize,
	authorizeInOrg: h.authorizeInOrg,
	currentActor: h.currentActor,
}));
vi.mock("@/lib/billing/queries", () => ({ getOrgBilling: h.getOrgBilling }));
vi.mock("@/lib/billing/provider/select", () => ({
	providerForOrg: h.providerForOrg,
	providerById: h.providerById,
	salesProvider: h.salesProvider,
}));
vi.mock("@/lib/billing/eligibility", async (importActual) => {
	const actual = await importActual<typeof import("@/lib/billing/eligibility")>();
	return { PaidConversionNotAllowedError: actual.PaidConversionNotAllowedError, assertOrgPaidConversionAllowed: h.assertGate };
});
vi.mock("@/lib/billing/paid-order", async (importActual) => {
	const actual = await importActual<typeof import("@/lib/billing/paid-order")>();
	return {
		orderBillingAddressSchema: actual.orderBillingAddressSchema,
		PaidOrderRefusedError: actual.PaidOrderRefusedError,
		prepareMorOrder: h.prepareMorOrder,
		recordPaidOrder: h.recordPaidOrder,
		attachPaddleTransaction: h.attachPaddleTransaction,
		cancelUnopenedOrder: h.cancelUnopenedOrder,
	};
});
vi.mock("@/lib/billing/purchase-lock", () => ({
	withPurchaseLock: async (_key: string, fn: () => Promise<unknown>) => ({ acquired: true, value: await fn() }),
}));
vi.mock("@/lib/billing/seats", () => ({ countBillableSeats: async () => 3 }));
vi.mock("@/lib/billing/ai-plan", () => ({ resolveAiTier: h.resolveAiTier }));
vi.mock("@/lib/billing/paddle/config", () => ({
	getPaddleConfig: () => ({ appUrl: "https://console.example.invalid" }),
}));
vi.mock("@/lib/db", () => ({
	getServiceDb: () => ({
		select: () => h.chain([{ email: "owner@example.com" }]),
		update: () => h.chain([]),
	}),
}));
vi.mock("@/lib/observability/log", () => ({ log: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock("@/app/server/actions/billing", () => ({
	cancelSubscription: h.cancelSubscription,
	resumeSubscription: h.resumeSubscription,
	changeSubscriptionPlan: h.changeSubscriptionPlan,
	createBillingPortalSession: h.createBillingPortalSession,
}));

import {
	cancelSubscriptionPlan,
	changeSubscriptionPlanTo,
	checkoutRail,
	openBillingPortal,
	resumeSubscriptionPlan,
	startCheckout,
} from "@/app/server/actions/checkout";
import { PaidConversionNotAllowedError } from "@/lib/billing/eligibility";

const ORG = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";
const ACTOR = { userId: USER, orgId: ORG };

const ORDER = {
	organizationId: ORG,
	placedByUserId: USER,
	capacity: "organization",
	authorityAttestation: "CEO",
	billingCountry: "DE",
	billingState: null,
	vatIdStatus: "given",
	vatId: "DE123456789",
	billingName: "Acme GmbH",
	billingAddress: { line1: "Str 1", line2: null, city: "Berlin", postalCode: "10115", region: null, country: "DE" },
};

/** A billing row with only the fields the actions read. */
function row(over: Record<string, unknown> = {}) {
	return {
		plan: "community",
		status: "none",
		aiSubscriptionStatus: "none",
		stripeSubscriptionId: null,
		paddleSubscriptionId: null,
		aiStripeSubscriptionId: null,
		aiPaddleSubscriptionId: null,
		paddleCustomerId: null,
		paddleAddressId: null,
		paddleBusinessId: null,
		currentPeriodEnd: null,
		...over,
	};
}

/** A Paddle adapter whose methods are spies. */
function paddleAdapter() {
	return {
		id: "paddle",
		isConfigured: () => true,
		startPurchase: vi.fn(async () => ({
			kind: "paddle_checkout",
			transactionId: "txn_01abc",
			clientToken: "test_tok",
			environment: "sandbox",
			customer: { customerId: "ctm_1", addressId: "add_1", businessId: "biz_1" },
		})),
		managementUrl: vi.fn(async () => "https://customer-portal.paddle.com/x"),
		cancelAtPeriodEnd: vi.fn(async () => undefined),
		resume: vi.fn(async () => undefined),
		changePlan: vi.fn(async () => undefined),
	};
}

let adapter: ReturnType<typeof paddleAdapter>;

beforeEach(() => {
	vi.clearAllMocks();
	h.updates.length = 0;
	adapter = paddleAdapter();
	h.authorize.mockResolvedValue(ACTOR);
	h.authorizeInOrg.mockResolvedValue(ACTOR);
	h.currentActor.mockResolvedValue(ACTOR);
	h.getOrgBilling.mockResolvedValue(row());
	h.providerForOrg.mockReturnValue("paddle");
	h.providerById.mockReturnValue(adapter);
	h.assertGate.mockResolvedValue(undefined);
	h.prepareMorOrder.mockResolvedValue(ORDER);
	h.recordPaidOrder.mockResolvedValue("33333333-3333-4333-8333-333333333333");
	h.resolveAiTier.mockResolvedValue("ai_plus");
});

describe("startCheckout — routing", () => {
	it("leaves a Stripe-routed org to its existing card flow, touching nothing", async () => {
		h.providerForOrg.mockReturnValue("stripe");
		const res = await startCheckout({ item: { kind: "plan", plan: "team" } });
		expect(res).toEqual({ ok: true, data: { provider: "stripe" } });
		expect(h.assertGate).not.toHaveBeenCalled();
		expect(h.recordPaidOrder).not.toHaveBeenCalled();
	});

	it("refuses the personal scope and an unwired deploy", async () => {
		h.authorize.mockResolvedValueOnce({ userId: USER, orgId: USER });
		const personal = await startCheckout({ item: { kind: "plan", plan: "team" } });
		expect(personal).toMatchObject({ ok: false, error: { kind: "conflict" } });
		h.providerForOrg.mockReturnValue(null);
		const unwired = await startCheckout({ item: { kind: "plan", plan: "team" } });
		expect(unwired).toMatchObject({ ok: false, error: { kind: "conflict", message: "Billing is not enabled on this deployment." } });
	});

	it("buys for a NAMED org (create-a-team, O2) through authorizeInOrg", async () => {
		await startCheckout({ orgId: ORG, item: { kind: "plan", plan: "team" } });
		expect(h.authorizeInOrg).toHaveBeenCalledWith("manage_billing", { type: "billing" }, ORG);
		expect(h.authorize).not.toHaveBeenCalled();
	});
});

describe("startCheckout — Paddle", () => {
	it("gates, records the order, then creates the transaction carrying the order id; returns only the id + public token", async () => {
		const res = await startCheckout({ item: { kind: "plan", plan: "team" } });
		expect(res).toEqual({
			ok: true,
			data: { provider: "paddle", transactionId: "txn_01abc", clientToken: "test_tok", environment: "sandbox" },
		});
		// Pro is per seat: the gate judges the whole sale.
		expect(h.assertGate).toHaveBeenCalledWith(USER, ORG, { amountMinor: expect.any(Number), currency: "usd" });
		expect(h.recordPaidOrder).toHaveBeenCalledWith(ORDER, expect.objectContaining({ productId: "team", provider: "paddle" }));
		const gateOrder = h.assertGate.mock.invocationCallOrder[0];
		const orderOrder = h.recordPaidOrder.mock.invocationCallOrder[0];
		const txnOrder = adapter.startPurchase.mock.invocationCallOrder[0];
		expect(gateOrder).toBeLessThan(orderOrder);
		expect(orderOrder).toBeLessThan(txnOrder);
		expect(adapter.startPurchase).toHaveBeenCalledWith(
			expect.objectContaining({
				organizationId: ORG,
				userId: USER,
				item: { kind: "plan", plan: "team", seats: 3 },
				commerceOrderId: "33333333-3333-4333-8333-333333333333",
				buyer: expect.objectContaining({
					email: "owner@example.com",
					business: { name: "Acme GmbH", taxIdentifier: "DE123456789" },
					address: expect.objectContaining({ countryCode: "DE", city: "Berlin" }),
				}),
			}),
		);
		expect(h.attachPaddleTransaction).toHaveBeenCalledWith("33333333-3333-4333-8333-333333333333", "txn_01abc");
		// The customer records are kept on the org's row for the next checkout and the portal.
		expect(h.updates).toContainEqual(
			expect.objectContaining({ paddleCustomerId: "ctm_1", paddleAddressId: "add_1", paddleBusinessId: "biz_1" }),
		);
	});

	it("asks Paddle for nothing when our consents refuse (terms, declaration, market)", async () => {
		h.assertGate.mockRejectedValue(new PaidConversionNotAllowedError("terms_not_accepted", "Accept the current Terms first."));
		const res = await startCheckout({ item: { kind: "plan", plan: "team" } });
		expect(res).toEqual({ ok: false, error: { kind: "conflict", message: "Accept the current Terms first." } });
		expect(h.recordPaidOrder).not.toHaveBeenCalled();
		expect(adapter.startPurchase).not.toHaveBeenCalled();
	});

	it("cancels the order when the transaction cannot be created", async () => {
		adapter.startPurchase.mockRejectedValue(new Error("paddle down"));
		const res = await startCheckout({ item: { kind: "plan", plan: "team" } });
		expect(res).toMatchObject({ ok: false, error: { kind: "unexpected" } });
		expect(h.cancelUnopenedOrder).toHaveBeenCalledWith("33333333-3333-4333-8333-333333333333");
		expect(h.attachPaddleTransaction).not.toHaveBeenCalled();
	});

	it("refuses a plan beside a live one, but converts a local card-less trial", async () => {
		h.getOrgBilling.mockResolvedValue(row({ plan: "team", status: "active", paddleSubscriptionId: "sub_1" }));
		const live = await startCheckout({ item: { kind: "plan", plan: "team" } });
		expect(live).toMatchObject({ ok: false, error: { kind: "conflict" } });
		h.getOrgBilling.mockResolvedValue(row({ plan: "team", status: "trialing" }));
		const trial = await startCheckout({ item: { kind: "plan", plan: "team" } });
		expect(trial).toMatchObject({ ok: true, data: { provider: "paddle" } });
	});

	it("sells a credit pack as a one-time purchase only on a paid AI tier (O6)", async () => {
		const res = await startCheckout({ item: { kind: "credit_pack", packId: "s" } });
		expect(res).toMatchObject({ ok: true });
		expect(adapter.startPurchase).toHaveBeenCalledWith(expect.objectContaining({ item: { kind: "credit_pack", credits: 5000 } }));
		expect(h.recordPaidOrder).toHaveBeenCalledWith(
			ORDER,
			expect.objectContaining({ productId: "ai_credits:s", periodDays: 0, renewsAutomatically: false }),
		);
		h.resolveAiTier.mockResolvedValue("ai_free");
		const free = await startCheckout({ item: { kind: "credit_pack", packId: "s" } });
		expect(free).toMatchObject({ ok: false, error: { kind: "conflict" } });
	});

	it("refuses an AI tier beside a live AI subscription", async () => {
		h.getOrgBilling.mockResolvedValue(row({ aiPaddleSubscriptionId: "sub_ai", aiSubscriptionStatus: "active" }));
		const res = await startCheckout({ item: { kind: "ai_tier", tier: "ai_max" } });
		expect(res).toMatchObject({ ok: false, error: { kind: "conflict" } });
	});
});

describe("checkoutRail", () => {
	it("names the instance's sales provider", async () => {
		h.salesProvider.mockReturnValue("paddle");
		await expect(checkoutRail()).resolves.toEqual({ provider: "paddle" });
	});
});

describe("portal and lifecycle", () => {
	it("opens Paddle's portal for a Paddle org, Stripe's for a Stripe org", async () => {
		await expect(openBillingPortal({})).resolves.toEqual({ ok: true, data: { url: "https://customer-portal.paddle.com/x" } });
		h.providerForOrg.mockReturnValue("stripe");
		h.createBillingPortalSession.mockResolvedValue({ url: "https://billing.stripe.com/x" });
		await expect(openBillingPortal({})).resolves.toEqual({ ok: true, data: { url: "https://billing.stripe.com/x" } });
	});

	it("cancels and resumes a Paddle plan, stamping cancel_effective_at for the card", async () => {
		const end = new Date("2026-12-01T00:00:00Z");
		h.getOrgBilling.mockResolvedValue(row({ plan: "team", status: "active", paddleSubscriptionId: "sub_1", currentPeriodEnd: end }));
		await expect(cancelSubscriptionPlan({})).resolves.toEqual({ ok: true, data: { ok: true } });
		expect(adapter.cancelAtPeriodEnd).toHaveBeenCalledWith({ organizationId: ORG, subscriptionId: "sub_1", slot: "plan" });
		expect(h.updates).toContainEqual(expect.objectContaining({ cancelEffectiveAt: end }));
		await expect(resumeSubscriptionPlan({})).resolves.toEqual({ ok: true, data: { ok: true } });
		expect(adapter.resume).toHaveBeenCalledWith({ organizationId: ORG, subscriptionId: "sub_1", slot: "plan" });
		expect(h.updates).toContainEqual(expect.objectContaining({ cancelEffectiveAt: null }));
		// Cancelling is never gated.
		expect(h.assertGate).not.toHaveBeenCalled();
	});

	it("routes a Stripe org's cancel and resume to the existing Stripe actions", async () => {
		h.providerForOrg.mockReturnValue("stripe");
		h.cancelSubscription.mockResolvedValue({ ok: true });
		h.resumeSubscription.mockResolvedValue({ ok: true });
		await cancelSubscriptionPlan({});
		await resumeSubscriptionPlan({});
		expect(h.cancelSubscription).toHaveBeenCalledTimes(1);
		expect(h.resumeSubscription).toHaveBeenCalledTimes(1);
		expect(adapter.cancelAtPeriodEnd).not.toHaveBeenCalled();
	});

	it("changes a Paddle plan through the gate and the adapter", async () => {
		h.getOrgBilling.mockResolvedValue(row({ aiPaddleSubscriptionId: "sub_ai", aiSubscriptionStatus: "active" }));
		await expect(changeSubscriptionPlanTo({ item: { kind: "ai_tier", tier: "ai_max" } })).resolves.toEqual({
			ok: true,
			data: { ok: true },
		});
		expect(h.assertGate).toHaveBeenCalledWith(USER, ORG);
		expect(adapter.changePlan).toHaveBeenCalledWith(
			{ organizationId: ORG, subscriptionId: "sub_ai", slot: "ai" },
			{ kind: "ai_tier", tier: "ai_max" },
		);
	});
});
