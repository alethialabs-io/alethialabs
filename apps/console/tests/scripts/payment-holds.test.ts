// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// The payment-hold operator command (scripts/payment-holds.ts), the sweeper it runs
// (lib/billing/payment-holds/sweeper.ts), the sweeper's emails (emails.ts) and its cron twin
// (app/api/internal/payment-holds/sweep) — ADR 0002 §5.4, §8, Q3; S6 #5783. None of them exists on dev,
// so every case fails there at the import.
//
// The database is a queue here (each awaited query pops the next result), and the store, the lease and
// Stripe are mocked: these pin the DECISIONS — what is advanced, alerted, mailed, released, held or
// listed, and what each refuses. The SQL fences (the claim's compare-and-set, the lease, `version`) are
// pinned against Postgres in tests/integration/payment-hold-sweeper.test.ts.
//
// ADR 0004 C42 (O1, #6001): `list --scope org_plan` lists only those holds, and `release <sub>` of an
// `org_plan` hold takes `org-plan:<O>` and writes `released(operator)`.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ getServiceDb: vi.fn() }));
vi.mock("@/lib/billing/stripe", () => ({ getStripe: vi.fn(), getPurchaseStripe: vi.fn() }));
vi.mock("@/lib/billing/payment-alert", () => ({ alertPaymentNeedsSupport: vi.fn() }));
vi.mock("@/lib/email/billing-email", () => ({ sendPaymentHoldNoticeEmail: vi.fn() }));
vi.mock("@/lib/billing/purchase-lease", () => ({
	tryAcquirePurchaseLease: vi.fn(),
	acquirePurchaseLease: vi.fn(),
	releasePurchaseLease: vi.fn(),
	renewPurchaseLease: vi.fn(),
	fenceFor: vi.fn(() => async () => undefined),
}));
// The real sweeper, with `relinkAdoptedSetup` observable: the moved release must never re-link (C98).
vi.mock("@/lib/billing/payment-holds/sweeper", async (importOriginal) => {
	const real = await importOriginal<typeof import("@/lib/billing/payment-holds/sweeper")>();
	return { ...real, relinkAdoptedSetup: vi.fn(real.relinkAdoptedSetup) };
});
// Two fixed prices for F3's classification (`isOrgPlanSubscription`): one AI tier, everything else a plan.
vi.mock("@/lib/billing/config", async (importOriginal) => {
	const real = await importOriginal<typeof import("@/lib/billing/config")>();
	return { ...real, aiTierForPriceId: (id: string) => (id === "price_ai_plus" ? "ai_plus" : null) };
});
vi.mock("@/lib/billing/payment-holds/store", () => ({
	writeHoldState: vi.fn(),
	reserveRefundAttempt: vi.fn(),
	releaseHold: vi.fn(),
	openHold: vi.fn(),
	claimHoldNotice: vi.fn(),
	unclaimHoldNotice: vi.fn(),
}));
vi.mock("@/lib/email/guard", () => ({ sendGuardedEmail: vi.fn() }));
vi.mock("@/lib/auth/internal-auth", async (importOriginal) => {
	const real = await importOriginal<typeof import("@/lib/auth/internal-auth")>();
	return { ...real, isInternalAuthorized: vi.fn(real.isInternalAuthorized) };
});

import { render } from "@react-email/components";
import type Stripe from "stripe";
import { PgDialect } from "drizzle-orm/pg-core";
import { is, SQL } from "drizzle-orm";
import { POST } from "@/app/api/internal/payment-holds/sweep/route";
import { isInternalAuthorized } from "@/lib/auth/internal-auth";
import { sendDueHoldNotices } from "@/lib/billing/payment-holds/emails";
import * as store from "@/lib/billing/payment-holds/store";
import {
	ageAlertFor,
	type HoldStripe,
	runPaymentHoldSweep,
	type SweepDeps,
} from "@/lib/billing/payment-holds/sweeper";
import * as lease from "@/lib/billing/purchase-lease";
import { alertPaymentNeedsSupport } from "@/lib/billing/payment-alert";
import { LINK_REFUSED_NOTE } from "@/lib/billing/payment-holds/machine";
import type { withPurchaseLock } from "@/lib/billing/purchase-lock";
import { getPurchaseStripe } from "@/lib/billing/stripe";
import { isOrgPlanSubscription } from "@/lib/billing/sync";
import { getServiceDb } from "@/lib/db";
import type { BillingStatus } from "@/lib/db/schema/enums";
import { PAYMENT_HOLD_NOTIFIED_STATES, type PaymentHoldRow } from "@/lib/db/schema";
import { sendGuardedEmail } from "@/lib/email/guard";
import {
	type BackfillStripe,
	type BackfillSubscription,
	backfillVerdict,
	main,
	type MovedReleaseDeps,
	type MovedStripe,
	releaseHoldCommand,
	runBackfill,
	type ServerDeps,
} from "@/scripts/payment-holds";
import * as sweeper from "@/lib/billing/payment-holds/sweeper";

const NOW = new Date("2026-10-09T12:00:00.000Z");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const LEASE = { key: "user:payer-1", holder: "holder-1" };

/** A thenable drizzle-ish chain whose terminal `await` pops the next queued result. */
function makeDb() {
	const queue: unknown[][] = [];
	const calls: string[] = [];
	const wheres: unknown[] = [];
	const chain: Record<string, unknown> = {};
	for (const m of ["from", "orderBy", "limit", "returning", "set", "values", "innerJoin"]) {
		chain[m] = () => chain;
	}
	chain.where = (predicate: unknown) => {
		wheres.push(predicate);
		return chain;
	};
	chain.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
		Promise.resolve(queue.shift() ?? []).then(resolve, reject);
	const op = (name: string) =>
		vi.fn(() => {
			calls.push(name);
			return chain;
		});
	const db = { select: op("select"), update: op("update"), insert: op("insert") };
	return { db, queue, calls, wheres };
}

/** A hold row as the database holds it. */
function hold(over: Partial<PaymentHoldRow> = {}): PaymentHoldRow {
	return {
		id: "hold-1",
		subscription_id: "sub_x",
		customer_id: "cus_x",
		scope: "new_org",
		payer_key: "payer-1",
		invoice_id: "in_x",
		payment_intent_id: null,
		state: "closing",
		release_reason: null,
		released_at: null,
		released_by: null,
		release_note: null,
		refund_attempt: 0,
		attempts: 0,
		last_error: null,
		next_check_at: NOW,
		alerted_at: null,
		notice_last_sent_at: null,
		notified_state: null,
		notified_at: null,
		opened_by_user_id: "payer-1",
		opened_by: "purchase",
		open_note: null,
		state_since: NOW,
		last_pay: null,
		refund_action_since: null,
		age_alerted_at: null,
		observed_at: NOW,
		nudged_at: null,
		version: 0,
		created_at: NOW,
		updated_at: NOW,
		...over,
	};
}

/** A fake Stripe account holding one subscription, its held invoice and its PaymentIntents. */
function fakeStripe(w: { sub: string; invoice: string; pis?: Array<{ id: string; status: string; amount: number }> }) {
	const log: string[] = [];
	const pis = w.pis ?? [];
	const stripe: HoldStripe = {
		subscriptions: {
			retrieve: async () => {
				log.push("subscriptions.retrieve");
				return { status: w.sub };
			},
			cancel: async (_id, params) => {
				log.push(`subscriptions.cancel:${params.cancellation_details.comment}`);
				w.sub = "canceled";
				return {};
			},
		},
		invoices: {
			retrieve: async () => {
				log.push("invoices.retrieve");
				return { status: w.invoice };
			},
			voidInvoice: async () => {
				log.push("invoices.voidInvoice");
				w.invoice = "void";
				return {};
			},
			del: async () => {
				log.push("invoices.del");
				return {};
			},
		},
		invoicePayments: {
			list: async () => {
				log.push("invoicePayments.list");
				return {
					has_more: false,
					data: pis.map((p) => ({
						status: p.status === "succeeded" ? "paid" : "open",
						payment: {
							type: "payment_intent",
							payment_intent: { id: p.id, status: p.status, amount_received: p.status === "succeeded" ? p.amount : 0 },
						},
					})),
				};
			},
		},
		paymentIntents: {
			retrieve: async (id) => ({ id, status: "requires_payment_method", amount_received: 0 }),
			cancel: async () => {
				log.push("paymentIntents.cancel");
				return {};
			},
		},
		refunds: {
			list: async () => ({ has_more: false, data: [] }),
			create: async () => {
				log.push("refunds.create");
				return {};
			},
		},
	};
	return { stripe, log };
}

let db: ReturnType<typeof makeDb>;
let info: ReturnType<typeof vi.spyOn>;
let printed: string[];
const print = (line: string) => {
	printed.push(line);
};
const alert = vi.fn<SweepDeps["alert"]>(async () => true);
const deliver = vi.fn<SweepDeps["deliver"]>(async () => undefined);

/** Sweep deps over `stripe`. */
function depsOver(stripe: HoldStripe): SweepDeps {
	return { stripe: () => stripe, alert, deliver, now: () => NOW };
}

/** The stable event names written to console.info. */
function events(): string[] {
	return info.mock.calls.flatMap((c: unknown[]) => {
		try {
			const parsed: unknown = JSON.parse(String(c[0]));
			const name = typeof parsed === "object" && parsed !== null ? Reflect.get(parsed, "event") : null;
			return typeof name === "string" ? [name] : [];
		} catch {
			return [];
		}
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	db = makeDb();
	printed = [];
	vi.mocked(getServiceDb).mockReturnValue(db.db as never);
	vi.mocked(lease.tryAcquirePurchaseLease).mockResolvedValue(LEASE);
	vi.mocked(lease.acquirePurchaseLease).mockResolvedValue(LEASE);
	vi.mocked(lease.releasePurchaseLease).mockResolvedValue(undefined);
	vi.mocked(store.writeHoldState).mockImplementation(async (_l, ref, patch) =>
		hold({ id: ref.id, version: ref.version + 1, ...(patch.state ? { state: patch.state } : {}) }),
	);
	vi.mocked(store.releaseHold).mockImplementation(async (_l, ref, input) => ({
		hold: hold({ id: ref.id, version: ref.version + 1, state: "released", release_reason: input.reason }),
		closedSetupId: null,
	}));
	vi.mocked(store.claimHoldNotice).mockResolvedValue(true);
	info = vi.spyOn(console, "info").mockImplementation(() => undefined);
	vi.spyOn(console, "error").mockImplementation(() => undefined);
	vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
	vi.restoreAllMocks();
});

// ── The age alerts (§5.4, I11) ──────────────────────────────────────────────────────────────────────

describe("ageAlertFor (§5.4)", () => {
	const at = (ms: number) => new Date(NOW.getTime() + ms);

	it("closing / cancel_unproven: by the last observation — 24h awaiting, 1h succeeded, 8d capturable, 14d in flight", () => {
		for (const state of ["closing", "cancel_unproven"] as const) {
			expect(ageAlertFor(hold({ state, last_pay: "awaiting" }), at(23 * HOUR))).toBeNull();
			expect(ageAlertFor(hold({ state, last_pay: "awaiting" }), at(DAY))).not.toBeNull();
			expect(ageAlertFor(hold({ state, last_pay: null }), at(DAY))).not.toBeNull();
			expect(ageAlertFor(hold({ state, last_pay: "succeeded" }), at(HOUR))).not.toBeNull();
			expect(ageAlertFor(hold({ state, last_pay: "capturable" }), at(7 * DAY))).toBeNull();
			expect(ageAlertFor(hold({ state, last_pay: "capturable" }), at(8 * DAY))).not.toBeNull();
		}
	});

	it("C61: a T4-shaped hold (a payment in flight) is not alerted at 72h, and is at 14 days", () => {
		const t4 = hold({ state: "closing", last_pay: "in_flight" });
		expect(ageAlertFor(t4, at(72 * HOUR))).toBeNull();
		expect(ageAlertFor(t4, at(13 * DAY))).toBeNull();
		expect(ageAlertFor(t4, at(14 * DAY))).toMatch(/payment still processing/);
	});

	it("payment_in_flight 14d (8d capturable), invoice_payable 24h, refund_due's 48h backstop", () => {
		expect(ageAlertFor(hold({ state: "payment_in_flight", last_pay: "in_flight" }), at(13 * DAY))).toBeNull();
		expect(ageAlertFor(hold({ state: "payment_in_flight", last_pay: "in_flight" }), at(14 * DAY))).not.toBeNull();
		expect(ageAlertFor(hold({ state: "payment_in_flight", last_pay: "capturable" }), at(8 * DAY))).not.toBeNull();
		expect(ageAlertFor(hold({ state: "invoice_payable" }), at(DAY - 1))).toBeNull();
		expect(ageAlertFor(hold({ state: "invoice_payable" }), at(DAY))).not.toBeNull();
		expect(ageAlertFor(hold({ state: "refund_due" }), at(47 * HOUR))).toBeNull();
		expect(ageAlertFor(hold({ state: "refund_due" }), at(48 * HOUR))).not.toBeNull();
	});

	it("C59: refund_pending alerts 24h after a refund went requires_action (from refund_action_since), else at 14 days", () => {
		const action = hold({ state: "refund_pending", state_since: at(-10 * DAY), refund_action_since: NOW });
		expect(ageAlertFor(action, at(23 * HOUR))).toBeNull();
		expect(ageAlertFor(action, at(25 * HOUR))).toMatch(/requires_action/);
		const settling = hold({ state: "refund_pending" });
		expect(ageAlertFor(settling, at(13 * DAY))).toBeNull();
		expect(ageAlertFor(settling, at(14 * DAY))).not.toBeNull();
	});

	it("every live hold alert names the hold, not the purchase flow (the backfill opens holds too)", async () => {
		const input = { subscriptionId: "sub_x", customerId: "cus_x", paymentIntentId: null, detail: "d" };
		await sweeper.liveSweepDeps().alert(input);
		expect(alertPaymentNeedsSupport).toHaveBeenCalledWith({ ...input, context: "payment_hold" });
		const real = await vi.importActual<typeof import("@/lib/billing/payment-alert")>("@/lib/billing/payment-alert");
		const logged = vi.mocked(console.error);
		logged.mockClear();
		await real.alertPaymentNeedsSupport({ ...input, context: "payment_hold" });
		expect(String(logged.mock.calls[0]?.[0])).toMatch(/a payment hold is settling/);
		expect(String(logged.mock.calls[0]?.[0])).not.toMatch(/purchase flow/);
	});

	it("refund_pending: the 14-day alert still fires after the requires_action alert of the same entry, once", () => {
		const entry = hold({
			state: "refund_pending",
			refund_action_since: NOW,
			age_alerted_at: at(25 * HOUR), // the requires_action alert
		});
		expect(ageAlertFor(entry, at(13 * DAY))).toBeNull();
		expect(ageAlertFor(entry, at(14 * DAY))).toMatch(/refund_pending since/);
		expect(ageAlertFor({ ...entry, age_alerted_at: at(14 * DAY) }, at(20 * DAY))).toBeNull();
		// A refund that goes requires_action again later re-arms its own 24h bound.
		const again = { ...entry, age_alerted_at: at(14 * DAY), refund_action_since: at(15 * DAY) };
		expect(ageAlertFor(again, at(16 * DAY))).toMatch(/requires_action/);
	});

	it("once per state entry: an age alert at or after state_since silences the state; a new entry re-arms it", () => {
		const alerted = hold({ state: "invoice_payable", age_alerted_at: at(DAY) });
		expect(ageAlertFor(alerted, at(30 * DAY))).toBeNull();
		const reentered = hold({ state: "invoice_payable", age_alerted_at: at(-1), state_since: NOW });
		expect(ageAlertFor(reentered, at(DAY))).not.toBeNull();
	});

	it("needs_operator: only when its entry alert did not reach a channel — 24h, then every 7 days", () => {
		expect(ageAlertFor(hold({ state: "needs_operator", alerted_at: NOW }), at(30 * DAY))).toBeNull();
		const undelivered = hold({ state: "needs_operator", alerted_at: null });
		expect(ageAlertFor(undelivered, at(23 * HOUR))).toBeNull();
		expect(ageAlertFor(undelivered, at(DAY))).not.toBeNull();
		const reminded = hold({ state: "needs_operator", alerted_at: null, age_alerted_at: at(DAY) });
		expect(ageAlertFor(reminded, at(7 * DAY))).toBeNull();
		expect(ageAlertFor(reminded, at(8 * DAY))).not.toBeNull();
	});

	it("a released hold is never alerted", () => {
		expect(ageAlertFor(hold({ state: "released", release_reason: "operator" }), at(365 * DAY))).toBeNull();
	});
});

// ── The sweeper tick (§5.4) ─────────────────────────────────────────────────────────────────────────

describe("runPaymentHoldSweep", () => {
	it("C53: advances a due hold under its payer's lease — void, then the stamped cancel — and gives the lease back", async () => {
		const { stripe, log } = fakeStripe({ sub: "incomplete", invoice: "open" });
		db.queue.push([hold()], [hold()], []); // due; the re-read under the lease; owed emails
		const result = await runPaymentHoldSweep({ deps: depsOver(stripe) });
		expect(result).toMatchObject({ due: 1, advanced: 1, released: 1, busy: 0 });
		expect(lease.tryAcquirePurchaseLease).toHaveBeenCalledWith("user:payer-1");
		expect(log.filter((l) => !l.endsWith("retrieve") && l !== "invoicePayments.list")).toEqual([
			"invoices.voidInvoice",
			"subscriptions.cancel:alethia:checkout_closed:hold-1",
		]);
		expect(store.releaseHold).toHaveBeenCalledWith(LEASE, expect.anything(), expect.objectContaining({ reason: "voided_unpaid" }));
		expect(lease.releasePurchaseLease).toHaveBeenCalledWith(LEASE);
	});

	it("a hold whose payer's lease is busy is skipped: no Stripe call, no write", async () => {
		const { stripe, log } = fakeStripe({ sub: "incomplete", invoice: "open" });
		vi.mocked(lease.tryAcquirePurchaseLease).mockResolvedValue(null);
		db.queue.push([hold()], []);
		const result = await runPaymentHoldSweep({ deps: depsOver(stripe) });
		expect(result).toMatchObject({ due: 1, advanced: 0, busy: 1 });
		expect(log).toEqual([]);
		expect(store.writeHoldState).not.toHaveBeenCalled();
		expect(store.releaseHold).not.toHaveBeenCalled();
	});

	it("a hold released between the selection and the lease is not advanced, and its lease is given back", async () => {
		const { stripe, log } = fakeStripe({ sub: "incomplete", invoice: "open" });
		db.queue.push([hold()], [], []);
		const result = await runPaymentHoldSweep({ deps: depsOver(stripe) });
		expect(result.advanced).toBe(0);
		expect(log).toEqual([]);
		expect(lease.releasePurchaseLease).toHaveBeenCalledWith(LEASE);
	});

	it("C61: the age alert is stamped by a fenced state write FIRST, and raised once", async () => {
		const old = new Date(NOW.getTime() - 15 * DAY);
		const t4 = hold({ state: "closing", last_pay: "in_flight", state_since: old });
		const { stripe } = fakeStripe({ sub: "incomplete", invoice: "open", pis: [{ id: "pi_1", status: "processing", amount: 0 }] });
		vi.mocked(store.writeHoldState).mockImplementation(async (_l, ref, patch) =>
			hold({ ...t4, version: ref.version + 1, ...(patch.ageAlertedAt ? { age_alerted_at: patch.ageAlertedAt } : {}) }),
		);
		db.queue.push([t4], [t4], []);
		const result = await runPaymentHoldSweep({ deps: depsOver(stripe) });
		expect(result.ageAlerts).toBe(1);
		expect(alert).toHaveBeenCalledTimes(1);
		expect(alert.mock.calls[0]?.[0]).toMatchObject({ subscriptionId: "sub_x", detail: expect.stringMatching(/processing/) });
		const stampOrder = vi.mocked(store.writeHoldState).mock.invocationCallOrder.at(-1) ?? 0;
		expect(stampOrder).toBeLessThan(alert.mock.invocationCallOrder[0] ?? 0);
		expect(vi.mocked(store.writeHoldState).mock.calls.at(-1)?.[2]).toEqual({ ageAlertedAt: NOW });
	});

	it("no alert when the age stamp matched no row (another caller moved the hold)", async () => {
		const old = new Date(NOW.getTime() - 15 * DAY);
		const t4 = hold({ state: "closing", last_pay: "in_flight", state_since: old });
		const { stripe } = fakeStripe({ sub: "incomplete", invoice: "open", pis: [{ id: "pi_1", status: "processing", amount: 0 }] });
		vi.mocked(store.writeHoldState)
			.mockResolvedValueOnce(t4) // advanceHold's T4 write
			.mockResolvedValueOnce(null); // the age stamp misses
		db.queue.push([t4], [t4], []);
		const result = await runPaymentHoldSweep({ deps: depsOver(stripe) });
		expect(result.ageAlerts).toBe(0);
		expect(alert).not.toHaveBeenCalled();
	});

	it("one hold's failure does not stop the batch", async () => {
		const { stripe } = fakeStripe({ sub: "incomplete", invoice: "open" });
		vi.mocked(lease.tryAcquirePurchaseLease).mockRejectedValueOnce(new Error("db blip")).mockResolvedValueOnce(LEASE);
		db.queue.push([hold({ id: "hold-a" }), hold({ id: "hold-b", subscription_id: "sub_b" })], [hold({ id: "hold-b", subscription_id: "sub_b" })], []);
		const result = await runPaymentHoldSweep({ deps: depsOver(stripe) });
		expect(result).toMatchObject({ due: 2, advanced: 1, released: 1 });
	});
});

// ── The Q3 emails (C95) ─────────────────────────────────────────────────────────────────────────────

describe("sendDueHoldNotices (Q3, C95)", () => {
	it("the claim matches the hold's CURRENT state in the same statement (a failed refund is never told it is on its way)", async () => {
		const real = await vi.importActual<typeof import("@/lib/billing/payment-holds/store")>(
			"@/lib/billing/payment-holds/store",
		);
		const dialect = new PgDialect();
		const rendered = async (notice: "refund_pending" | "released:refunded" | "released:adopted") => {
			db.wheres.length = 0;
			db.queue.push([{ id: "hold-1" }]);
			expect(await real.claimHoldNotice("hold-1", notice)).toBe(true);
			const where = db.wheres[0];
			if (!is(where, SQL)) throw new Error("the claim built no SQL predicate");
			return dialect.sqlToQuery(where);
		};
		const pending = await rendered("refund_pending");
		expect(pending.sql).toMatch(/"payment_holds"\."state" = \$\d+/);
		expect(pending.params).toEqual(expect.arrayContaining(["hold-1", "refund_pending"]));
		const refunded = await rendered("released:refunded");
		expect(refunded.sql).toMatch(/"payment_holds"\."release_reason" = \$\d+/);
		expect(refunded.params).toEqual(expect.arrayContaining(["released", "refunded", "released:refunded"]));
		const adopted = await rendered("released:adopted");
		expect(adopted.params).toEqual(expect.arrayContaining(["released", "adopted"]));
	});

	it("mails a hold only when ITS claim wrote the row: a lost claim sends nothing", async () => {
		db.queue.push([hold({ state: "refund_pending" })]);
		vi.mocked(store.claimHoldNotice).mockResolvedValueOnce(false);
		expect(await sendDueHoldNotices({ deliver })).toBe(0);
		expect(deliver).not.toHaveBeenCalled();
	});

	it("claims, then sends, once per hold and state", async () => {
		db.queue.push([
			hold({ id: "h-pending", state: "refund_pending" }),
			hold({ id: "h-refunded", state: "released", release_reason: "refunded", released_at: NOW }),
		]);
		expect(await sendDueHoldNotices({ deliver })).toBe(2);
		expect(vi.mocked(store.claimHoldNotice).mock.calls).toEqual([
			["h-pending", "refund_pending"],
			["h-refunded", "released:refunded"],
		]);
		expect(deliver.mock.calls.map((c) => c[1])).toEqual(["refund_pending", "released:refunded"]);
		const claimOrder = vi.mocked(store.claimHoldNotice).mock.invocationCallOrder[0] ?? 0;
		expect(claimOrder).toBeLessThan(deliver.mock.invocationCallOrder[0] ?? 0);
	});

	it("a send that throws gives the claim back, so the next tick retries", async () => {
		db.queue.push([hold({ state: "refund_pending" })]);
		deliver.mockRejectedValueOnce(new Error("ses down"));
		expect(await sendDueHoldNotices({ deliver })).toBe(0);
		expect(store.unclaimHoldNotice).toHaveBeenCalledWith("hold-1", "refund_pending");
	});

	it("an adoption whose org already exists by its marker is not mailed (nor claimed)", async () => {
		db.queue.push(
			[hold({ state: "released", release_reason: "adopted", released_at: NOW })],
			[{ metadata: JSON.stringify({ newOrgSubscriptionId: "sub_x" }) }],
		);
		expect(await sendDueHoldNotices({ deliver })).toBe(0);
		expect(store.claimHoldNotice).not.toHaveBeenCalled();
	});

	it("an adoption with no org is claimed as released:adopted", async () => {
		db.queue.push([hold({ state: "released", release_reason: "adopted", released_at: NOW })], []);
		expect(await sendDueHoldNotices({ deliver })).toBe(1);
		expect(store.claimHoldNotice).toHaveBeenCalledWith("hold-1", "released:adopted");
	});

	it("a hold owed nothing (another release reason) is never claimed", async () => {
		db.queue.push([hold({ state: "released", release_reason: "voided_unpaid", released_at: NOW })]);
		expect(await sendDueHoldNotices({ deliver })).toBe(0);
		expect(store.claimHoldNotice).not.toHaveBeenCalled();
	});
});

describe("sendPaymentHoldNoticeEmail (Q3 copy, I8)", () => {
	it("mails the given address, says only what was read, and carries no amount or card detail", async () => {
		const { sendPaymentHoldNoticeEmail } = await vi.importActual<typeof import("@/lib/email/billing-email")>(
			"@/lib/email/billing-email",
		);
		const html: Record<string, string> = {};
		for (const notice of PAYMENT_HOLD_NOTIFIED_STATES) {
			vi.mocked(sendGuardedEmail).mockClear();
			await sendPaymentHoldNoticeEmail({ to: "payer@example.test", notice });
			const sent = vi.mocked(sendGuardedEmail).mock.calls[0]?.[0];
			expect(sent?.to).toBe("payer@example.test");
			expect(sent?.subject).toMatch(/Alethia/);
			html[notice] = sent ? await render(sent.react, { plainText: true }) : "";
		}
		expect(html.refund_pending).toMatch(/issued its refund/);
		expect(html.refund_pending).toMatch(/both charges/);
		expect(html.refund_pending).not.toMatch(/refunded in full/);
		expect(html["released:refunded"]).toMatch(/refunded in full/);
		expect(html["released:adopted"]).toMatch(/Create a team/);
		for (const text of Object.values(html)) {
			expect(text).not.toMatch(/[$€£]\s?\d|\d+[.,]\d{2}\b|\bcard\b|charged twice|won't be charged/i);
		}
	});
});

// ── The cron twin ───────────────────────────────────────────────────────────────────────────────────

describe("POST /api/internal/payment-holds/sweep", () => {
	const original = process.env.ALETHIA_CRON_SECRET;
	afterEach(() => {
		process.env.ALETHIA_CRON_SECRET = original;
	});
	const post = (headers?: Record<string, string>) =>
		new Request("http://localhost/api/internal/payment-holds/sweep", { method: "POST", headers });

	it("503s when the cron secret is unset, and sweeps nothing", async () => {
		process.env.ALETHIA_CRON_SECRET = "";
		expect((await POST(post({ authorization: "Bearer " }))).status).toBe(503);
		expect(getServiceDb).not.toHaveBeenCalled();
	});

	it("401s on a wrong bearer of the same length, through the constant-time comparison, and sweeps nothing", async () => {
		process.env.ALETHIA_CRON_SECRET = "s3cret";
		expect((await POST(post({ authorization: "Bearer s3creT" }))).status).toBe(401);
		expect((await POST(post())).status).toBe(401);
		expect(isInternalAuthorized).toHaveBeenCalledTimes(2);
		expect(getServiceDb).not.toHaveBeenCalled();
	});

	it("runs one tick and returns counts only when authorized", async () => {
		process.env.ALETHIA_CRON_SECRET = "s3cret";
		db.queue.push([], []);
		const res = await POST(post({ authorization: "Bearer s3cret" }));
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ due: 0, advanced: 0, released: 0, busy: 0, stale: 0, ageAlerts: 0, notices: 0 });
	});
});

// ── release (T16, C19) ──────────────────────────────────────────────────────────────────────────────

/** Server deps over `stripe`, with the real sweeper's machine wiring. */
function serverDeps(stripe: HoldStripe): ServerDeps {
	return {
		store,
		lease,
		sweeper,
		sweepDeps: depsOver(stripe),
	};
}

const releaseArgs = { subscriptionId: "sub_x", reason: "customer refunded by hand", operator: "op-1" };

describe("release (T16, C19)", () => {
	it("refuses with no --reason or no --operator, and reads and writes nothing", async () => {
		const { stripe, log } = fakeStripe({ sub: "unpaid", invoice: "open" });
		for (const reason of [undefined, "", "  "]) {
			expect(await releaseHoldCommand({ ...releaseArgs, reason }, serverDeps(stripe), print)).toMatchObject({ kind: "refused" });
		}
		expect(await releaseHoldCommand({ ...releaseArgs, operator: undefined }, serverDeps(stripe), print)).toMatchObject({
			kind: "refused",
		});
		expect(db.db.select).not.toHaveBeenCalled();
		expect(lease.acquirePurchaseLease).not.toHaveBeenCalled();
		expect(log).toEqual([]);
		expect(store.releaseHold).not.toHaveBeenCalled();
	});

	it("refuses while the payer's lease stays busy", async () => {
		const { stripe } = fakeStripe({ sub: "canceled", invoice: "void" });
		vi.mocked(lease.acquirePurchaseLease).mockResolvedValue(null);
		db.queue.push([hold({ state: "needs_operator" })]);
		expect(await releaseHoldCommand(releaseArgs, serverDeps(stripe), print)).toMatchObject({ kind: "refused" });
		expect(store.releaseHold).not.toHaveBeenCalled();
		expect(events()).toEqual([]);
	});

	it("C19: releases an unpaid subscription's hold with no open setup — released_by, the note — and writes the audit event once", async () => {
		const { stripe } = fakeStripe({ sub: "unpaid", invoice: "open" });
		const open = hold({ state: "needs_operator" });
		db.queue.push([open], [open], [], [], []); // the open hold; re-read under the lease; setup line; open setup
		const result = await releaseHoldCommand(releaseArgs, serverDeps(stripe), print);
		expect(result).toEqual({ kind: "released", holdId: "hold-1" });
		expect(store.releaseHold).toHaveBeenCalledWith(LEASE, { id: "hold-1", version: 0 }, {
			reason: "operator",
			releasedBy: "op-1",
			note: "customer refunded by hand",
		});
		expect(events()).toEqual(["billing.payment_hold.released"]);
		const line: unknown = JSON.parse(String(info.mock.calls[0]?.[0]));
		expect(line).toMatchObject({ subscription_id: "sub_x", operator: "op-1", reason: "customer refunded by hand", from_state: "needs_operator" });
		expect(printed.some((l) => l.startsWith("Live observation: subscription live(unpaid)"))).toBe(true);
		expect(lease.releasePurchaseLease).toHaveBeenCalledWith(LEASE);
	});

	it("emits no audit event when its compare-and-set released nothing", async () => {
		const { stripe } = fakeStripe({ sub: "canceled", invoice: "void" });
		vi.mocked(store.releaseHold).mockResolvedValueOnce(null);
		const open = hold({ state: "needs_operator" });
		db.queue.push([open], [open], [], []);
		expect(await releaseHoldCommand(releaseArgs, serverDeps(stripe), print)).toEqual({ kind: "not_open" });
		expect(events()).toEqual([]);
	});

	it("refuses to release while an open setup names a subscription that is not ended (I14), and writes nothing", async () => {
		for (const sub of ["active", "incomplete", "past_due"]) {
			const { stripe } = fakeStripe({ sub, invoice: "open" });
			const open = hold({ state: "needs_operator" });
			db.queue.push([open], [open], [{ id: "setup-1", user_id: "payer-1", created_org_id: null, linked_at: null, closed_at: null }], [{ id: "setup-1" }]);
			expect(await releaseHoldCommand(releaseArgs, serverDeps(stripe), print)).toMatchObject({ kind: "refused" });
		}
		expect(store.releaseHold).not.toHaveBeenCalled();
		expect(events()).toEqual([]);
	});

	it("releases beside an open setup once the subscription reads ended", async () => {
		const { stripe } = fakeStripe({ sub: "canceled", invoice: "void" });
		const open = hold({ state: "needs_operator" });
		db.queue.push([open], [open], []);
		expect(await releaseHoldCommand(releaseArgs, serverDeps(stripe), print)).toMatchObject({ kind: "released" });
	});

	it("a second run finds no open hold: nothing changes, no event", async () => {
		const { stripe } = fakeStripe({ sub: "canceled", invoice: "void" });
		db.queue.push([]);
		expect(await releaseHoldCommand(releaseArgs, serverDeps(stripe), print)).toEqual({ kind: "not_open" });
		expect(lease.acquirePurchaseLease).not.toHaveBeenCalled();
		expect(events()).toEqual([]);
	});
});

// ── The backfill (§8 B1–B6, C58) ────────────────────────────────────────────────────────────────────

type FakeInvoice = { id: string; status: string; billing_reason: string; paid_at: number | null };
type FakePi = { id: string; status: string; pm: string | null };

/** A fake account for the backfill's own reads. */
function backfillStripe(
	subs: BackfillSubscription[],
	invoices: Record<string, FakeInvoice[]>,
	pis: Record<string, FakePi[]>,
): BackfillStripe {
	return {
		subscriptions: {
			list: ({ status }) => ({
				async *[Symbol.asyncIterator]() {
					for (const s of subs) if (s.status === status) yield s;
				},
			}),
		},
		invoices: {
			list: async ({ subscription }) => {
				const all = invoices[subscription] ?? [];
				return {
					has_more: all.length > 2,
					data: all.slice(0, 2).map((i) => ({
						id: i.id,
						status: i.status,
						billing_reason: i.billing_reason,
						status_transitions: { paid_at: i.paid_at },
					})),
				};
			},
		},
		invoicePayments: {
			list: async ({ invoice }) => ({
				has_more: false,
				data: (pis[invoice] ?? []).map((p) => ({
					payment: {
						type: "payment_intent",
						payment_intent: { id: p.id, status: p.status, payment_method: p.pm === null ? null : { type: p.pm } },
					},
				})),
			}),
		},
	};
}

/** A create-a-team subscription the payer asked to cancel, ended at t=1000. */
function ended(id: string, over: Partial<BackfillSubscription> = {}): BackfillSubscription {
	return {
		id,
		status: "canceled",
		customer: "cus_x",
		ended_at: 1000,
		metadata: { created_by: "payer-1" },
		cancellation_details: { reason: "cancellation_requested" },
		...over,
	};
}

const one = (id: string, status: string, paid_at: number | null = null): FakeInvoice[] => [
	{ id, status, billing_reason: "subscription_create", paid_at },
];

describe("backfillVerdict (§8 B1–B6)", () => {
	it("holds a never-live card checkout: one open first invoice, a card PaymentIntent", async () => {
		const stripe = backfillStripe([], { sub_a: one("in_a", "open") }, { in_a: [{ id: "pi_a", status: "requires_payment_method", pm: null }] });
		db.queue.push([]); // B6: no withdrawn order
		expect(await backfillVerdict(ended("sub_a"), stripe)).toMatchObject({
			kind: "hold",
			payer: "payer-1",
			customerId: "cus_x",
			invoiceId: "in_a",
			evidence: expect.stringMatching(/^backfill: B2 .* B4 invoice open/),
			toOperator: false,
		});
	});

	it("holds a payment that landed AFTER the subscription ended (B4), and an expired one", async () => {
		const stripe = backfillStripe(
			[],
			{ sub_p: one("in_p", "paid", 2000), sub_e: one("in_e", "open") },
			{ in_p: [{ id: "pi_p", status: "succeeded", pm: "card" }] },
		);
		db.queue.push([], []);
		expect(await backfillVerdict(ended("sub_p"), stripe)).toMatchObject({ kind: "hold" });
		expect(await backfillVerdict(ended("sub_e", { status: "incomplete_expired", cancellation_details: null }), stripe)).toMatchObject({
			kind: "hold",
			toOperator: true,
		});
	});

	it("B1: an org's subscription, or one with no creator, is not create-a-team", async () => {
		const stripe = backfillStripe([], {}, {});
		expect(await backfillVerdict(ended("s", { metadata: { created_by: "u", organization_id: "o" } }), stripe)).toEqual({
			kind: "not_create_a_team",
		});
		expect(await backfillVerdict(ended("s", { metadata: {} }), stripe)).toEqual({ kind: "not_create_a_team" });
	});

	it("lists, naming the failed test: B2 not requested, B3 renewed, B4 paid before it ended, B5 a bank debit, B6 withdrawn", async () => {
		const stripe = backfillStripe(
			[],
			{
				sub_b3: [
					{ id: "in_1", status: "paid", billing_reason: "subscription_create", paid_at: 10 },
					{ id: "in_2", status: "paid", billing_reason: "subscription_cycle", paid_at: 20 },
				],
				sub_b4: one("in_b4", "paid", 500),
				sub_b5: one("in_b5", "open"),
				sub_b6: one("in_b6", "open"),
			},
			{ in_b4: [{ id: "pi_4", status: "succeeded", pm: "card" }], in_b5: [{ id: "pi_5", status: "processing", pm: "us_bank_account" }] },
		);
		expect(await backfillVerdict(ended("sub_b2", { cancellation_details: { reason: "payment_failed" } }), stripe)).toMatchObject({
			kind: "listed",
			failed: expect.stringMatching(/^B2/),
		});
		expect(await backfillVerdict(ended("sub_b3"), stripe)).toMatchObject({ kind: "listed", failed: expect.stringMatching(/^B3/) });
		expect(await backfillVerdict(ended("sub_b4"), stripe)).toMatchObject({ kind: "listed", failed: expect.stringMatching(/^B4/) });
		expect(await backfillVerdict(ended("sub_b5"), stripe)).toMatchObject({ kind: "listed", failed: expect.stringMatching(/^B5/) });
		db.queue.push([{ id: "order-1" }]);
		expect(await backfillVerdict(ended("sub_b6"), stripe)).toMatchObject({ kind: "listed", failed: expect.stringMatching(/^B6/) });
	});
});

describe("runBackfill (C58)", () => {
	it("holds and advances each hit under its payer's lease, lists the rest, and writes nothing for them", async () => {
		const subs = [ended("sub_hit"), ended("sub_legit"), ended("sub_org", { metadata: { created_by: "u", organization_id: "o" } })];
		const bf = backfillStripe(subs, { sub_hit: one("in_hit", "open"), sub_legit: one("in_legit", "paid", 500) }, {
			in_hit: [{ id: "pi_h", status: "requires_payment_method", pm: null }],
			in_legit: [{ id: "pi_l", status: "succeeded", pm: "card" }],
		});
		const { stripe: machine } = fakeStripe({ sub: "canceled", invoice: "open" });
		const opened = hold({ id: "hold-new", subscription_id: "sub_hit", invoice_id: "in_hit", opened_by: "backfill" });
		vi.mocked(store.openHold).mockResolvedValue({ kind: "opened", hold: opened });
		// sub_hit: B6, no known hold, none under the lease either; sub_legit: no known hold (it is listed).
		db.queue.push([], [], [], [], []);
		const summary = await runBackfill(serverDeps(machine), bf, print);
		expect(summary).toEqual({ held: 1, toOperator: 0, listed: 1, alreadyHeld: 0, notCreateATeam: 1 });
		expect(store.openHold).toHaveBeenCalledTimes(1);
		expect(vi.mocked(store.openHold).mock.calls[0]?.[1]).toMatchObject({
			subscriptionId: "sub_hit",
			payerKey: "payer-1",
			invoiceId: "in_hit",
			state: "closing",
			openedBy: "backfill",
			openNote: expect.stringMatching(/^backfill: /),
		});
		expect(lease.acquirePurchaseLease).toHaveBeenCalledWith("user:payer-1", 30_000);
		expect(store.releaseHold).toHaveBeenCalledWith(LEASE, expect.anything(), expect.objectContaining({ reason: "voided_unpaid" }));
		expect(printed.some((l) => l.startsWith("LISTED sub_legit: B4"))).toBe(true);
	});

	it("is safe to re-run: a subscription any hold has named is skipped, and nothing is opened", async () => {
		const bf = backfillStripe([ended("sub_hit")], { sub_hit: one("in_hit", "open") }, {});
		const { stripe: machine, log } = fakeStripe({ sub: "canceled", invoice: "open" });
		db.queue.push([], [{ id: "hold-old", state: "released" }]);
		const summary = await runBackfill(serverDeps(machine), bf, print);
		expect(summary).toEqual({ held: 0, toOperator: 0, listed: 0, alreadyHeld: 1, notCreateATeam: 0 });
		expect(store.openHold).not.toHaveBeenCalled();
		expect(lease.acquirePurchaseLease).not.toHaveBeenCalled();
		expect(log).toEqual([]);
	});

	it("two backfills at once: a hold another run opened while this one waited for the lease is seen UNDER the lease, and nothing is opened", async () => {
		const bf = backfillStripe([ended("sub_hit")], { sub_hit: one("in_hit", "open") }, {
			in_hit: [{ id: "pi_h", status: "requires_payment_method", pm: null }],
		});
		const { stripe: machine, log } = fakeStripe({ sub: "canceled", invoice: "open" });
		// B6; the first look finds nothing; the look under the lease finds the other run's hold.
		db.queue.push([], [], [{ id: "hold-other", state: "released" }]);
		const summary = await runBackfill(serverDeps(machine), bf, print);
		expect(summary).toEqual({ held: 0, toOperator: 0, listed: 0, alreadyHeld: 1, notCreateATeam: 0 });
		expect(lease.acquirePurchaseLease).toHaveBeenCalledTimes(1);
		expect(store.openHold).not.toHaveBeenCalled();
		expect(log).toEqual([]);
	});

	it("B5 with NO PaymentIntent passes on nothing: held in needs_operator, alerted, never advanced", async () => {
		const bf = backfillStripe([ended("sub_nopi")], { sub_nopi: one("in_nopi", "open") }, {});
		const { stripe: machine, log } = fakeStripe({ sub: "canceled", invoice: "open" });
		const opened = hold({ id: "hold-op", subscription_id: "sub_nopi", state: "needs_operator", opened_by: "backfill" });
		vi.mocked(store.openHold).mockResolvedValue({ kind: "opened", hold: opened });
		db.queue.push([], [], []);
		const summary = await runBackfill(serverDeps(machine), bf, print);
		expect(summary).toEqual({ held: 0, toOperator: 1, listed: 0, alreadyHeld: 0, notCreateATeam: 0 });
		expect(vi.mocked(store.openHold).mock.calls[0]?.[1]).toMatchObject({
			state: "needs_operator",
			openNote: expect.stringMatching(/B5 unproven/),
		});
		expect(alert).toHaveBeenCalledTimes(1);
		expect(alert.mock.calls[0]?.[0]).toMatchObject({ subscriptionId: "sub_nopi", detail: expect.stringMatching(/no PaymentIntent/) });
		expect(store.writeHoldState).toHaveBeenCalledWith(LEASE, { id: "hold-op", version: 0 }, { alertedAt: expect.any(Date) });
		expect(log).toEqual([]);
		expect(store.releaseHold).not.toHaveBeenCalled();
	});
});

describe("main", () => {
	it("prints the usage and exits 1 on an unknown command or a missing subscription", async () => {
		const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
		expect(await main([], print)).toBe(1);
		expect(await main(["drop-everything"], print)).toBe(1);
		expect(await main(["show"], print)).toBe(1);
		expect(await main(["release", "--reason", "x"], print)).toBe(1);
		expect(err).toHaveBeenCalled();
	});

	it("refuses a release with no reason or operator before it loads or reads anything", async () => {
		expect(await main(["release", "sub_x", "--operator", "op-1"], print)).toBe(1);
		expect(await main(["release", "sub_x", "--reason", "why"], print)).toBe(1);
		expect(getServiceDb).not.toHaveBeenCalled();
	});

	it("list prints the holds without amounts or emails", async () => {
		db.queue.push([hold()]);
		expect(await main(["list", "--open"], print)).toBe(0);
		expect(printed[0]).toMatch(/^hold hold-1 {2}scope new_org {2}sub sub_x {2}payer payer-1 {2}state closing/);
	});
});

// ── ADR 0004 C42: the operator sees and releases org-plan holds ────────────────────────────────────

describe("ADR 0004 C42: the scope in the operator command", () => {
	const dialect = new PgDialect();
	const orgHold = (over: Partial<PaymentHoldRow> = {}) =>
		hold({ scope: "org_plan", payer_key: "org-o", opened_by_user_id: null, state: "refund_due", ...over });

	/** The predicate of the one listing `main` ran, rendered as Postgres. */
	function listedWhere() {
		const where = db.wheres[0];
		if (!is(where, SQL)) throw new Error("list built no SQL predicate");
		return dialect.sqlToQuery(where);
	}

	it("list --scope org_plan reads only that scope's holds, and prints each hold's scope", async () => {
		db.queue.push([orgHold()]);
		expect(await main(["list", "--scope", "org_plan"], print)).toBe(0);
		const q = listedWhere();
		expect(q.sql).toMatch(/"payment_holds"\."scope" = \$\d+/);
		expect(q.params).toEqual(["org_plan"]);
		expect(printed[0]).toMatch(/^hold hold-1 {2}scope org_plan {2}sub sub_x {2}payer org-o {2}state refund_due/);
	});

	it("list --scope and --payer filter together: payer_key alone is never the key", async () => {
		db.queue.push([]);
		expect(await main(["list", "--open", "--scope=new_org", "--payer", "payer-1"], print)).toBe(0);
		const q = listedWhere();
		expect(q.sql).toMatch(/"payment_holds"\."scope" = \$\d+/);
		expect(q.sql).toMatch(/"payment_holds"\."payer_key" = \$\d+/);
		expect(q.params).toEqual(expect.arrayContaining(["new_org", "payer-1"]));
	});

	it("list --scope with an unknown scope is refused before anything is read", async () => {
		const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
		expect(await main(["list", "--scope", "ai"], print)).toBe(1);
		expect(await main(["reconcile", "--scope", "ai"], print)).toBe(1);
		expect(getServiceDb).not.toHaveBeenCalled();
		expect(err).toHaveBeenCalled();
	});

	it("release of an org_plan hold takes org-plan:<O> and writes released(operator), audited once", async () => {
		const { stripe } = fakeStripe({ sub: "canceled", invoice: "void" });
		const open = orgHold();
		db.queue.push([open], [open], []); // the open hold; re-read under the lease; setup line
		const result = await releaseHoldCommand(releaseArgs, serverDeps(stripe), print);
		expect(result).toEqual({ kind: "released", holdId: "hold-1" });
		expect(lease.acquirePurchaseLease).toHaveBeenCalledWith("org-plan:org-o", expect.any(Number));
		expect(store.releaseHold).toHaveBeenCalledWith(LEASE, { id: "hold-1", version: 0 }, {
			reason: "operator",
			releasedBy: "op-1",
			note: "customer refunded by hand",
		});
		expect(events()).toEqual(["billing.payment_hold.released"]);
		expect(lease.releasePurchaseLease).toHaveBeenCalledWith(LEASE);
	});

	it("an org_plan release is not refused for an open setup naming its subscription: it closes no setup (D1 rule 4)", async () => {
		const { stripe } = fakeStripe({ sub: "active", invoice: "open" });
		const open = orgHold({ state: "needs_operator" });
		db.queue.push([open], [open], [{ id: "setup-1", user_id: "payer-1", created_org_id: null, linked_at: null, closed_at: null }], [{ id: "setup-1" }]);
		expect(await releaseHoldCommand(releaseArgs, serverDeps(stripe), print)).toMatchObject({ kind: "released" });
		expect(sweeper.relinkAdoptedSetup).not.toHaveBeenCalled();
		expect(store.releaseHold).toHaveBeenCalledTimes(1);
	});
});

// ── release --moved-to (T16m, E2m; ADR 0002 §5.8; C98–C102, C108) ─────────────────────────────────

const X = "sub_x";
const T = "org_t";
const O = "org_o";
const MIN = 60_000;

/** True when a fixture carries the fields the moved release reads off a subscription. */
function isSubscription(x: unknown): x is Stripe.Subscription {
	return typeof x === "object" && x !== null && "id" in x && "status" in x && "customer" in x && "metadata" in x && "items" in x;
}

/** True when a fixture is a customer or a deleted customer. */
function isCustomer(x: unknown): x is Stripe.Customer | Stripe.DeletedCustomer {
	return typeof x === "object" && x !== null && "id" in x && "object" in x && x.object === "customer";
}

/** A subscription as Stripe returns it, with one plan line (`price`), or only a metered line. */
function stripeSub(o: {
	id: string;
	status: string;
	orgId?: string | null;
	customer?: string;
	price?: string;
	meteredOnly?: boolean;
}): Stripe.Subscription {
	const fixture: unknown = {
		id: o.id,
		object: "subscription",
		status: o.status,
		customer: o.customer ?? "cus_u",
		metadata: { created_by: "payer-1", ...(o.orgId ? { organization_id: o.orgId } : {}) },
		items: {
			data: [
				{
					id: `si_${o.id}`,
					quantity: 1,
					price: { id: o.price ?? "price_team", recurring: { usage_type: o.meteredOnly ? "metered" : "licensed" } },
				},
			],
		},
	};
	if (!isSubscription(fixture)) throw new Error("fixture: not a subscription");
	return fixture;
}

/** What the moved release's Stripe client answers. */
interface MovedWorld {
	x: Stripe.Subscription | "missing" | "error";
	customer: { deleted: boolean; orgId: string | null };
	/** Per customer, its subscriptions of every status. */
	lists: Record<string, Stripe.Subscription[]>;
	listFail: boolean;
	/** Every page has 100 more: the 1000-per-customer cap is reached. */
	listOverCap: boolean;
	/** Customers whose `organization_id` is T. */
	customerHits: string[];
	customerOverCap: boolean;
	search: Stripe.Subscription[];
	searchFail: boolean;
	/** Every page has more: the 10-page cap is reached. */
	searchOverCap: boolean;
}

/** One ordered log across the lease, the lock, Stripe, the sync and the store. */
let order: string[] = [];

/** A fake of the moved release's Stripe reads over `w`; each call is logged in `order`. */
function movedStripeOf(w: MovedWorld): MovedStripe {
	let minted = 0;
	return {
		subscriptions: {
			retrieve: async (id) => {
				order.push("stripe:subscriptions.retrieve");
				if (w.x === "missing") throw Object.assign(new Error(`No such subscription: ${id}`), { code: "resource_missing" });
				if (w.x === "error") throw new Error("api_connection_error");
				return w.x;
			},
			list: async ({ customer }) => {
				order.push(`stripe:subscriptions.list:${customer}`);
				if (w.listFail) throw new Error("rate_limit");
				if (w.listOverCap) {
					const data = Array.from({ length: 100 }, () => stripeSub({ id: `sub_cap_${minted++}`, status: "canceled" }));
					return { has_more: true, data };
				}
				return { has_more: false, data: w.lists[customer] ?? [] };
			},
			search: async () => {
				order.push("stripe:subscriptions.search");
				if (w.searchFail) throw new Error("search unavailable");
				if (w.searchOverCap) return { has_more: true, next_page: `page_${minted++}`, data: [] };
				return { has_more: false, next_page: null, data: w.search };
			},
		},
		customers: {
			retrieve: async (id) => {
				order.push("stripe:customers.retrieve");
				const fixture: unknown = w.customer.deleted
					? { id, object: "customer", deleted: true }
					: { id, object: "customer", metadata: w.customer.orgId ? { organization_id: w.customer.orgId } : {} };
				if (!isCustomer(fixture)) throw new Error("fixture: not a customer");
				return fixture;
			},
			search: async () => {
				order.push("stripe:customers.search");
				return { has_more: w.customerOverCap, data: w.customerHits.map((id) => ({ id })) };
			},
		},
	};
}

/** T's billing row naming `sub` (or nothing), written `minutesAgo` before NOW. */
function billing(sub: string | null, status: BillingStatus = "active", minutesAgo = 20, customer = "cus_u") {
	return {
		stripeSubscriptionId: sub,
		status,
		stripeCustomerId: customer,
		updatedAt: new Date(NOW.getTime() - minutesAgo * MIN),
	};
}

/** One moved-release fixture: the database facts, the Stripe world, T's row reads, and the lock and lease. */
interface MovedCase {
	hold: PaymentHoldRow;
	/** The re-read under the lease; the first read when absent. */
	reread?: PaymentHoldRow | null;
	team: { id: string; metadata: string | null } | null;
	member: { role: string; status: string } | null;
	managesBilling: boolean;
	setupOrgId: string | null;
	world: MovedWorld;
	/** T's billing row, read in order: before any sync, then after the sync or after a release that wrote nothing. */
	rows: Array<ReturnType<typeof billing> | null>;
	lockBusy: boolean;
	renew: boolean;
}

/** C98's fixture: a moved X, U an active owner of T with manage_billing, T's row naming X 20 minutes ago. */
function movedCase(over: Partial<MovedCase> = {}, world: Partial<MovedWorld> = {}): MovedCase {
	return {
		hold: hold({ state: "needs_operator", opened_by: "link", open_note: LINK_REFUSED_NOTE }),
		team: { id: T, metadata: null },
		member: { role: "owner", status: "active" },
		managesBilling: true,
		setupOrgId: O,
		world: {
			x: stripeSub({ id: X, status: "active", orgId: T }),
			customer: { deleted: false, orgId: T },
			lists: { cus_u: [stripeSub({ id: X, status: "active", orgId: T })] },
			listFail: false,
			listOverCap: false,
			customerHits: ["cus_u"],
			customerOverCap: false,
			search: [stripeSub({ id: X, status: "active", orgId: T })],
			searchFail: false,
			searchOverCap: false,
			...world,
		},
		rows: [billing(X)],
		lockBusy: false,
		renew: true,
		...over,
	};
}

/** The moved deps over `c`, each call logged in `order`. */
function movedDepsOf(c: MovedCase) {
	const rows = [...c.rows];
	/** `withPurchaseLock`'s shape: busy, or `fn` run between a logged enter and exit. */
	async function locked<T>(key: string, fn: () => Promise<T>): Promise<{ acquired: true; value: T } | { acquired: false }> {
		if (c.lockBusy) return { acquired: false };
		order.push(`lock:enter:${key}`);
		try {
			return { acquired: true, value: await fn() };
		} finally {
			order.push("lock:exit");
		}
	}
	const lock: { withPurchaseLock: typeof withPurchaseLock } = { withPurchaseLock: locked };
	const sync = {
		syncSubscriptionToBilling: vi.fn(async (_sub: Stripe.Subscription): Promise<"applied"> => {
			order.push("sync");
			return "applied";
		}),
		isOrgPlanSubscription,
	};
	const moved: MovedReleaseDeps = {
		lease: {
			renewPurchaseLease: vi.fn(async () => {
				order.push("lease:renew");
				return c.renew;
			}),
		},
		lock,
		sync,
		queries: {
			getOrgBilling: vi.fn(async () => {
				order.push("db:getOrgBilling");
				return rows.length > 1 ? (rows.shift() ?? null) : (rows[0] ?? null);
			}),
		},
		setups: { pendingOrgSetupFor: vi.fn(async () => ({ created_org_id: c.setupOrgId })) },
		stripe: () => movedStripeOf(c.world),
	};
	return { moved, lock, sync };
}

/** The setup line's row: an open setup of X for the team O. */
const SETUP_LINE = { id: "setup-1", user_id: "payer-1", created_org_id: O, linked_at: null, closed_at: null, closed_reason: null };

/** Runs `release X --moved-to T --reason r --operator op-1` over `c`. */
async function runMoved(c: MovedCase, input: { movedTo?: string } = {}) {
	const { stripe: observed, log } = fakeStripe({ sub: "active", invoice: "paid" });
	const { moved, lock, sync } = movedDepsOf(c);
	const holdsManageBilling = vi.fn(async () => c.managesBilling);
	const deps: ServerDeps = {
		store,
		lease,
		sweeper: { ...sweeper, holdsManageBilling },
		sweepDeps: depsOver(observed),
		moved,
	};
	const reread = c.reread === undefined ? c.hold : c.reread;
	db.queue.length = 0;
	db.queue.push([c.hold], reread ? [reread] : []);
	if (reread) {
		db.queue.push([SETUP_LINE]);
		if (c.team) db.queue.push([c.team], c.member ? [c.member] : []);
		else db.queue.push([]);
	}
	const result = await releaseHoldCommand(
		{ subscriptionId: X, reason: "r", operator: "op-1", movedTo: input.movedTo ?? T },
		deps,
		print,
	);
	return { result, log, lock, sync, holdsManageBilling, moved };
}

/** The audit event lines written, parsed. */
function auditLines(): unknown[] {
	return info.mock.calls.flatMap((c: unknown[]) => {
		const line = String(c[0]);
		return line.includes('"billing.payment_hold.released"') ? [JSON.parse(line)] : [];
	});
}

/** The machine's Stripe writes in the observation fake's log. */
function holdStripeWrites(log: string[]): string[] {
	return log.filter((l) => /^(invoices\.(voidInvoice|del)|subscriptions\.cancel|paymentIntents\.cancel|refunds\.create)/.test(l));
}

/** Nothing was written, alerted or emitted, and the lease (and the lock, when taken) were given back. */
function expectNothingWritten(out: Awaited<ReturnType<typeof runMoved>>) {
	expect(store.releaseHold).not.toHaveBeenCalled();
	expect(store.writeHoldState).not.toHaveBeenCalled();
	expect(alert).not.toHaveBeenCalled();
	expect(alertPaymentNeedsSupport).not.toHaveBeenCalled();
	expect(holdStripeWrites(out.log)).toEqual([]);
	expect(getPurchaseStripe).not.toHaveBeenCalled();
	expect(auditLines()).toEqual([]);
	expect(lease.releasePurchaseLease).toHaveBeenCalledWith(LEASE);
	if (order.some((o) => o.startsWith("lock:enter"))) expect(order.at(-1)).toBe("lock:exit");
}

describe("release --moved-to (§5.8)", () => {
	beforeEach(() => {
		order = [];
		vi.mocked(lease.acquirePurchaseLease).mockImplementation(async () => {
			order.push("lease:acquire");
			return LEASE;
		});
		vi.mocked(store.releaseHold).mockImplementation(async (_l, ref, input) => {
			order.push("store.releaseHold");
			return {
				hold: hold({ id: ref.id, version: ref.version + 1, state: "released", release_reason: input.reason }),
				closedSetupId: "setup-1",
				...(input.expectOrgRow ? { checkedOrgRow: { subscriptionId: X, status: "active" } } : {}),
			};
		});
	});

	it("C98: releases a moved link_refused hold, audited with the move; no re-link, alert or Stripe write; a second run is not_open", async () => {
		const out = await runMoved(movedCase());
		expect(out.result).toEqual({ kind: "released", holdId: "hold-1" });
		expect(store.releaseHold).toHaveBeenCalledTimes(1);
		expect(store.releaseHold).toHaveBeenCalledWith(LEASE, { id: "hold-1", version: 0 }, {
			reason: "operator",
			releasedBy: "op-1",
			note: `moved to ${T}: r`,
			expectOrgRow: { orgId: T, subscriptionId: X },
		});
		expect(auditLines()).toEqual([
			{
				event: "billing.payment_hold.released",
				hold_id: "hold-1",
				subscription_id: X,
				from_state: "needs_operator",
				operator: "op-1",
				reason: "r",
				moved_to: T,
				payer: "payer-1",
				customer_id: "cus_u",
				row_subscription_id: X,
				row_status: "active",
				listed_customers: ["cus_u"],
				listed_subscription_count: 1,
				setup_closed: "setup-1",
			},
		]);
		expect(sweeper.relinkAdoptedSetup).not.toHaveBeenCalled();
		expect(alert).not.toHaveBeenCalled();
		expect(alertPaymentNeedsSupport).not.toHaveBeenCalled();
		expect(getPurchaseStripe).not.toHaveBeenCalled();
		expect(holdStripeWrites(out.log)).toEqual([]);
		expect(out.sync.syncSubscriptionToBilling).not.toHaveBeenCalled();
		expect(lease.releasePurchaseLease).toHaveBeenCalledWith(LEASE);
		// T's lock is held from before the first Stripe read until after the release.
		expect(order[1]).toBe(`lock:enter:org-plan:${T}`);
		expect(order.findIndex((o) => o.startsWith("stripe:"))).toBeGreaterThan(1);
		expect(order.indexOf("store.releaseHold")).toBeLessThan(order.indexOf("lock:exit"));

		vi.mocked(store.releaseHold).mockClear();
		info.mockClear();
		db.queue.push([]);
		expect(
			await releaseHoldCommand({ subscriptionId: X, reason: "r", operator: "op-1", movedTo: T }, serverDeps(fakeStripe({ sub: "active", invoice: "paid" }).stripe), print),
		).toEqual({ kind: "not_open" });
		expect(auditLines()).toEqual([]);
		expect(store.releaseHold).not.toHaveBeenCalled();
	});

	it("C98 control: a plain release emits no moved_to, payer, row_* or setup_closed key, and passes no expectOrgRow", async () => {
		const { stripe } = fakeStripe({ sub: "canceled", invoice: "void" });
		const open = hold({ state: "needs_operator" });
		db.queue.push([open], [open], []);
		expect(await releaseHoldCommand(releaseArgs, serverDeps(stripe), print)).toMatchObject({ kind: "released" });
		const [line] = auditLines();
		for (const key of ["moved_to", "payer", "customer_id", "row_subscription_id", "row_status", "listed_customers", "listed_subscription_count", "setup_closed"]) {
			expect(line).not.toHaveProperty(key);
		}
		expect(vi.mocked(store.releaseHold).mock.calls[0]?.[2]).not.toHaveProperty("expectOrgRow");
	});

	it("C99: every refusal is typed, writes nothing, never syncs (but on the way to row_not_x / row_changed), and gives the lease and the lock back", async () => {
		const z = (status: string, over: { orgId?: string; price?: string } = {}) =>
			stripeSub({ id: "sub_z", status, orgId: over.orgId ?? T, customer: "cus_t", price: over.price });
		const cases: Array<[string, MovedCase]> = [
			["not_link_refused", movedCase({ hold: hold({ state: "needs_operator", open_note: null }) })],
			["team_not_found", movedCase({ team: null })],
			["same_team", movedCase({ setupOrgId: T })],
			["payer_not_in_team", movedCase({ member: null })],
			["team_purchase_in_progress", movedCase({ lockBusy: true })],
			["x_missing", movedCase({}, { x: "missing" })],
			["stripe_unreadable", movedCase({}, { x: "error" })],
			["x_ended", movedCase({}, { x: stripeSub({ id: X, status: "canceled", orgId: T }) })],
			["x_not_movable", movedCase({}, { x: stripeSub({ id: X, status: "unpaid", orgId: T }) })],
			["subscription_not_moved", movedCase({}, { x: stripeSub({ id: X, status: "active", orgId: O }) })],
			["customer_not_moved", movedCase({}, { customer: { deleted: false, orgId: O } })],
			["team_has_other_plan", movedCase({ rows: [billing("sub_z", "past_due")] })],
			["team_has_other_plan", movedCase({}, { search: [z("past_due")] })],
			["too_soon", movedCase({ rows: [billing(X, "active", 5)] })],
			["row_not_x", movedCase({ rows: [null, billing(null, "none")] })],
			["lease_lost", movedCase({ renew: false })],
		];
		for (const [code, c] of cases) {
			vi.clearAllMocks();
			order = [];
			db.queue.length = 0;
			const out = await runMoved(c);
			expect([code, out.result]).toEqual([code, expect.objectContaining({ kind: "refused", code })]);
			expectNothingWritten(out);
			const synced = vi.mocked(out.sync.syncSubscriptionToBilling).mock.calls.length;
			expect([code, synced]).toEqual([code, code === "row_not_x" ? 1 : 0]);
		}
	});

	it("C99: a --moved-to with no value is refused before any read", async () => {
		const { stripe } = fakeStripe({ sub: "active", invoice: "paid" });
		for (const movedTo of ["", "  ", "--reason"]) {
			expect(await releaseHoldCommand({ ...releaseArgs, movedTo }, serverDeps(stripe), print)).toMatchObject({ kind: "refused" });
		}
		expect(db.db.select).not.toHaveBeenCalled();
		expect(lease.acquirePurchaseLease).not.toHaveBeenCalled();
		expect(await main(["release", X, "--reason", "r", "--operator", "op-1", "--moved-to"], print)).toBe(1);
		expect(await main(["release", X, "--moved-to", "--reason", "r", "--operator", "op-1"], print)).toBe(1);
		expect(await main(["release", X, "--reason", "r", "--operator", "op-1", "--moved-to="], print)).toBe(1);
		expect(getServiceDb).not.toHaveBeenCalled();
	});

	it("a --moved-to or subscription id outside the id charset is refused before any read (the search query cannot be broken out of)", async () => {
		const { stripe } = fakeStripe({ sub: "active", invoice: "paid" });
		for (const movedTo of ["org' OR metadata['x']:'y", "org t", "org\"t", "org:t"]) {
			expect(await releaseHoldCommand({ ...releaseArgs, movedTo }, serverDeps(stripe), print)).toMatchObject({ kind: "refused" });
			expect(await main(["release", X, "--moved-to", movedTo, "--reason", "r", "--operator", "op-1"], print)).toBe(1);
		}
		expect(
			await releaseHoldCommand({ ...releaseArgs, subscriptionId: "sub_x'", movedTo: T }, serverDeps(stripe), print),
		).toMatchObject({ kind: "refused" });
		expect(await main(["release", "sub_x'", "--moved-to", T, "--reason", "r", "--operator", "op-1"], print)).toBe(1);
		expect(db.db.select).not.toHaveBeenCalled();
		expect(getServiceDb).not.toHaveBeenCalled();
		expect(lease.acquirePurchaseLease).not.toHaveBeenCalled();
		// A UUID team id passes the check.
		db.queue.push([]);
		expect(
			await releaseHoldCommand({ ...releaseArgs, movedTo: "3f2b8c1e-9a4d-4e7b-8c2a-1d5e6f7a8b9c" }, serverDeps(stripe), print),
		).toEqual({ kind: "not_open" });
	});

	it("C99 / C101: team_not_found, payer_not_in_team and a busy lock make no Stripe call, and print no live observation", async () => {
		for (const c of [movedCase({ team: null }), movedCase({ member: { role: "admin", status: "active" } }), movedCase({ lockBusy: true })]) {
			vi.clearAllMocks();
			order = [];
			printed = [];
			db.queue.length = 0;
			const out = await runMoved(c);
			expect(out.result).toMatchObject({ kind: "refused" });
			expect(order.filter((o) => o.startsWith("stripe:"))).toEqual([]);
			expect(out.log).toEqual([]);
			expect(printed.some((l) => l.startsWith("Live observation"))).toBe(false);
		}
	});

	it("C99: a listing or search that reaches its cap (1000 per customer, 50 customers, 10 search pages), or fails, is stripe_unreadable", async () => {
		const worlds: Array<Partial<MovedWorld>> = [
			{ listOverCap: true },
			{ customerOverCap: true },
			{ searchOverCap: true },
			{ listFail: true },
			{ searchFail: true },
		];
		for (const w of worlds) {
			vi.clearAllMocks();
			order = [];
			db.queue.length = 0;
			const out = await runMoved(movedCase({}, w));
			expect([w, out.result]).toEqual([w, expect.objectContaining({ kind: "refused", code: "stripe_unreadable" })]);
			expect(store.releaseHold).not.toHaveBeenCalled();
		}
	});

	it("C99: the per-customer listing stops at its cap of 1000", async () => {
		const out = await runMoved(movedCase({}, { listOverCap: true }));
		expect(out.result).toMatchObject({ code: "stripe_unreadable" });
		expect(order.filter((o) => o === "stripe:subscriptions.list:cus_u")).toHaveLength(10);
	});

	it("C99: the search stops at its cap of 10 pages", async () => {
		const out = await runMoved(movedCase({}, { searchOverCap: true }));
		expect(out.result).toMatchObject({ code: "stripe_unreadable" });
		expect(order.filter((o) => o === "stripe:subscriptions.search")).toHaveLength(10);
	});
});

describe("release --moved-to: sync once, the pre-sync row, N1 and N2 (C100)", () => {
	beforeEach(() => {
		order = [];
		vi.mocked(store.releaseHold).mockImplementation(async (_l, ref, input) => {
			order.push("store.releaseHold");
			return {
				hold: hold({ id: ref.id, version: ref.version + 1, state: "released", release_reason: input.reason }),
				closedSetupId: "setup-1",
				checkedOrgRow: { subscriptionId: X, status: "active" },
			};
		});
	});

	/** The lock was entered before the first Stripe read and left after any `releaseHold`. */
	function expectLockAround() {
		const enter = order.findIndex((o) => o.startsWith("lock:enter"));
		const firstStripe = order.findIndex((o) => o.startsWith("stripe:"));
		expect(enter).toBeGreaterThan(-1);
		expect(enter).toBeLessThan(firstStripe);
		const exit = order.indexOf("lock:exit");
		if (order.includes("store.releaseHold")) expect(order.indexOf("store.releaseHold")).toBeLessThan(exit);
		expect(exit).toBe(order.length - 1);
	}

	it("sync once: T's row names nothing, the one sync applies, the re-read names X: released, synced exactly once on the X this run read", async () => {
		const c = movedCase({ rows: [null, billing(X, "active", 0)] });
		const out = await runMoved(c);
		expect(out.result).toMatchObject({ kind: "released" });
		expect(out.sync.syncSubscriptionToBilling).toHaveBeenCalledTimes(1);
		expect(out.sync.syncSubscriptionToBilling.mock.calls[0]?.[0]).toBe(c.world.x);
		expect(out.sync.syncSubscriptionToBilling.mock.calls[0]).toHaveLength(1);
		expect(order.indexOf("lease:renew")).toBeLessThan(order.indexOf("sync"));
		expectLockAround();
	});

	it("pre-sync row: Z past_due, active, trialing or none refuses naming Z, with no sync and no release; Z canceled does not refuse on row 11", async () => {
		for (const status of ["past_due", "active", "trialing", "none"] as const) {
			vi.mocked(store.releaseHold).mockClear();
			order = [];
			const out = await runMoved(movedCase({ rows: [billing("sub_z", status)] }));
			expect(out.result).toMatchObject({ kind: "refused", code: "team_has_other_plan", reason: expect.stringContaining(`sub_z (${status})`) });
			expect(out.sync.syncSubscriptionToBilling).not.toHaveBeenCalled();
			expect(store.releaseHold).not.toHaveBeenCalled();
			expectLockAround();
		}
		order = [];
		const canceled = await runMoved(movedCase({ rows: [billing("sub_z", "canceled"), billing(X, "active", 0)] }));
		expect(canceled.result).toMatchObject({ kind: "released" });
		expect(canceled.sync.syncSubscriptionToBilling).toHaveBeenCalledTimes(1);
	});

	it("N1: a just-minted Z, incomplete, on the customer on T's row, not yet searchable: refused from the listing", async () => {
		const z = stripeSub({ id: "sub_z", status: "incomplete", orgId: T, customer: "cus_t" });
		const out = await runMoved(
			movedCase({ rows: [billing(null, "none", 1, "cus_t")] }, { lists: { cus_t: [z], cus_u: [] }, search: [] }),
		);
		expect(out.result).toMatchObject({ kind: "refused", code: "team_has_other_plan", reason: expect.stringContaining("sub_z (incomplete)") });
		expect(order).toContain("stripe:subscriptions.list:cus_t");
		expect(out.sync.syncSubscriptionToBilling).not.toHaveBeenCalled();
		expectLockAround();
	});

	it("webhook-first: the row names X 20 min ago and the search finds Z past_due: refused, no sync; 5 min ago is too_soon with the time; neither: released", async () => {
		const z = stripeSub({ id: "sub_z", status: "past_due", orgId: T, customer: "cus_other" });
		const found = await runMoved(movedCase({}, { search: [z] }));
		expect(found.result).toMatchObject({ code: "team_has_other_plan" });
		expect(found.sync.syncSubscriptionToBilling).not.toHaveBeenCalled();

		const soon = await runMoved(movedCase({ rows: [billing(X, "active", 5)] }, { search: [] }));
		expect(soon.result).toMatchObject({ code: "too_soon", reason: expect.stringContaining("2026-10-09T12:10:00.000Z") });

		const later = await runMoved(movedCase({}, { search: [], lists: {} }));
		expect(later.result).toMatchObject({ kind: "released" });
	});

	it("N2: an active AI subscription on T, listed and searched, does not refuse; beside a past_due plan Z, the refusal names Z only", async () => {
		const ai = stripeSub({ id: "sub_ai", status: "active", orgId: T, price: "price_ai_plus" });
		const out = await runMoved(movedCase({}, { lists: { cus_u: [ai] }, search: [ai] }));
		expect(out.result).toMatchObject({ kind: "released" });

		const z = stripeSub({ id: "sub_z", status: "past_due", orgId: T });
		const both = await runMoved(movedCase({}, { lists: { cus_u: [ai, z] }, search: [ai] }));
		expect(both.result).toMatchObject({ code: "team_has_other_plan", reason: expect.stringContaining("sub_z") });
		expect(both.result).toMatchObject({ reason: expect.not.stringContaining("sub_ai") });

		const metered = stripeSub({ id: "sub_m", status: "active", orgId: T, price: "price_ai_plus", meteredOnly: true });
		const noLicensed = await runMoved(movedCase({}, { search: [metered] }));
		expect(noLicensed.result).toMatchObject({ code: "team_has_other_plan", reason: expect.stringContaining("sub_m") });
	});

	it("a canceled search hit does not refuse; a failing listing or search is stripe_unreadable", async () => {
		const gone = stripeSub({ id: "sub_c", status: "canceled", orgId: T });
		expect((await runMoved(movedCase({}, { search: [gone] }))).result).toMatchObject({ kind: "released" });
		expect((await runMoved(movedCase({}, { listFail: true }))).result).toMatchObject({ code: "stripe_unreadable" });
		expect((await runMoved(movedCase({}, { searchFail: true }))).result).toMatchObject({ code: "stripe_unreadable" });
	});

	it("X's metadata naming O gives subscription_not_moved: no sync, and the listings' verdict is not reached", async () => {
		const z = stripeSub({ id: "sub_z", status: "active", orgId: T });
		const out = await runMoved(
			movedCase({ rows: [null] }, { x: stripeSub({ id: X, status: "active", orgId: O }), search: [z] }),
		);
		expect(out.result).toMatchObject({ code: "subscription_not_moved", reason: expect.stringContaining(O) });
		expect(out.sync.syncSubscriptionToBilling).not.toHaveBeenCalled();
	});
});

describe("release --moved-to: fresh reads under the lease (C101)", () => {
	beforeEach(() => {
		order = [];
		vi.mocked(lease.acquirePurchaseLease).mockImplementation(async () => {
			order.push("lease:acquire");
			return LEASE;
		});
	});

	it("takes the payer's lease before X or its customer is retrieved", async () => {
		await runMoved(movedCase());
		expect(order.indexOf("lease:acquire")).toBeLessThan(order.indexOf("stripe:subscriptions.retrieve"));
		expect(order.indexOf("lease:acquire")).toBeLessThan(order.indexOf("stripe:customers.retrieve"));
	});

	it("a busy lease is lease_busy-refused and X is never retrieved", async () => {
		vi.mocked(lease.acquirePurchaseLease).mockResolvedValue(null);
		const out = await runMoved(movedCase());
		expect(out.result).toMatchObject({ kind: "refused", reason: expect.stringMatching(/lease is still busy/) });
		expect(order.filter((o) => o.startsWith("stripe:"))).toEqual([]);
	});

	it("a hold released between the first read and the re-read is not_open, with no event; one the re-read finds with another note is not_link_refused", async () => {
		expect((await runMoved(movedCase({ reread: null }))).result).toEqual({ kind: "not_open" });
		expect(auditLines()).toEqual([]);
		const other = movedCase({ reread: hold({ state: "needs_operator", open_note: "backfill: B5 unproven" }) });
		expect((await runMoved(other)).result).toMatchObject({ code: "not_link_refused" });
		expect(store.releaseHold).not.toHaveBeenCalled();
	});

	it("releaseHold null with T's row still naming X is 'Nothing was written' (not_open); with the row now naming Z, row_changed; no event either way", async () => {
		vi.mocked(store.releaseHold).mockResolvedValue(null);
		const same = await runMoved(movedCase({ rows: [billing(X), billing(X)] }));
		expect(same.result).toEqual({ kind: "not_open" });
		expect(printed.some((l) => l.startsWith("Nothing was written"))).toBe(true);
		const changed = await runMoved(movedCase({ rows: [billing(X), billing("sub_z", "active")] }));
		expect(changed.result).toMatchObject({ kind: "refused", code: "row_changed", reason: expect.stringContaining("sub_z, active") });
		expect(auditLines()).toEqual([]);
	});

	it("lease renewal: false at the end of step 7 is lease_lost, with no sync, no release and no event; true after 150s of reads releases", async () => {
		const lost = await runMoved(movedCase({ renew: false, rows: [null, billing(X)] }));
		expect(lost.result).toMatchObject({ code: "lease_lost" });
		expect(lost.sync.syncSubscriptionToBilling).not.toHaveBeenCalled();
		expect(store.releaseHold).not.toHaveBeenCalled();
		expect(auditLines()).toEqual([]);

		const c = movedCase();
		const slow = { ...depsOver(fakeStripe({ sub: "active", invoice: "paid" }).stripe) };
		let reads = 0;
		slow.now = () => new Date(NOW.getTime() + (reads++ === 0 ? 0 : 150_000));
		const { moved } = movedDepsOf(c);
		db.queue.push([c.hold], [c.hold], [SETUP_LINE], [c.team], [c.member]);
		const out = await releaseHoldCommand(
			{ subscriptionId: X, reason: "r", operator: "op-1", movedTo: T },
			{ store, lease, sweeper: { ...sweeper, holdsManageBilling: async () => true }, sweepDeps: slow, moved },
			print,
		);
		expect(out).toMatchObject({ kind: "released" });
		expect(moved.lease.renewPurchaseLease).toHaveBeenCalledWith(LEASE);
	});
});

describe("release: the plain path names --moved-to for a link_refused hold (C102)", () => {
	it("the C98 fixture without --moved-to is refused, writes nothing, and says --moved-to with T's id; an unpaid non-link hold does not", async () => {
		const { stripe } = fakeStripe({ sub: "active", invoice: "paid" });
		const refusedHold = hold({ state: "needs_operator", opened_by: "link", open_note: LINK_REFUSED_NOTE });
		vi.mocked(sweeper.relinkAdoptedSetup).mockResolvedValueOnce({ kind: "not_linked", why: `it is already linked to another team (${T})` });
		db.queue.push([refusedHold], [refusedHold], [SETUP_LINE], [{ id: "setup-1" }]);
		const moved = await releaseHoldCommand(releaseArgs, serverDeps(stripe), print);
		expect(moved).toMatchObject({ kind: "refused", reason: expect.stringContaining("--moved-to") });
		expect(moved).toMatchObject({ reason: expect.stringContaining(T) });
		expect(store.releaseHold).not.toHaveBeenCalled();
		expect(auditLines()).toEqual([]);

		const unpaid = fakeStripe({ sub: "unpaid", invoice: "open" }).stripe;
		const plainHold = hold({ state: "needs_operator", open_note: null });
		vi.mocked(sweeper.relinkAdoptedSetup).mockResolvedValueOnce({ kind: "not_linked", why: "its customer was not minted by the setup's creator" });
		db.queue.push([plainHold], [plainHold], [SETUP_LINE], [{ id: "setup-1" }]);
		const control = await releaseHoldCommand(releaseArgs, serverDeps(unpaid), print);
		expect(control).toMatchObject({ kind: "refused" });
		expect(control).toMatchObject({ reason: expect.not.stringContaining("--moved-to") });
		expect(store.releaseHold).not.toHaveBeenCalled();
	});
});

describe("release --moved-to: the payer keeps paying (C108)", () => {
	it("U not a member, an admin, an owner not active, or an active owner without manage_billing: payer_not_in_team, nothing written, no sync", async () => {
		const cases = [
			movedCase({ member: null }),
			movedCase({ member: { role: "admin", status: "active" } }),
			movedCase({ member: { role: "owner", status: "suspended" } }),
			movedCase({ managesBilling: false }),
		];
		for (const c of cases) {
			vi.clearAllMocks();
			order = [];
			db.queue.length = 0;
			const out = await runMoved(c);
			expect(out.result).toMatchObject({ kind: "refused", code: "payer_not_in_team" });
			expectNothingWritten(out);
			expect(out.sync.syncSubscriptionToBilling).not.toHaveBeenCalled();
		}
	});
});
