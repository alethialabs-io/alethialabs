// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The H cases of ADR 0002 §6 for the closing path, the first part of S5: `advanceHold`'s transition
// table (§3.3) over a fake Stripe and an in-memory store. Each test names the T-rows and the C-case it
// proves. The refund and release rows, and their cases, come with the second part.

import { describe, expect, it } from "vitest";
import {
	advanceHold,
	decideOpen,
	type HoldMachineDeps,
	LINK_REFUSED_NOTE,
	operatorRelease,
} from "@/lib/billing/payment-holds/machine";
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
	/** Adds a payment whose PaymentIntent is an unexpanded id that Stripe reports `resource_missing`. */
	missingPi: boolean;
	hasMore: boolean;
	/** Per method, errors thrown by the next calls. */
	fail: Record<string, unknown[]>;
	/** Per call to `invoicePayments.list`, a PaymentIntent list to show instead (a read race). */
	paymentReads: Array<Array<{ id: string; status: string; amount: number }>>;
	log: string[];
}

/** A world: an `incomplete` subscription with an open held invoice and no payment, unless overridden. */
function world(over: Partial<World> = {}): World {
	return {
		sub: "incomplete",
		invoice: "open",
		pis: [],
		nonPi: false,
		missingPi: false,
		hasMore: false,
		fail: {},
		paymentReads: [],
		log: [],
		...over,
	};
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
		},
		invoicePayments: {
			list: async (_params: { invoice: string; limit: number; expand: string[] }) => {
				call("invoicePayments.list");
				const pis = w.paymentReads.shift() ?? w.pis;
				type Payment = {
					status: string;
					payment: {
						type: string;
						payment_intent: { id: string; status: string; amount_received: number } | null;
					};
				};
				const data = pis.map((p): Payment => ({
					status: p.status === "succeeded" ? "paid" : "open",
					payment: {
						type: "payment_intent",
						payment_intent: {
							id: p.id,
							status: p.status,
							amount_received: p.status === "succeeded" ? p.amount : 0,
						},
					},
				}));
				if (w.nonPi) data.push({ status: "paid", payment: { type: "charge", payment_intent: null } });
				const all: Array<{
					status: string;
					payment: { type: string; payment_intent: Payment["payment"]["payment_intent"] | string };
				}> = data;
				if (w.missingPi)
					all.push({ status: "open", payment: { type: "payment_intent", payment_intent: "pi_gone" } });
				return { has_more: w.hasMore, data: all };
			},
		},
		paymentIntents: {
			retrieve: async (id: string) => {
				call("paymentIntents.retrieve");
				if (id === "pi_gone") throw stripeError("resource_missing");
				return { id, status: "succeeded", amount_received: 0 };
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
	const fenced = (ref: HoldRef) =>
		!s.stale && ref.id === s.row.id && ref.version === s.row.version && s.row.state !== "released";
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
				refund_action_since:
					patch.refundActionSince !== undefined ? patch.refundActionSince : r.refund_action_since,
				observed_at: patch.observedAt ?? r.observed_at,
				next_check_at: patch.nextCheckAt ?? r.next_check_at,
				alerted_at: patch.alertedAt !== undefined ? patch.alertedAt : r.alerted_at,
				version: r.version + 1,
			};
			return s.row;
		},
		release: async (ref: HoldRef, input: ReleaseHoldInput) => {
			w.log.push(`store.release:${input.reason}`);
			if (!fenced(ref)) return null;
			s.row = {
				...s.row,
				state: "released",
				release_reason: input.reason,
				released_at: T0,
				released_by: input.releasedBy ?? null,
				release_note: input.note ?? null,
				next_check_at: null,
				version: s.row.version + 1,
			};
			return { hold: s.row, closedSetupId: null };
		},
	};
	return { s, store };
}

/** Runs `advanceHold` once over `w` from `hold`, and returns what it did with the fakes' state. */
async function run(
	w: World,
	hold: PaymentHoldRow,
	opts: { leaseLost?: boolean; alertDelivers?: boolean } = {},
) {
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
	return log.filter((l) =>
		/^(invoices\.(voidInvoice|del)|subscriptions\.cancel|paymentIntents\.cancel|refunds\.create)/.test(l),
	);
}

const succeeded = (amount = 2900) => ({ id: "pi_1", status: "succeeded", amount });

describe("advanceHold: the closing path (T1–T4)", () => {
	it("T3 → T3v: voids the held invoice, re-reads it void, THEN cancels stamped (C11); the ended subscription keeps the hold open", async () => {
		const w = world({ pis: [{ id: "pi_1", status: "requires_payment_method", amount: 2900 }] });
		const { result, row } = await run(w, holdRow());
		expect(result.rows).toEqual(["T3", "T3v", "ended"]);
		expect(stripeWrites(w.log)).toEqual([
			"invoices.voidInvoice",
			"subscriptions.cancel:alethia:checkout_closed:hold_1",
		]);
		// Until the second part's T9, nothing is released on an ended read: the hold stays and blocks.
		expect(row.state).toBe("closing");
		expect(row.release_reason).toBeNull();
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
		const result = await advanceHold(holdRow(), {
			reader: stripe,
			writer,
			store,
			fence: async () => undefined,
			alert: async () => true,
			now: () => T0,
		});
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

	it("C48 / T3v: cancel_unproven, incomplete, invoice void, payment failed — cancels, and the re-read reads it ended", async () => {
		const w = world({ invoice: "void", pis: [{ id: "pi_1", status: "canceled", amount: 2900 }] });
		const { result, row } = await run(w, holdRow({ state: "cancel_unproven" }));
		expect(result.rows).toEqual(["T3v", "ended"]);
		expect(stripeWrites(w.log)).toEqual(["subscriptions.cancel:alethia:checkout_closed:hold_1"]);
		expect(row.state).toBe("cancel_unproven");
		expect(row.alerted_at).toBeNull();
	});

	it("T3v → T3a: a cancel that throws and a re-read still incomplete leaves cancel_unproven with no alert", async () => {
		const w = world({
			invoice: "void",
			fail: { "subscriptions.cancel:alethia:checkout_closed:hold_1": [stripeError("api_error", "503")] },
		});
		const { result, row, alerts } = await run(w, holdRow());
		expect(result.rows).toEqual(["T3v", "T3a"]);
		expect(row.state).toBe("cancel_unproven");
		expect(row.last_error).toContain("subscriptions.cancel");
		expect(alerts).toHaveLength(0);
	});

	it("T4: closing with the first payment in flight changes nothing in Stripe and keeps blocking", async () => {
		for (const status of ["processing", "requires_capture", "succeeded"]) {
			const w = world({
				invoice: status === "succeeded" ? "paid" : "open",
				pis: [{ id: "pi_1", status, amount: 2900 }],
			});
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
		const w = world({ invoice: "void" });
		await run(w, holdRow());
		const reads = w.log.filter((l) => l.startsWith("invoices.retrieve"));
		expect(reads.length).toBeGreaterThan(0);
		expect(new Set(reads)).toEqual(new Set(["invoices.retrieve:in_held"]));
	});
});

describe("advanceHold: positive evidence (T11r, T11)", () => {
	it("C71: a paid invoice whose payments read empty twice is NEVER released(already_refunded): needs_operator, no refund", async () => {
		const w = world({ sub: "canceled", invoice: "paid", pis: [] });
		const { result, row } = await run(w, holdRow({ state: "refund_due" }));
		expect(result.rows).toEqual(["T11r", "T11r"]);
		expect(row.state).toBe("needs_operator");
		expect(stripeWrites(w.log)).toEqual([]);
	});

	it("C5 / T11 / C29: a payment that is not a PaymentIntent goes to needs_operator after one re-read, with no refund and no 'went through'", async () => {
		// On an open invoice it is T11; beside a paid invoice T11r sits above it and matches first.
		for (const [invoice, rows] of [
			["open", ["T11", "T11"]],
			["paid", ["T11r", "T11r"]],
		]) {
			const w = world({ sub: "canceled", invoice: String(invoice), nonPi: true, pis: [succeeded()] });
			const { result, row, alerts } = await run(w, holdRow({ state: "refund_due" }));
			expect(result.rows).toEqual(rows);
			expect(row.state).toBe("needs_operator");
			expect(stripeWrites(w.log)).toEqual([]);
			expect(alerts.join(" ")).not.toMatch(/went through/);
			expect(alerts.join(" ")).not.toMatch(/no PaymentIntent .* took/);
		}
	});

	it("§3.4 S7: incomplete with the held invoice void but a payment in flight or succeeded is NEVER cancelled (T4)", async () => {
		for (const status of ["processing", "requires_capture", "succeeded"]) {
			const w = world({ invoice: "void", pis: [{ id: "pi_1", status, amount: 2900 }] });
			const { result, row } = await run(w, holdRow());
			expect(result.rows).toEqual(["T4"]);
			expect(stripeWrites(w.log)).toEqual([]);
			expect(row.state).toBe("closing");
		}
	});

	it("a PaymentIntent Stripe reports resource_missing is never read as absent: no void, needs_operator (T11)", async () => {
		const w = world({ missingPi: true });
		const { result, row } = await run(w, holdRow());
		expect(result.rows).toEqual(["T11", "T11"]);
		expect(stripeWrites(w.log)).toEqual([]);
		expect(row.state).toBe("needs_operator");
	});

	it("C72: `unrecognised` (has_more) is never read as unpaid — no void, no cancel, needs_operator after one re-read", async () => {
		for (const sub of ["incomplete", "canceled"]) {
			const w = world({ sub, invoice: "open", hasMore: true });
			const { result, row } = await run(w, holdRow());
			expect(result.rows).toEqual(["T11", "T11"]);
			expect(stripeWrites(w.log)).toEqual([]);
			expect(row.state).toBe("needs_operator");
		}
	});

	it("C73: a refund_pending hold whose payments read empty is not released", async () => {
		const w = world({ sub: "canceled", invoice: "paid", pis: [] });
		const { result, row } = await run(w, holdRow({ state: "refund_pending" }));
		expect(result.rows).toEqual(["T11r", "T11r"]);
		expect(row.state).toBe("needs_operator");
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
		const active = await run(
			world({ sub: "active", invoice: "paid", pis: [succeeded()] }),
			holdRow({ state: "needs_operator" }),
		);
		expect(active.result.rows).toEqual(["T2o"]);
		expect(active.row.release_reason).toBe("adopted");

		const unpaid = await run(world({ sub: "unpaid" }), holdRow({ state: "needs_operator" }));
		expect(unpaid.result.rows).toEqual(["T15"]);
		expect(unpaid.row.state).toBe("needs_operator");
		expect(unpaid.alerts).toEqual([]);
	});

	it("T1 on a needs_operator hold alerts once per state entry and stays (T15 never releases)", async () => {
		const first = await run(world({ sub: "missing" }), holdRow({ state: "needs_operator" }));
		expect(first.result.rows).toEqual(["T1"]);
		expect(first.alerts).toHaveLength(1);
		expect(first.row.state).toBe("needs_operator");
		const again = await run(world({ sub: "missing" }), first.row);
		expect(again.alerts).toHaveLength(0);
	});

	it("C80 / T2o: a hold the link opened on its refusal is the operator's, even when the subscription is active", async () => {
		const w = world({ sub: "active", invoice: "paid", pis: [succeeded()] });
		const { result, row } = await run(
			w,
			holdRow({ state: "needs_operator", opened_by: "link", open_note: LINK_REFUSED_NOTE }),
		);
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
		await expect(
			operatorRelease(holdRow(), { reader, store }, { operatorId: "op_1", reason: "  " }),
		).rejects.toThrow(/reason/);
		const out = await operatorRelease(
			holdRow({ state: "needs_operator" }),
			{ reader, store },
			{ operatorId: "op_1", reason: "refunded by hand" },
		);
		expect(out.observation).toMatchObject({ sub: { kind: "live", status: "unpaid" } });
		expect(s.row).toMatchObject({
			state: "released",
			release_reason: "operator",
			released_by: "op_1",
			release_note: "refunded by hand",
		});
	});

	it("T18: a released hold is inert — nothing is read or written", async () => {
		const w = world();
		const { result } = await run(
			w,
			holdRow({ state: "released", release_reason: "operator", released_at: T0 }),
		);
		expect(result.outcome).toBe("inert");
		expect(w.log).toEqual([]);
	});
});

describe("advanceHold: failures never move a hold (I5, C2, C14)", () => {
	const errors = [
		stripeError("rate_limit", "429"),
		stripeError("api_error", "500"),
		stripeError("ECONNRESET", "socket hang up"),
	];
	const reads = ["subscriptions.retrieve", "invoices.retrieve:in_held", "invoicePayments.list"];

	const cases: Array<[string, Error]> = reads.flatMap((read) =>
		errors.map((err): [string, Error] => [read, err]),
	);
	it.each(cases)(
		"C2 / C14: %s failing twice with %s changes only attempts, last_error and next_check_at",
		async (read, err) => {
			const w = world({ fail: { [read]: [err, err] } });
			const { result, row } = await run(w, holdRow({ attempts: 2 }));
			expect(result.outcome).toBe("open");
			expect(result.rows).toEqual([]);
			expect(row.state).toBe("closing");
			expect(row.next_check_at).toEqual(new Date(T0.getTime() + 5 * MIN));
			expect(row.attempts).toBe(3);
			expect(row.last_error).toContain(read.split(":")[0]);
			expect(stripeWrites(w.log)).toEqual([]);
		},
	);

	it("a read that fails once is retried and the observation goes on (readTwice)", async () => {
		const w = world({
			sub: "active",
			invoice: "paid",
			pis: [succeeded()],
			fail: { "subscriptions.retrieve": [stripeError("api_error")] },
		});
		const { row } = await run(w, holdRow());
		expect(row.release_reason).toBe("adopted");
	});

	it("a state write that matches no row ends the call stale and keeps the row it started from", async () => {
		// The call voids and cancels (T3 → T3v), and its last state write then finds the version moved.
		const w = world();
		const { s, store } = storeOf(w, holdRow());
		const stripe = stripeOf(w);
		const result = await advanceHold(holdRow(), {
			reader: stripe,
			writer: stripe,
			store: {
				...store,
				write: async (ref, patch) => {
					s.stale = true;
					return store.write(ref, patch);
				},
			},
			fence: async () => undefined,
			alert: async () => true,
			now: () => T0,
		});
		expect(result.outcome).toBe("stale");
		expect(result.hold.version).toBe(0);
		expect(stripeWrites(w.log)).toEqual([
			"invoices.voidInvoice",
			"subscriptions.cancel:alethia:checkout_closed:hold_1",
		]);
	});

	it("§4.4 rule 1: a lost lease stops the call before any Stripe write", async () => {
		const w = world();
		const { result, row } = await run(w, holdRow(), { leaseLost: true });
		expect(result.outcome).toBe("lease_lost");
		expect(w.log).toContain("fence");
		expect(stripeWrites(w.log)).toEqual([]);
		expect(row.state).toBe("closing");
	});

	it("a lost lease after the void stops the cancel", async () => {
		const w = world({ invoice: "void" });
		const { result } = await run(w, holdRow({ state: "cancel_unproven" }), { leaseLost: true });
		expect(result.outcome).toBe("lease_lost");
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
		expect(decideOpen({ kind: "already_open", hold: mine }, "user_1")).toEqual({
			kind: "refuse_held",
			hold: mine,
		});
		expect(decideOpen({ kind: "already_open", hold: holdRow({ payer_key: "user_2" }) }, "user_1")).toEqual({
			kind: "refuse_held",
			hold: null,
		});
		expect(decideOpen({ kind: "lease_lost" }, "user_1")).toEqual({ kind: "refuse_unconfirmed" });
	});
});
