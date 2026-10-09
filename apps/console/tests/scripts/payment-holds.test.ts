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

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ getServiceDb: vi.fn() }));
vi.mock("@/lib/billing/stripe", () => ({ getStripe: vi.fn(), getPurchaseStripe: vi.fn() }));
vi.mock("@/lib/billing/payment-alert", () => ({ alertPaymentNeedsSupport: vi.fn() }));
vi.mock("@/lib/email/billing-email", () => ({ sendPaymentHoldNoticeEmail: vi.fn() }));
vi.mock("@/lib/billing/purchase-lease", () => ({
	tryAcquirePurchaseLease: vi.fn(),
	acquirePurchaseLease: vi.fn(),
	releasePurchaseLease: vi.fn(),
	fenceFor: vi.fn(() => async () => undefined),
}));
vi.mock("@/lib/billing/payment-holds/store", () => ({
	payerLeaseKey: (payer: string) => `user:${payer}`,
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
import { getServiceDb } from "@/lib/db";
import { PAYMENT_HOLD_NOTIFIED_STATES, type PaymentHoldRow } from "@/lib/db/schema";
import { sendGuardedEmail } from "@/lib/email/guard";
import {
	type BackfillStripe,
	type BackfillSubscription,
	backfillVerdict,
	main,
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
		expect(printed[0]).toMatch(/^hold hold-1 {2}sub sub_x {2}payer payer-1 {2}state closing/);
	});
});
