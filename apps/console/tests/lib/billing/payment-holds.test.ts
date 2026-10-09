// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The H cases of ADR 0002 §6: `advanceHold`'s transition table (§3.3) over a fake Stripe and an
// in-memory store. Each test names the T-rows and the C-case it proves.

import { describe, expect, it } from "vitest";
import {
	advanceHold,
	decideOpen,
	type HoldMachineDeps,
	LINK_REFUSED_NOTE,
	operatorRelease,
} from "@/lib/billing/payment-holds/machine";
import { HOLD_REFUND_METADATA_KEY } from "@/lib/billing/payment-holds/observe";
import type { HoldRef, HoldStatePatch, ReleaseHoldInput } from "@/lib/billing/payment-holds/store";
import type { PaymentHoldRow } from "@/lib/db/schema";

const T0 = new Date("2026-10-09T12:00:00.000Z");
const MIN = 60_000;

/** A Stripe-shaped error. */
function stripeError(code: string, message = code): Error & { code: string } {
	return Object.assign(new Error(message), { code });
}

/** The fake Stripe account one hold lives in. */
interface World {
	sub: string;
	invoice: string;
	/** PaymentIntents on the held invoice; `nonPi` adds a payment that is not one. */
	pis: Array<{ id: string; status: string; amount: number }>;
	nonPi: boolean;
	hasMore: boolean;
	refunds: Record<string, Array<{ status: string; amount: number; metadata?: Record<string, string> }>>;
	/** The status of each refund `refunds.create` makes, in order; `throw` fails the call. */
	refundOutcomes: string[];
	/** Per method, errors thrown by the next calls. */
	fail: Record<string, unknown[]>;
	/** Per call to `invoicePayments.list`, a PaymentIntent list to show instead (a read race). */
	paymentReads: Array<Array<{ id: string; status: string; amount: number }>>;
	log: string[];
}

/** A world: an `incomplete` subscription with an open held invoice and no payment, unless overridden. */
function world(over: Partial<World> = {}): World {
	return { sub: "incomplete", invoice: "open", pis: [], nonPi: false, hasMore: false, refunds: {}, refundOutcomes: [], fail: {}, paymentReads: [], log: [], ...over };
}

/** A fake Stripe over `w`: reads and writes, each logged and each able to fail on demand. */
function stripeOf(w: World) {
	const call = (name: string) => {
		w.log.push(name);
		const err = w.fail[name]?.shift();
		if (err !== undefined) throw err;
	};
	return {
		subscriptions: {
			retrieve: async (id: string) => {
				call("subscriptions.retrieve");
				if (w.sub === "missing") throw stripeError("resource_missing");
				return { id, status: w.sub };
			},
			cancel: async (_id: string, params: { cancellation_details: { comment: string } }) => {
				call(`subscriptions.cancel:${params.cancellation_details.comment}`);
				w.sub = "canceled";
				return {};
			},
		},
		invoices: {
			retrieve: async (id: string) => {
				call(`invoices.retrieve:${id}`);
				if (w.invoice === "missing") throw stripeError("resource_missing");
				return { status: w.invoice };
			},
			voidInvoice: async (_id: string) => {
				call("invoices.voidInvoice");
				if (w.invoice !== "open" && w.invoice !== "uncollectible") throw stripeError("invoice_not_open");
				w.invoice = "void";
				for (const p of w.pis) if (p.status.startsWith("requires_")) p.status = "canceled";
				return {};
			},
			del: async (_id: string) => {
				call("invoices.del");
				w.invoice = "missing";
				return {};
			},
		},
		invoicePayments: {
			list: async (_params: { invoice: string; limit: number; expand: string[] }) => {
				call("invoicePayments.list");
				const pis = w.paymentReads.shift() ?? w.pis;
				type Payment = { status: string; payment: { type: string; payment_intent: { id: string; status: string; amount_received: number } | null } };
				const data = pis.map((p): Payment => ({
					status: p.status === "succeeded" ? "paid" : "open",
					payment: { type: "payment_intent", payment_intent: { id: p.id, status: p.status, amount_received: p.status === "succeeded" ? p.amount : 0 } },
				}));
				if (w.nonPi) data.push({ status: "paid", payment: { type: "charge", payment_intent: null } });
				return { has_more: w.hasMore, data };
			},
		},
		paymentIntents: {
			retrieve: async (id: string) => {
				call("paymentIntents.retrieve");
				return { id, status: "succeeded", amount_received: 0 };
			},
			cancel: async (id: string) => {
				call("paymentIntents.cancel");
				const pi = w.pis.find((p) => p.id === id);
				if (pi) pi.status = "canceled";
				return {};
			},
		},
		refunds: {
			list: async (params: { payment_intent: string; limit: number }) => {
				call("refunds.list");
				return { has_more: false, data: w.refunds[params.payment_intent] ?? [] };
			},
			create: async (
				params: { payment_intent: string; amount: number; metadata: Record<string, string> },
				options: { idempotencyKey: string },
			) => {
				call(`refunds.create:${options.idempotencyKey}`);
				const status = w.refundOutcomes.shift() ?? "succeeded";
				if (status === "throw") throw stripeError("rate_limit", "429 Too Many Requests");
				(w.refunds[params.payment_intent] ??= []).push({ status, amount: params.amount, metadata: params.metadata });
				return {};
			},
		},
	};
}

/** An open hold row in `state`. */
function holdRow(over: Partial<PaymentHoldRow> = {}): PaymentHoldRow {
	return {
		id: "hold_1",
		subscription_id: "sub_1",
		customer_id: "cus_1",
		payer_key: "user_1",
		invoice_id: "in_held",
		payment_intent_id: null,
		state: "closing",
		release_reason: null,
		released_at: null,
		released_by: null,
		release_note: null,
		refund_attempt: 0,
		attempts: 0,
		last_error: null,
		next_check_at: T0,
		alerted_at: null,
		notice_last_sent_at: null,
		notified_state: null,
		notified_at: null,
		opened_by_user_id: "user_1",
		opened_by: "purchase",
		open_note: null,
		state_since: new Date(T0.getTime() - 60 * MIN),
		last_pay: null,
		refund_action_since: null,
		age_alerted_at: null,
		observed_at: T0,
		nudged_at: null,
		version: 0,
		created_at: T0,
		updated_at: T0,
		...over,
	};
}

/** An in-memory store with the real store's version fence. `stale` makes the next write miss. */
function storeOf(w: World, initial: PaymentHoldRow) {
	const alerts: string[] = [];
	const s = { row: initial, stale: false, alerts };
	const fenced = (ref: HoldRef) => !s.stale && ref.id === s.row.id && ref.version === s.row.version && s.row.state !== "released";
	const store = {
		write: async (ref: HoldRef, patch: HoldStatePatch) => {
			w.log.push(`store.write:${patch.state ?? "-"}`);
			if (!fenced(ref)) return null;
			const r = s.row;
			s.row = {
				...r,
				state: patch.state ?? r.state,
				state_since: patch.state !== undefined && patch.state !== r.state ? T0 : r.state_since,
				attempts: patch.attempts ?? r.attempts,
				last_error: patch.lastError !== undefined ? patch.lastError : r.last_error,
				last_pay: patch.lastPay !== undefined ? patch.lastPay : r.last_pay,
				refund_action_since: patch.refundActionSince !== undefined ? patch.refundActionSince : r.refund_action_since,
				observed_at: patch.observedAt ?? r.observed_at,
				next_check_at: patch.nextCheckAt ?? r.next_check_at,
				alerted_at: patch.alertedAt !== undefined ? patch.alertedAt : r.alerted_at,
				version: r.version + 1,
			};
			return s.row;
		},
		reserveRefundAttempt: async (ref: HoldRef) => {
			w.log.push("store.reserve");
			if (!fenced(ref)) return null;
			s.row = { ...s.row, refund_attempt: s.row.refund_attempt + 1, version: s.row.version + 1 };
			return { attempt: s.row.refund_attempt - 1, hold: s.row };
		},
		release: async (ref: HoldRef, input: ReleaseHoldInput) => {
			w.log.push(`store.release:${input.reason}`);
			if (!fenced(ref)) return null;
			s.row = { ...s.row, state: "released", release_reason: input.reason, released_at: T0, released_by: input.releasedBy ?? null, release_note: input.note ?? null, next_check_at: null, version: s.row.version + 1 };
			return { hold: s.row, closedSetupId: null };
		},
	};
	return { s, store };
}

/** Runs `advanceHold` once over `w` from `hold`, and returns what it did with the fakes' state. */
async function run(w: World, hold: PaymentHoldRow, opts: { leaseLost?: boolean; alertDelivers?: boolean } = {}) {
	const { s, store } = storeOf(w, hold);
	const stripe = stripeOf(w);
	const deps: HoldMachineDeps = {
		reader: stripe,
		writer: stripe,
		store,
		fence: async () => {
			w.log.push("fence");
			if (opts.leaseLost) throw new Error("lease lost");
		},
		alert: async (input) => {
			s.alerts.push(input.detail);
			return opts.alertDelivers ?? true;
		},
		now: () => T0,
	};
	const result = await advanceHold(hold, deps);
	return { result, row: s.row, alerts: s.alerts, log: w.log, store: s };
}

/** The Stripe writes in a log, in order. */
function stripeWrites(log: string[]): string[] {
	return log.filter((l) => /^(invoices\.(voidInvoice|del)|subscriptions\.cancel|paymentIntents\.cancel|refunds\.create)/.test(l));
}

const succeeded = (amount = 2900) => ({ id: "pi_1", status: "succeeded", amount });

describe("advanceHold: the closing path (T1–T4)", () => {
	it("T3 → T3v → T9: voids the held invoice, re-reads it void, THEN cancels stamped, and releases voided_unpaid (C11)", async () => {
		const w = world({ pis: [{ id: "pi_1", status: "requires_payment_method", amount: 2900 }] });
		const { result, row } = await run(w, holdRow());
		expect(result.rows).toEqual(["T3", "T3v", "T9"]);
		expect(stripeWrites(w.log)).toEqual(["invoices.voidInvoice", "subscriptions.cancel:alethia:checkout_closed:hold_1"]);
		expect(row.state).toBe("released");
		expect(row.release_reason).toBe("voided_unpaid");
		// Every Stripe write is fenced first (§4.4 rule 1).
		expect(w.log.filter((l) => l === "fence")).toHaveLength(2);
	});

	it("C49 / T3a: the void rejects and the re-read shows paid — NO cancel, cancel_unproven, no alert", async () => {
		const w = world();
		const { s, store } = storeOf(w, holdRow());
		const stripe = stripeOf(w);
		// The payment lands as the void is attempted: Stripe refuses it, and the invoice now reads paid.
		const writer = {
			...stripe,
			invoices: {
				...stripe.invoices,
				voidInvoice: async () => {
					w.log.push("invoices.voidInvoice");
					w.invoice = "paid";
					throw stripeError("invoice_not_open");
				},
			},
		};
		const result = await advanceHold(holdRow(), { reader: stripe, writer, store, fence: async () => undefined, alert: async () => true, now: () => T0 });
		expect(result.rows).toEqual(["T3", "T3a"]);
		expect(stripeWrites(w.log)).toEqual(["invoices.voidInvoice"]);
		expect(s.row.state).toBe("cancel_unproven");
		expect(s.row.attempts).toBe(1);
		expect(result.alerted).toBe(false);
	});

	it("T3b: a second consecutive close failure from cancel_unproven alerts once per state entry", async () => {
		const w = world({ fail: { "invoices.voidInvoice": [stripeError("api_error", "500")] } });
		const first = await run(w, holdRow({ state: "cancel_unproven" }));
		expect(first.result.rows).toEqual(["T3", "T3b"]);
		expect(first.alerts).toHaveLength(1);
		expect(first.row.state).toBe("cancel_unproven");
		expect(first.row.alerted_at).toEqual(T0);
		// The same entry again: no second alert.
		w.fail["invoices.voidInvoice"] = [stripeError("api_error", "500")];
		const again = await run(w, first.row);
		expect(again.result.rows).toEqual(["T3", "T3b"]);
		expect(again.alerts).toHaveLength(0);
	});

	it("C48 / T3v: cancel_unproven, incomplete, invoice void, payment failed — cancels and reaches released(voided_unpaid)", async () => {
		const w = world({ invoice: "void", pis: [{ id: "pi_1", status: "canceled", amount: 2900 }] });
		const { result, row } = await run(w, holdRow({ state: "cancel_unproven" }));
		expect(result.rows).toEqual(["T3v", "T9"]);
		expect(row.release_reason).toBe("voided_unpaid");
	});

	it("T3v → T3a: a cancel that throws and a re-read still incomplete leaves cancel_unproven with no alert", async () => {
		const w = world({ invoice: "void", fail: { "subscriptions.cancel:alethia:checkout_closed:hold_1": [stripeError("api_error", "503")] } });
		const { result, row, alerts } = await run(w, holdRow());
		expect(result.rows).toEqual(["T3v", "T3a"]);
		expect(row.state).toBe("cancel_unproven");
		expect(row.last_error).toContain("subscriptions.cancel");
		expect(alerts).toHaveLength(0);
	});

	it("T4: closing with the first payment in flight changes nothing in Stripe and keeps blocking", async () => {
		for (const status of ["processing", "requires_capture", "succeeded"]) {
			const w = world({ invoice: status === "succeeded" ? "paid" : "open", pis: [{ id: "pi_1", status, amount: 2900 }] });
			const { result, row } = await run(w, holdRow());
			expect(result.rows).toEqual(["T4"]);
			expect(stripeWrites(w.log)).toEqual([]);
			expect(row.state).toBe("closing");
		}
	});

	it("C17 / T2: cancel_unproven with the subscription active is released(adopted) and never refunded", async () => {
		const w = world({ sub: "active", invoice: "paid", pis: [succeeded()] });
		const { result, row } = await run(w, holdRow({ state: "cancel_unproven" }));
		expect(result.rows).toEqual(["T2"]);
		expect(row.release_reason).toBe("adopted");
		expect(stripeWrites(w.log)).toEqual([]);
	});

	it("T1 / C29: a subscription Stripe cannot find goes to needs_operator with an alert that claims nothing went through", async () => {
		const w = world({ sub: "missing" });
		const { result, row, alerts } = await run(w, holdRow({ state: "invoice_payable" }));
		expect(result.rows).toEqual(["T1"]);
		expect(row.state).toBe("needs_operator");
		expect(row.next_check_at).toEqual(new Date(T0.getTime() + 24 * 60 * MIN));
		expect(alerts.join(" ")).not.toMatch(/went through/);
		expect(result.alerted).toBe(true);
	});

	it("I2: reads only the held invoice", async () => {
		const w = world({ sub: "canceled", invoice: "void" });
		await run(w, holdRow({ state: "invoice_payable" }));
		expect(w.log.filter((l) => l.startsWith("invoices.retrieve"))).toEqual(["invoices.retrieve:in_held"]);
	});
});

describe("advanceHold: positive evidence (T11r, T11)", () => {
	it("C50 / T11r: an empty payments read beside a paid invoice is re-read; succeeded on the second read refunds, with no alert", async () => {
		const w = world({ sub: "canceled", invoice: "paid", pis: [succeeded()], paymentReads: [[]] });
		const { result, row, alerts } = await run(w, holdRow({ state: "payment_in_flight" }));
		expect(result.rows).toEqual(["T11r", "T5", "T10"]);
		expect(alerts).toEqual([]);
		expect(row.release_reason).toBe("refunded");
	});

	it("C71: a paid invoice whose payments read empty twice is NEVER released(already_refunded): needs_operator, no refund", async () => {
		const w = world({ sub: "canceled", invoice: "paid", pis: [] });
		const { result, row } = await run(w, holdRow({ state: "refund_due" }));
		expect(result.rows).toEqual(["T11r", "T11r"]);
		expect(row.state).toBe("needs_operator");
		expect(stripeWrites(w.log)).toEqual([]);
	});

	it("C5 / T11 / C29: a payment that is not a PaymentIntent goes to needs_operator after one re-read, with no refund and no 'went through'", async () => {
		// On an open invoice it is T11; beside a paid invoice T11r sits above it and matches first.
		for (const [invoice, rows] of [["open", ["T11", "T11"]], ["paid", ["T11r", "T11r"]]]) {
			const w = world({ sub: "canceled", invoice: String(invoice), nonPi: true, pis: [succeeded()] });
			const { result, row, alerts } = await run(w, holdRow({ state: "refund_due" }));
			expect(result.rows).toEqual(rows);
			expect(row.state).toBe("needs_operator");
			expect(stripeWrites(w.log)).toEqual([]);
			expect(alerts.join(" ")).not.toMatch(/went through/);
			expect(alerts.join(" ")).not.toMatch(/no PaymentIntent .* took/);
		}
	});

	it("C72: `unrecognised` (has_more) on an ended subscription never matches T9 or T10", async () => {
		const w = world({ sub: "canceled", invoice: "void", hasMore: true });
		const { result, row } = await run(w, holdRow({ state: "invoice_payable" }));
		expect(result.rows).toEqual(["T11", "T11"]);
		expect(row.state).toBe("needs_operator");
	});

	it("C73: a refund_pending hold whose payments read empty is not released", async () => {
		const w = world({ sub: "canceled", invoice: "paid", pis: [] });
		const { result, row } = await run(w, holdRow({ state: "refund_pending" }));
		expect(result.rows).toEqual(["T11r", "T11r"]);
		expect(row.state).toBe("needs_operator");
	});
});

describe("advanceHold: refunds (T5, T10, T10p, T10f, T13, T14; §3.5)", () => {
	it("T5 / C75: the attempt is reserved BEFORE refunds.create, and the key is built from the reserved number", async () => {
		const w = world({ sub: "canceled", invoice: "paid", pis: [succeeded()] });
		const { result, row } = await run(w, holdRow({ state: "payment_in_flight" }));
		expect(result.rows).toEqual(["T5", "T10"]);
		const order = w.log.filter((l) => l === "store.reserve" || l === "fence" || l.startsWith("refunds.create"));
		expect(order).toEqual(["store.reserve", "fence", "refunds.create:hold-refund-pi_1-0"]);
		expect(row.refund_attempt).toBe(1);
		expect(w.refunds.pi_1?.[0]?.metadata?.[HOLD_REFUND_METADATA_KEY]).toBe("hold_1");
		expect(w.refunds.pi_1?.[0]?.amount).toBe(2900);
	});

	it("C75: a reservation that writes no row makes NO refund", async () => {
		const w = world({ sub: "canceled", invoice: "paid", pis: [succeeded()] });
		const { s, store } = storeOf(w, holdRow({ state: "refund_due" }));
		const stripe = stripeOf(w);
		const result = await advanceHold(holdRow({ state: "refund_due" }), {
			reader: stripe,
			writer: stripe,
			store: { ...store, reserveRefundAttempt: async () => null },
			fence: async () => undefined,
			alert: async () => true,
			now: () => T0,
		});
		expect(result.outcome).toBe("stale");
		expect(stripeWrites(w.log)).toEqual([]);
		expect(s.row.state).toBe("refund_due");
	});

	it("a lost lease after the reservation makes no refund (one number wasted, no key reused)", async () => {
		const w = world({ sub: "canceled", invoice: "paid", pis: [succeeded()] });
		const { result, row } = await run(w, holdRow({ state: "refund_due" }), { leaseLost: true });
		expect(result.outcome).toBe("lease_lost");
		expect(stripeWrites(w.log)).toEqual([]);
		expect(row.refund_attempt).toBe(1);
	});

	it("C4 / C8 / T13: attempt 0 fails → refund_due after the 5m backoff; the next call uses key -1 and releases(refunded)", async () => {
		const w = world({ sub: "canceled", invoice: "paid", pis: [succeeded()], refundOutcomes: ["throw"] });
		const first = await run(w, holdRow({ state: "payment_in_flight" }));
		expect(first.result.rows).toEqual(["T5", "T13"]);
		expect(first.row.state).toBe("refund_due");
		expect(first.row.next_check_at).toEqual(new Date(T0.getTime() + 5 * MIN));
		expect(first.row.last_error).toContain("refunds.create");
		const second = await run(w, first.row);
		expect(second.result.rows).toEqual(["T5", "T10"]);
		expect(stripeWrites(w.log)).toEqual(["refunds.create:hold-refund-pi_1-0", "refunds.create:hold-refund-pi_1-1"]);
		expect(second.row.release_reason).toBe("refunded");
	});

	it("C8 / T10: a refund already present is released(already_refunded) with no refunds.create", async () => {
		const w = world({ sub: "canceled", invoice: "paid", pis: [succeeded()], refunds: { pi_1: [{ status: "succeeded", amount: 2900 }] } });
		const { result, row } = await run(w, holdRow({ state: "refund_due" }));
		expect(result.rows).toEqual(["T10"]);
		expect(row.release_reason).toBe("already_refunded");
		expect(stripeWrites(w.log)).toEqual([]);
	});

	it("C54 / T10p / T10f: pending is refund_pending (never 'in full'); failed returns to refund_due with one alert; only succeeded releases(refunded)", async () => {
		const w = world({ sub: "canceled", invoice: "paid", pis: [succeeded()], refundOutcomes: ["pending"] });
		const first = await run(w, holdRow({ state: "payment_in_flight" }));
		expect(first.result.rows).toEqual(["T5", "T10p"]);
		expect(first.row.state).toBe("refund_pending");
		expect(first.row.release_reason).toBeNull();
		expect(first.alerts.join(" ")).not.toMatch(/in full/);

		const refund = w.refunds.pi_1?.[0];
		if (refund) refund.status = "failed";
		const failed = await run(w, first.row);
		expect(failed.result.rows).toEqual(["T10f"]);
		expect(failed.row.state).toBe("refund_due");
		expect(failed.row.refund_attempt).toBe(1);
		expect(failed.alerts).toHaveLength(1);

		const again = await run(w, failed.row);
		expect(again.result.rows).toEqual(["T5", "T10"]);
		expect(again.row.release_reason).toBe("refunded");
	});

	it("T10p: a refund in requires_action stamps refund_action_since and keeps it across observations", async () => {
		const w = world({ sub: "canceled", invoice: "paid", pis: [succeeded()], refunds: { pi_1: [{ status: "requires_action", amount: 2900 }] } });
		const { row } = await run(w, holdRow({ state: "refund_pending" }));
		expect(row.refund_action_since).toEqual(T0);
		const earlier = new Date(T0.getTime() - 60 * MIN);
		const kept = await run(w, { ...row, refund_action_since: earlier });
		expect(kept.row.refund_action_since).toEqual(earlier);
	});

	it("T5 / T13: a refund the re-read does not show yet (lag) is not made again in the same call", async () => {
		const w = world({ sub: "canceled", invoice: "paid", pis: [succeeded()] });
		const { s, store } = storeOf(w, holdRow({ state: "refund_due" }));
		const stripe = stripeOf(w);
		const reader = { ...stripe, refunds: { ...stripe.refunds, list: async () => ({ has_more: false, data: [] }) } };
		const result = await advanceHold(holdRow({ state: "refund_due" }), { reader, writer: stripe, store, fence: async () => undefined, alert: async () => true, now: () => T0 });
		expect(result.rows).toEqual(["T5", "T13"]);
		expect(stripeWrites(w.log)).toEqual(["refunds.create:hold-refund-pi_1-0"]);
		expect(s.row.state).toBe("refund_due");
	});

	it("T5 refunds only the uncovered part of a partial refund", async () => {
		const w = world({ sub: "canceled", invoice: "paid", pis: [succeeded(2900)], refunds: { pi_1: [{ status: "succeeded", amount: 900 }] } });
		await run(w, holdRow({ state: "refund_due" }));
		expect(w.refunds.pi_1?.[1]?.amount).toBe(2000);
	});

	it("T14: the fifth failed attempt goes to needs_operator with an alert", async () => {
		const w = world({ sub: "canceled", invoice: "paid", pis: [succeeded()], refundOutcomes: ["throw"] });
		const { result, row, alerts } = await run(w, holdRow({ state: "refund_due", refund_attempt: 4 }));
		expect(result.rows).toEqual(["T5", "T14"]);
		expect(row.state).toBe("needs_operator");
		expect(stripeWrites(w.log)).toEqual(["refunds.create:hold-refund-pi_1-4"]);
		expect(alerts).toHaveLength(1);
	});
});

describe("advanceHold: an ended subscription with no money taken (T6–T9, T12)", () => {
	it("T6: a payment processing after the cancel is payment_in_flight, checked hourly", async () => {
		const w = world({ sub: "canceled", pis: [{ id: "pi_1", status: "processing", amount: 2900 }] });
		const { result, row } = await run(w, holdRow());
		expect(result.rows).toEqual(["T6"]);
		expect(row.state).toBe("payment_in_flight");
		expect(row.next_check_at).toEqual(new Date(T0.getTime() + 60 * MIN));
	});

	it("C27 / T7: requires_capture after the cancel is cancelled, then the invoice is voided (T8) and the hold released", async () => {
		const w = world({ sub: "canceled", pis: [{ id: "pi_1", status: "requires_capture", amount: 2900 }] });
		const { result, row } = await run(w, holdRow({ state: "payment_in_flight" }));
		expect(result.rows).toEqual(["T7", "T8", "T9"]);
		expect(stripeWrites(w.log)).toEqual(["paymentIntents.cancel", "invoices.voidInvoice"]);
		expect(row.release_reason).toBe("voided_unpaid");
	});

	it("T7: a capture-cancel that does not take stays payment_in_flight", async () => {
		const w = world({ sub: "canceled", pis: [{ id: "pi_1", status: "requires_capture", amount: 2900 }], fail: { "paymentIntents.cancel": [stripeError("api_error")] } });
		const { result, row } = await run(w, holdRow({ state: "payment_in_flight" }));
		expect(result.rows).toEqual(["T7", "T7"]);
		expect(row.state).toBe("payment_in_flight");
	});

	it("C10 / T8: a processing payment that later failed is voided BEFORE the release", async () => {
		const w = world({ sub: "canceled", pis: [{ id: "pi_1", status: "canceled", amount: 2900 }] });
		const { result, row } = await run(w, holdRow({ state: "payment_in_flight" }));
		expect(result.rows).toEqual(["T8", "T9"]);
		expect(w.log.indexOf("invoices.voidInvoice")).toBeLessThan(w.log.indexOf("store.release:voided_unpaid"));
		expect(row.release_reason).toBe("voided_unpaid");
	});

	it("C10 / T12: a void that fails, with the payments still unpaid on re-read, is invoice_payable — never released", async () => {
		const w = world({ sub: "canceled", fail: { "invoices.voidInvoice": [stripeError("api_error")] } });
		const { result, row } = await run(w, holdRow({ state: "payment_in_flight" }));
		expect(result.rows).toEqual(["T8", "T12"]);
		expect(row.state).toBe("invoice_payable");
		expect(row.next_check_at).toEqual(new Date(T0.getTime() + 15 * MIN));
	});

	it("C3: invoice_payable plus a void that succeeds is released(voided_unpaid)", async () => {
		const w = world({ sub: "canceled" });
		const { result, row } = await run(w, holdRow({ state: "invoice_payable" }));
		expect(result.rows).toEqual(["T8", "T9"]);
		expect(row.release_reason).toBe("voided_unpaid");
	});

	it("C12 / T12: the void fails because a payment landed; the re-read shows succeeded and the machine refunds, with no 'no PaymentIntent took' alert", async () => {
		const w = world({ sub: "canceled", invoice: "open", pis: [{ id: "pi_1", status: "requires_payment_method", amount: 2900 }] });
		const { s, store } = storeOf(w, holdRow({ state: "invoice_payable" }));
		const stripe = stripeOf(w);
		const writer = {
			...stripe,
			invoices: {
				...stripe.invoices,
				voidInvoice: async () => {
					w.log.push("invoices.voidInvoice");
					w.invoice = "paid";
					w.pis = [succeeded()];
					throw stripeError("invoice_not_open");
				},
			},
		};
		const result = await advanceHold(holdRow({ state: "invoice_payable" }), { reader: stripe, writer, store, fence: async () => undefined, alert: async (a) => { s.alerts.push(a.detail); return true; }, now: () => T0 });
		expect(result.rows).toEqual(["T8", "T5", "T10"]);
		expect(s.row.release_reason).toBe("refunded");
		expect(s.alerts.join(" ")).not.toMatch(/no PaymentIntent .* took/);
	});

	it("C33 / T8d: a canceled prior with a draft invoice is deleted and released(deleted_draft)", async () => {
		const w = world({ sub: "canceled", invoice: "draft" });
		const { result, row } = await run(w, holdRow());
		expect(result.rows).toEqual(["T8d"]);
		expect(stripeWrites(w.log)).toEqual(["invoices.del"]);
		expect(row.release_reason).toBe("deleted_draft");
	});

	it("T8d: a draft that is still there after the delete is invoice_payable", async () => {
		const w = world({ sub: "canceled", invoice: "draft", fail: { "invoices.del": [stripeError("api_error")] } });
		const { row } = await run(w, holdRow());
		expect(row.state).toBe("invoice_payable");
	});

	it("T9: incomplete_expired with the held invoice void is released(expired_unpaid)", async () => {
		const w = world({ sub: "incomplete_expired", invoice: "void", pis: [{ id: "pi_1", status: "canceled", amount: 2900 }] });
		const { result, row } = await run(w, holdRow({ state: "invoice_payable" }));
		expect(result.rows).toEqual(["T9"]);
		expect(row.release_reason).toBe("expired_unpaid");
	});
});

describe("advanceHold: operator states (T15, T2o, T16, T17)", () => {
	it("C19 / T17: an ended hold whose subscription reads unpaid goes to needs_operator", async () => {
		const w = world({ sub: "unpaid" });
		const { result, row } = await run(w, holdRow({ state: "payment_in_flight" }));
		expect(result.rows).toEqual(["T17"]);
		expect(row.state).toBe("needs_operator");
	});

	it("C30 / T17: payment_in_flight with the subscription active goes to needs_operator, with no refund", async () => {
		const w = world({ sub: "active", invoice: "paid", pis: [succeeded()] });
		const { result, row } = await run(w, holdRow({ state: "payment_in_flight" }));
		expect(result.rows).toEqual(["T17"]);
		expect(row.state).toBe("needs_operator");
		expect(stripeWrites(w.log)).toEqual([]);
	});

	it("C82 / T2o: needs_operator with the subscription active is released(adopted); unpaid stays (T15)", async () => {
		const active = await run(world({ sub: "active", invoice: "paid", pis: [succeeded()] }), holdRow({ state: "needs_operator" }));
		expect(active.result.rows).toEqual(["T2o"]);
		expect(active.row.release_reason).toBe("adopted");

		const unpaid = await run(world({ sub: "unpaid" }), holdRow({ state: "needs_operator" }));
		expect(unpaid.result.rows).toEqual(["T15"]);
		expect(unpaid.row.state).toBe("needs_operator");
		expect(unpaid.alerts).toEqual([]);
	});

	it("C80 / T2o: a hold the link opened on its refusal is the operator's, even when the subscription is active", async () => {
		const w = world({ sub: "active", invoice: "paid", pis: [succeeded()] });
		const { result, row } = await run(w, holdRow({ state: "needs_operator", opened_by: "link", open_note: LINK_REFUSED_NOTE }));
		expect(result.rows).toEqual(["T15"]);
		expect(row.state).toBe("needs_operator");
	});

	it("T15: needs_operator never auto-releases, even on an ended, voided, unpaid subscription", async () => {
		const w = world({ sub: "canceled", invoice: "void" });
		const { result, row } = await run(w, holdRow({ state: "needs_operator" }));
		expect(result.rows).toEqual(["T15"]);
		expect(row.state).toBe("needs_operator");
		expect(stripeWrites(w.log)).toEqual([]);
	});

	it("T16: an operator release needs a reason, prints the observation, and writes released_by and the note", async () => {
		const w = world({ sub: "unpaid" });
		const { s, store } = storeOf(w, holdRow({ state: "needs_operator" }));
		const reader = stripeOf(w);
		await expect(operatorRelease(holdRow(), { reader, store }, { operatorId: "op_1", reason: "  " })).rejects.toThrow(/reason/);
		const out = await operatorRelease(holdRow({ state: "needs_operator" }), { reader, store }, { operatorId: "op_1", reason: "refunded by hand" });
		expect(out.observation).toMatchObject({ sub: { kind: "live", status: "unpaid" } });
		expect(s.row).toMatchObject({ state: "released", release_reason: "operator", released_by: "op_1", release_note: "refunded by hand" });
	});

	it("T18: a released hold is inert — nothing is read or written", async () => {
		const w = world();
		const { result } = await run(w, holdRow({ state: "released", release_reason: "operator", released_at: T0 }));
		expect(result.outcome).toBe("inert");
		expect(w.log).toEqual([]);
	});
});

describe("advanceHold: failures never move a hold (I5, C2, C14)", () => {
	const errors = [stripeError("rate_limit", "429"), stripeError("api_error", "500"), stripeError("ECONNRESET", "socket hang up")];
	const reads = ["subscriptions.retrieve", "invoices.retrieve:in_held", "invoicePayments.list", "refunds.list"];

	const cases: Array<[string, Error]> = reads.flatMap((read) => errors.map((err): [string, Error] => [read, err]));
	it.each(cases)(
		"C2 / C14: %s failing twice with %s changes only attempts, last_error and next_check_at",
		async (read, err) => {
			const w = world({ sub: "canceled", invoice: "paid", pis: [succeeded()], fail: { [read]: [err, err] } });
			const { result, row } = await run(w, holdRow({ state: "refund_due", attempts: 2 }));
			expect(result.outcome).toBe("open");
			expect(result.rows).toEqual([]);
			expect(row.state).toBe("refund_due");
			expect(row.attempts).toBe(3);
			expect(row.last_error).toContain(read.split(":")[0]);
			expect(stripeWrites(w.log)).toEqual([]);
		},
	);

	it("a read that fails once is retried and the observation goes on (readTwice)", async () => {
		const w = world({ sub: "canceled", invoice: "void", fail: { "subscriptions.retrieve": [stripeError("api_error")] } });
		const { row } = await run(w, holdRow({ state: "invoice_payable" }));
		expect(row.release_reason).toBe("voided_unpaid");
	});

	it("a state write that matches no row ends the call stale, with no further Stripe write", async () => {
		const w = world({ pis: [{ id: "pi_1", status: "processing", amount: 2900 }], sub: "canceled" });
		const { s, store } = storeOf(w, holdRow());
		s.stale = true;
		const stripe = stripeOf(w);
		const result = await advanceHold(holdRow(), { reader: stripe, writer: stripe, store, fence: async () => undefined, alert: async () => true, now: () => T0 });
		expect(result.outcome).toBe("stale");
		expect(stripeWrites(w.log)).toEqual([]);
	});

	it("the copy flag: alerted is false when the alert reached no channel (I8)", async () => {
		const { result } = await run(world({ sub: "missing" }), holdRow(), { alertDelivers: false });
		expect(result.alerted).toBe(false);
	});
});

describe("decideOpen (T0, T0h, T0f)", () => {
	it("maps the store's open result, and never surfaces another payer's hold", () => {
		const mine = holdRow();
		expect(decideOpen({ kind: "opened", hold: mine }, "user_1")).toEqual({ kind: "proceed", hold: mine });
		expect(decideOpen({ kind: "already_open", hold: mine }, "user_1")).toEqual({ kind: "refuse_held", hold: mine });
		expect(decideOpen({ kind: "already_open", hold: holdRow({ payer_key: "user_2" }) }, "user_1")).toEqual({ kind: "refuse_held", hold: null });
		expect(decideOpen({ kind: "lease_lost" }, "user_1")).toEqual({ kind: "refuse_unconfirmed" });
	});
});
