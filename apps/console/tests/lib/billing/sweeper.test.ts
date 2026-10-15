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
//
// #6078: the relink retry's bookkeeping (`relinkRetryAfter`, `relinkAdoptedHold`) over a faked store —
// the backoff schedule, the one give-up alert raised only by the caller whose write landed, a decided
// outcome clearing the check, a lost lease writing nothing, and a failed write never hiding the result.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PendingOrgSetupRow } from "@/lib/billing/pending-org-setup";
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
		renewPurchaseLease: vi.fn(async () => true),
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
	writeAdoptedRelinkState: vi.fn(async () => null),
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
import { openHold, writeAdoptedRelinkState } from "@/lib/billing/payment-holds/store";
import {
	linkSetupToOrg,
	RELINK_MAX_ATTEMPTS,
	RELINK_RETRY_DELAYS_MS,
	RELINK_UNDELIVERED_ALERT_RETRY_MS,
	relinkAdoptedHold,
	relinkRetryAfter,
} from "@/lib/billing/payment-holds/sweeper";
import { PurchaseLeaseLostError, renewPurchaseLease } from "@/lib/billing/purchase-lease";
import { markPendingOrgSetupLinked, pendingOrgSetupFor, recordSetupRefusal } from "@/lib/billing/pending-org-setup";
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

describe("#6078: the relink retry's bookkeeping", () => {
	const LEASE = { key: `user:${USER}`, holder: "holder-1" };
	const NOW = new Date("2026-10-14T12:00:00Z");
	const alert = vi.fn(async () => true);
	const deps = { alert, now: () => NOW };

	/** A `new_org` hold on X released `adopted`, after `attempts` failed relinks. */
	function adopted(attempts: number): PaymentHoldRow {
		const at = new Date("2026-10-14T11:00:00Z");
		return {
			id: "hold_x",
			subscription_id: X,
			customer_id: "cus_x",
			scope: "new_org",
			payer_key: USER,
			invoice_id: "in_x",
			payment_intent_id: null,
			state: "released",
			release_reason: "adopted",
			released_at: at,
			released_by: null,
			release_note: null,
			refund_attempt: 0,
			attempts,
			last_error: null,
			next_check_at: at,
			alerted_at: null,
			notice_last_sent_at: null,
			notified_state: null,
			notified_at: null,
			opened_by_user_id: USER,
			opened_by: "purchase",
			open_note: null,
			state_since: at,
			last_pay: "succeeded",
			refund_action_since: null,
			age_alerted_at: null,
			observed_at: at,
			nudged_at: null,
			version: 4,
			created_at: at,
			updated_at: at,
		};
	}

	/** USER's open setup for X, recorded for team ORG. */
	function setupRow(): PendingOrgSetupRow {
		const at = new Date("2026-10-14T10:00:00Z");
		return {
			id: "setup_x",
			user_id: USER,
			subscription_id: X,
			customer_id: "cus_x",
			intended_name: "Acme",
			intended_slug: "acme",
			billing: null,
			created_org_id: ORG,
			creating_at: null,
			linked_at: null,
			declared_at: null,
			closed_at: null,
			closed_reason: null,
			closed_by: null,
			closed_note: null,
			refused_reason: null,
			created_at: at,
			updated_at: at,
		};
	}

	beforeEach(() => {
		alert.mockReset();
		alert.mockResolvedValue(true);
	});

	it("the schedule: 5m, 15m, 1h, 4h, 12h, and the sixth failure gives up", () => {
		expect(RELINK_RETRY_DELAYS_MS).toEqual([5, 15, 60, 240, 720].map((m) => m * 60_000));
		expect(RELINK_MAX_ATTEMPTS).toBe(6);
		expect([1, 2, 3, 4, 5].map((n) => relinkRetryAfter(n))).toEqual(
			RELINK_RETRY_DELAYS_MS.map((delayMs) => ({ kind: "retry", delayMs })),
		);
		expect(relinkRetryAfter(6)).toEqual({ kind: "give_up" });
		expect(relinkRetryAfter(9)).toEqual({ kind: "give_up" });
		expect(relinkRetryAfter(0)).toEqual({ kind: "retry", delayMs: RELINK_RETRY_DELAYS_MS[0] });
	});

	it("a thrown relink records the next attempt on the hold's version, and alerts nothing", async () => {
		vi.mocked(pendingOrgSetupFor).mockRejectedValueOnce(new Error("connection reset"));
		await expect(relinkAdoptedHold(LEASE, adopted(1), deps)).resolves.toBeNull();
		expect(writeAdoptedRelinkState).toHaveBeenCalledWith(LEASE, { id: "hold_x", version: 4 }, {
			attempts: 2,
			lastError: "connection reset",
			nextCheckAt: new Date(NOW.getTime() + 15 * 60_000),
		});
		expect(alert).not.toHaveBeenCalled();
	});

	it("the sixth failure claims the decision FIRST, alerts, and clears the check with alerted_at only when the alert reached a channel", async () => {
		vi.mocked(pendingOrgSetupFor).mockRejectedValueOnce(new Error("connection reset"));
		const claimed = { ...adopted(6), version: 5 };
		vi.mocked(writeAdoptedRelinkState).mockResolvedValueOnce(claimed);
		await relinkAdoptedHold(LEASE, adopted(5), deps);
		expect(vi.mocked(writeAdoptedRelinkState).mock.calls).toEqual([
			[LEASE, { id: "hold_x", version: 4 }, { attempts: 6, lastError: "connection reset", nextCheckAt: new Date(NOW.getTime() + RELINK_UNDELIVERED_ALERT_RETRY_MS) }],
			[LEASE, { id: "hold_x", version: 5 }, { nextCheckAt: null, alertedAt: NOW }],
		]);
		expect(alert).toHaveBeenCalledTimes(1);
		expect(alert.mock.calls[0]).toEqual([expect.objectContaining({ subscriptionId: X, customerId: "cus_x", paymentIntentId: null })]);
		expect(vi.mocked(alert).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(writeAdoptedRelinkState).mock.invocationCallOrder[1] ?? 0);
		expect(vi.mocked(alert).mock.invocationCallOrder[0]).toBeGreaterThan(vi.mocked(writeAdoptedRelinkState).mock.invocationCallOrder[0] ?? Infinity);
	});

	it("an alert that reached no channel stamps nothing: the claim's day-later check stays, so it is raised again", async () => {
		vi.mocked(pendingOrgSetupFor).mockRejectedValueOnce(new Error("connection reset"));
		vi.mocked(writeAdoptedRelinkState).mockResolvedValueOnce(adopted(6));
		alert.mockResolvedValueOnce(false);
		await relinkAdoptedHold(LEASE, adopted(5), deps);
		expect(alert).toHaveBeenCalledTimes(1);
		expect(writeAdoptedRelinkState).toHaveBeenCalledTimes(1);
	});

	it("a claim that matched nothing (another caller decided first) raises nothing", async () => {
		vi.mocked(pendingOrgSetupFor).mockRejectedValueOnce(new Error("connection reset"));
		vi.mocked(writeAdoptedRelinkState).mockResolvedValueOnce(null);
		await relinkAdoptedHold(LEASE, adopted(5), deps);
		expect(alert).not.toHaveBeenCalled();
	});

	it("a not_linked check's held alert is NOT raised when the claim write's compare-and-set loses", async () => {
		// The creator's team has no active membership for them, so the check fails and its alert is held.
		vi.mocked(pendingOrgSetupFor).mockResolvedValueOnce(setupRow());
		vi.mocked(writeAdoptedRelinkState).mockResolvedValueOnce(null);
		await expect(relinkAdoptedHold(LEASE, adopted(0), deps)).resolves.toMatchObject({ kind: "not_linked" });
		expect(writeAdoptedRelinkState).toHaveBeenCalledTimes(1);
		expect(alert).not.toHaveBeenCalled();
	});

	it("a not_linked check's held alert IS raised when the claim lands, and stamped when it reached a channel", async () => {
		vi.mocked(pendingOrgSetupFor).mockResolvedValueOnce(setupRow());
		vi.mocked(writeAdoptedRelinkState).mockResolvedValueOnce({ ...adopted(0), version: 5 });
		await expect(relinkAdoptedHold(LEASE, adopted(0), deps)).resolves.toMatchObject({ kind: "not_linked" });
		expect(alert).toHaveBeenCalledTimes(1);
		expect(vi.mocked(writeAdoptedRelinkState).mock.calls[1]).toEqual([LEASE, { id: "hold_x", version: 5 }, { nextCheckAt: null, alertedAt: NOW }]);
	});

	it("a lease taken over before the record is thrown, with nothing written and no alert", async () => {
		vi.mocked(renewPurchaseLease).mockResolvedValueOnce(false);
		await expect(relinkAdoptedHold(LEASE, adopted(0), deps)).rejects.toBeInstanceOf(PurchaseLeaseLostError);
		expect(writeAdoptedRelinkState).not.toHaveBeenCalled();
		expect(alert).not.toHaveBeenCalled();
	});

	it("a lost lease is thrown with nothing written", async () => {
		vi.mocked(pendingOrgSetupFor).mockRejectedValueOnce(new PurchaseLeaseLostError(LEASE.key));
		await expect(relinkAdoptedHold(LEASE, adopted(0), deps)).rejects.toBeInstanceOf(PurchaseLeaseLostError);
		expect(writeAdoptedRelinkState).not.toHaveBeenCalled();
	});

	it("a decided relink (no open setup) clears the check, and its result survives a failed write", async () => {
		await expect(relinkAdoptedHold(LEASE, adopted(0), deps)).resolves.toEqual({ kind: "no_setup" });
		expect(writeAdoptedRelinkState).toHaveBeenCalledWith(LEASE, { id: "hold_x", version: 4 }, { nextCheckAt: null });
		vi.mocked(writeAdoptedRelinkState).mockRejectedValueOnce(new Error("database is unavailable"));
		await expect(relinkAdoptedHold(LEASE, adopted(0), deps)).resolves.toEqual({ kind: "no_setup" });
		expect(alert).not.toHaveBeenCalled();
	});
});
