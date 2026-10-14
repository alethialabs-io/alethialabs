// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #6043 (S9 follow-up 3): the link's refusal beside the org's other live plan, when the payer's lease is
// lost at the moment the `link_refused` hold is opened (ADR 0002 §5.6 "The refused sync", I14).
//
// After the sync, X's Stripe metadata already names the org O (the link wrote it before the sync), and
// a lost lease opens no hold. So the refusal is recorded nowhere unless the link alerts: these cases pin
// that it does, once, naming X and O, and that it does not when an open hold already names X or when X's
// metadata names no org. Which links are refused is unchanged: every case here is refused, and throws
// the lost lease, as before.
//
// What is faked is what the link's core writes through: Stripe (`world.subs`), the org's billing row
// (`world.row`), the sync, the hold store, the setup record module and the alert. The store's SQL, and
// the same race against real Postgres, are in tests/integration/payment-hold-sweeper.test.ts.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PaymentHoldRow } from "@/lib/db/schema";

/** A subscription as the fake Stripe holds it. */
interface FakeSub {
	id: string;
	status: string;
	customer: string;
	latest_invoice: string | null;
	metadata: Record<string, string>;
}

const world = vi.hoisted(() => ({
	subs: new Map<string, FakeSub>(),
	/** The org's billing row: the subscription it names and that subscription's status. */
	row: null as null | { stripeSubscriptionId: string | null; status: string },
	/** What `openHold` answers. */
	open: { kind: "lease_lost" } as { kind: "lease_lost" } | { kind: "opened"; hold: PaymentHoldRow },
	/** The open hold on X `openHoldOn` reads, if any (only the fields the link reads of it). */
	openOnX: null as null | { id: string; subscription_id: string },
	/** `openHoldOn` throws (a database read failure). */
	openOnXThrows: false,
	/** Runs inside the sync: the race the test stages. */
	onSync: null as null | (() => void),
}));

vi.mock("@/lib/billing/stripe", () => {
	const client = {
		subscriptions: {
			update: vi.fn(async (id: string, params: { metadata: Record<string, string> }) => {
				const s = world.subs.get(id);
				if (!s) throw new Error(`No such subscription: ${id}`);
				s.metadata = { ...s.metadata, ...params.metadata };
				return { ...s, metadata: { ...s.metadata } };
			}),
		},
		customers: { update: vi.fn(async (id: string) => ({ id })) },
	};
	return { getStripe: () => client, getPurchaseStripe: () => client, STRIPE_REQUEST_TIMEOUT_MS: 20_000, STRIPE_MAX_NETWORK_RETRIES: 1 };
});
vi.mock("@/lib/billing/sync", () => ({
	mapStatus: vi.fn(),
	// Takes a row that names nothing live, or names X; otherwise the row's guard ignores X.
	syncSubscriptionToBilling: vi.fn(async (sub: { id: string; status: string }) => {
		world.onSync?.();
		const row = world.row;
		if (row && row.stripeSubscriptionId !== sub.id && ["active", "trialing", "past_due"].includes(row.status)) return "ignored";
		world.row = { stripeSubscriptionId: sub.id, status: sub.status };
		return "applied";
	}),
}));
vi.mock("@/lib/billing/queries", () => ({
	getOrgBilling: vi.fn(async () => (world.row ? { ...world.row } : null)),
}));
// The only direct read on the paths here is the org's name, before the customer write.
vi.mock("@/lib/db", () => {
	const chain: Record<string, unknown> = {};
	for (const m of ["select", "from", "where", "limit", "update", "set"]) chain[m] = () => chain;
	chain.then = (resolve: (v: unknown[]) => unknown) => Promise.resolve([{ name: "Acme" }]).then(resolve);
	return { getServiceDb: () => chain };
});
vi.mock("@/lib/billing/purchase-lease", () => {
	class PurchaseLeaseLostError extends Error {
		constructor(key: string) {
			super(`lease ${key} lost`);
		}
	}
	return {
		PurchaseLeaseLostError,
		fenceFor: () => async () => undefined,
		tryAcquirePurchaseLease: vi.fn(),
		releasePurchaseLease: vi.fn(),
	};
});
vi.mock("@/lib/billing/payment-holds/store", () => ({
	openHold: vi.fn(async () => world.open),
	openHoldOn: vi.fn(async () => {
		if (world.openOnXThrows) throw new Error("connection reset");
		return world.openOnX;
	}),
	writeHoldState: vi.fn(async () => null),
	releaseHold: vi.fn(),
	reserveRefundAttempt: vi.fn(),
}));
vi.mock("@/lib/billing/payment-alert", () => ({ alertPaymentNeedsSupport: vi.fn(async () => true) }));
vi.mock("@/lib/billing/pending-org-setup", () => ({
	logBillingEvent: vi.fn(),
	markPendingOrgSetupLinked: vi.fn(async () => undefined),
	pendingOrgSetupFor: vi.fn(async () => null),
	recordSetupRefusal: vi.fn(async () => null),
}));
vi.mock("@/lib/auth/scope", () => ({ getActiveScope: vi.fn() }));
vi.mock("@/lib/authz", () => ({ getPdp: vi.fn() }));
vi.mock("@/lib/billing/payment-holds/emails", () => ({ deliverHoldNotice: vi.fn(), sendDueHoldNotices: vi.fn() }));
vi.mock("@/lib/observability/heartbeats", () => ({ registerLoop: vi.fn(), superviseLoop: vi.fn() }));

import type Stripe from "stripe";
import { alertPaymentNeedsSupport } from "@/lib/billing/payment-alert";
import { openHold } from "@/lib/billing/payment-holds/store";
import { linkSetupToOrg } from "@/lib/billing/payment-holds/sweeper";
import { PurchaseLeaseLostError } from "@/lib/billing/purchase-lease";
import { markPendingOrgSetupLinked, recordSetupRefusal } from "@/lib/billing/pending-org-setup";
import { getPurchaseStripe } from "@/lib/billing/stripe";

const USER = "user-1";
const ORG = "org-1";
const X = "sub_x";
const Y = "sub_y";

/** Puts X, live and minted by USER, in the fake Stripe, with `metadata` over its own. */
function subX(metadata: Record<string, string> = {}): FakeSub {
	const sub: FakeSub = { id: X, status: "active", customer: "cus_x", latest_invoice: "in_x", metadata: { created_by: USER, ...metadata } };
	world.subs.set(X, sub);
	return sub;
}

/**
 * X as the link's caller passes it. The fake carries only the fields the core reads, so this is the one
 * place it meets the SDK's type; a guard, not a cast, so a missing field fails here.
 */
function asStripeSub(sub: FakeSub): Stripe.Subscription {
	const value: unknown = { ...sub, metadata: { ...sub.metadata } };
	if (!isStripeSubscription(value)) throw new Error("fixture: not a subscription");
	return value;
}

/** Narrows the fixture to a Stripe subscription by the fields the core reads. */
function isStripeSubscription(v: unknown): v is Stripe.Subscription {
	return typeof v === "object" && v !== null && "id" in v && "customer" in v && "metadata" in v && "latest_invoice" in v;
}

/** Runs the link's core for X under a lease, as the session's link and the re-link do. */
function link(sub: FakeSub) {
	return linkSetupToOrg({ userId: USER, orgId: ORG, sub: asStripeSub(sub), customerId: "cus_x", lease: { key: `user:${USER}`, holder: "holder-1" } });
}

/** The alerts raised with X as the subject. */
function alertsOnX() {
	return vi.mocked(alertPaymentNeedsSupport).mock.calls.map((c) => c[0]).filter((a) => a.subscriptionId === X);
}

beforeEach(() => {
	vi.clearAllMocks();
	world.subs.clear();
	world.row = null;
	world.open = { kind: "lease_lost" };
	world.openOnX = null;
	world.openOnXThrows = false;
	world.onSync = null;
});

describe("#6043: a lease lost in the link's refusal after X's metadata names O", () => {
	it("Y takes the row during the sync and the lease is lost at the hold's open: refused by throwing the lost lease, and alerted once naming X and O", async () => {
		const sub = subX();
		world.onSync = () => {
			world.row = { stripeSubscriptionId: Y, status: "active" };
		};

		await expect(link(sub)).rejects.toBeInstanceOf(PurchaseLeaseLostError);

		// The refusal was reached after X's metadata write, and the lost lease opened nothing.
		expect(world.subs.get(X)?.metadata.organization_id).toBe(ORG);
		expect(vi.mocked(getPurchaseStripe().subscriptions.update)).toHaveBeenCalledTimes(1);
		expect(openHold).toHaveBeenCalledTimes(1);
		expect(recordSetupRefusal).not.toHaveBeenCalled();
		expect(markPendingOrgSetupLinked).not.toHaveBeenCalled();
		// The operator is told at once: X is the subject, and the detail names O and the row's Y.
		const alerts = alertsOnX();
		expect(alerts).toHaveLength(1);
		expect(alerts[0]).toMatchObject({ subscriptionId: X, customerId: "cus_x", paymentIntentId: null, context: "link_refused" });
		expect(alerts[0]?.detail).toContain(`team ${ORG}`);
		expect(alerts[0]?.detail).toContain(Y);
		expect(alerts[0]?.detail).toMatch(/no hold/);
	});

	it("X already names O when the link starts, the row names Y, and the lease is lost: alerted once, nothing written", async () => {
		const sub = subX({ organization_id: ORG });
		world.row = { stripeSubscriptionId: Y, status: "active" };

		await expect(link(sub)).rejects.toBeInstanceOf(PurchaseLeaseLostError);

		expect(vi.mocked(getPurchaseStripe().subscriptions.update)).not.toHaveBeenCalled();
		expect(recordSetupRefusal).not.toHaveBeenCalled();
		expect(alertsOnX()).toHaveLength(1);
	});

	it("dedupe: an open hold already names X (another caller recorded the refusal) — no alert, the lost lease is thrown", async () => {
		const sub = subX();
		world.onSync = () => {
			world.row = { stripeSubscriptionId: Y, status: "active" };
		};
		world.openOnX = { id: "hold_other", subscription_id: X };

		await expect(link(sub)).rejects.toBeInstanceOf(PurchaseLeaseLostError);
		expect(alertsOnX()).toHaveLength(0);
	});

	it("a failed read of X's open hold still alerts: the alert is never lost to its own dedupe", async () => {
		const sub = subX();
		world.onSync = () => {
			world.row = { stripeSubscriptionId: Y, status: "active" };
		};
		world.openOnXThrows = true;

		await expect(link(sub)).rejects.toBeInstanceOf(PurchaseLeaseLostError);
		expect(alertsOnX()).toHaveLength(1);
	});

	it("control: refused BEFORE any Stripe write, X naming no org, and the lease lost — nothing written and no alert, as before", async () => {
		const sub = subX();
		world.row = { stripeSubscriptionId: Y, status: "active" };

		await expect(link(sub)).rejects.toBeInstanceOf(PurchaseLeaseLostError);

		expect(vi.mocked(getPurchaseStripe().subscriptions.update)).not.toHaveBeenCalled();
		expect(world.subs.get(X)?.metadata.organization_id).toBeUndefined();
		expect(alertsOnX()).toHaveLength(0);
		expect(recordSetupRefusal).not.toHaveBeenCalled();
	});
});
