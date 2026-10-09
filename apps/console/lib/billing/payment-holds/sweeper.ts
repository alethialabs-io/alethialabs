// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The payment-hold sweeper (ADR 0002 §5.4, I10, I11, Q3; S6 #5783): the REQUIRED scheduled caller of
// `advanceHold`. Liveness of every open hold rests on it, not on Stripe's webhook retries (§1.3 S10).
//
// ONE TICK (`runPaymentHoldSweep`):
//   1. selects the open holds that are DUE — `next_check_at <= now()`, or nudged since their last
//      observation (`nudged_at > observed_at`; the webhook nudges from slice 7) — oldest first, at most
//      `SWEEP_BATCH`;
//   2. for each, takes its payer's lease (`user:<payer>`) with a ZERO wait: a lease another caller holds
//      (the operator, another instance's tick, a create-a-team purchase) skips that hold until the
//      next tick;
//   3. under the lease, re-reads the row, runs `advanceHold` (up to 3 Stripe writes), and then the AGE
//      ALERT (§5.4, I11): once per hold and state entry, when the hold has sat in its state past the
//      bound its state and last observation give it (`ageAlertFor`);
//   4. sends the Q3 emails (`sendDueHoldNotices`, emails.ts) — the sweeper is their ONLY sender.
//
// It runs on every instance: the lease serialises them per payer, every state write is the store's
// compare-and-set on `version` and on that lease, and each email is claimed before it is sent. So two
// overlapping ticks, in one process or across instances, cannot advance one hold twice at once or mail
// one hold and state twice.
//
// From slice 9 an `adopted` release whose setup has an org runs the link's core here (§5.6 "When a hold
// ends"); until then such a setup stays open and the creator's next Create a team links it.
//
// Booted from instrumentation.ts every 5 minutes (`startPaymentHoldSweeper`, the `registerLoop` shape),
// with the optional twin route app/api/internal/payment-holds/sweep behind ALETHIA_CRON_SECRET, and
// `wakePaymentHoldSweeper()` for one immediate, coalesced tick.

import "server-only";
import { and, asc, eq, lte, ne, or, type SQL, sql } from "drizzle-orm";
import { alertPaymentNeedsSupport } from "@/lib/billing/payment-alert";
import { getPurchaseStripe } from "@/lib/billing/stripe";
import {
	fenceFor,
	type PurchaseLease,
	releasePurchaseLease,
	tryAcquirePurchaseLease,
} from "@/lib/billing/purchase-lease";
import { getServiceDb } from "@/lib/db";
import { type PaymentHoldRow, paymentHolds } from "@/lib/db/schema";
import { registerLoop, superviseLoop } from "@/lib/observability/heartbeats";
import { type DeliverHoldNotice, deliverHoldNotice, sendDueHoldNotices } from "./emails";
import { type AdvanceResult, advanceHold, type HoldMachineDeps, type HoldStripeWriter } from "./machine";
import type { HoldStripeReader } from "./observe";
import { payerLeaseKey, releaseHold, reserveRefundAttempt, writeHoldState } from "./store";

/** How often the in-process sweeper ticks (§5.4). */
export const SWEEP_INTERVAL_MS = 5 * 60_000;

/** The most holds one tick advances (§5.4). */
export const SWEEP_BATCH = 50;

/** Stable supervision id for this loop (lib/observability/heartbeats.ts). */
export const PAYMENT_HOLD_SWEEPER_LOOP_ID = "payment-hold-sweeper";

/** The Stripe client the machine needs: its reads and its writes. */
export type HoldStripe = HoldStripeReader & HoldStripeWriter;

/** Everything a tick touches outside the database, injectable for tests. */
export interface SweepDeps {
	/** Built only when a hold needs Stripe, so a deployment with no Stripe key never builds one. */
	stripe: () => HoldStripe;
	alert: HoldMachineDeps["alert"];
	deliver: DeliverHoldNotice;
	now: () => Date;
}

/**
 * The live dependencies. Stripe is the purchase path's client (lib/billing/stripe.ts): the machine's
 * calls run under the same 120s lease as the purchase's, so they get its shorter timeout.
 */
export function liveSweepDeps(): SweepDeps {
	return {
		stripe: () => getPurchaseStripe(),
		alert: (input) => alertPaymentNeedsSupport(input),
		deliver: deliverHoldNotice,
		now: () => new Date(),
	};
}

/** What one tick did, as counts only: no subscription, payer or amount leaves the sweeper. */
export interface SweepResult {
	/** Due holds selected. */
	due: number;
	/** Holds `advanceHold` ran on. */
	advanced: number;
	/** Of those, holds the call released. */
	released: number;
	/** Holds skipped because another caller held their payer's lease. */
	busy: number;
	/** Holds whose state write matched no row, or whose lease was lost mid-call. */
	stale: number;
	/** Age alerts raised. */
	ageAlerts: number;
	/** Q3 emails sent. */
	notices: number;
}

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;

/** The age bound an alert is raised past (§5.4), with the clause that names it. */
interface AgeBound {
	since: Date;
	ms: number;
	what: string;
}

/**
 * The §5.4 age bound that applies to `hold` now, or null when none does: the clock it runs from, its
 * length, and what it is about. Pure.
 *
 * `refund_due` has no row of its own in §5.4 — the refund budget sends it to an operator (T14) after
 * about 8h35m of failed attempts, or 32h35m when the last attempt's refund never reads back. That bound
 * holds only while observations succeed, so a 48h backstop from the state's entry alerts when they keep
 * failing and no attempt runs at all (I11: every open state has a finite bound).
 */
function ageBoundOf(hold: PaymentHoldRow): AgeBound | null {
	const entered = hold.state_since;
	const pay = hold.last_pay;
	switch (hold.state) {
		case "closing":
		case "cancel_unproven":
			if (pay === "in_flight") return { since: entered, ms: 14 * DAY, what: "a payment still processing" };
			if (pay === "capturable") return { since: entered, ms: 8 * DAY, what: "a payment authorised, not captured" };
			if (pay === "succeeded") return { since: entered, ms: HOUR, what: "a paid subscription not yet active" };
			return { since: entered, ms: DAY, what: "a checkout not proven closed" };
		case "payment_in_flight":
			return pay === "capturable"
				? { since: entered, ms: 8 * DAY, what: "a payment authorised, not captured" }
				: { since: entered, ms: 14 * DAY, what: "a payment still processing" };
		case "invoice_payable":
			return { since: entered, ms: DAY, what: "an invoice not proven unpayable" };
		case "refund_due":
			return { since: entered, ms: 2 * DAY, what: "a refund owed and not issued" };
		case "refund_pending":
			if (hold.refund_action_since !== null) {
				return { since: hold.refund_action_since, ms: DAY, what: "a refund waiting on requires_action" };
			}
			return { since: entered, ms: 14 * DAY, what: "a refund not yet settled" };
		default:
			return null;
	}
}

/**
 * Whether the sweeper raises an age alert for `hold` at `now` (§5.4, I11), and why — null when not.
 * Once per hold and state entry: a hold whose `age_alerted_at` is at or after its `state_since` was
 * already alerted for this entry. `needs_operator` alerts only when its entry alert did not reach a
 * channel (`alerted_at` before the entry): 24h after the entry, then every 7 days. Pure.
 */
export function ageAlertFor(hold: PaymentHoldRow, now: Date): string | null {
	if (hold.state === "released") return null;
	const alertedThisEntry = hold.age_alerted_at !== null && hold.age_alerted_at >= hold.state_since;
	if (hold.state === "needs_operator") {
		if (hold.alerted_at !== null && hold.alerted_at >= hold.state_since) return null;
		const since = alertedThisEntry && hold.age_alerted_at !== null ? hold.age_alerted_at : hold.state_since;
		const ms = alertedThisEntry ? 7 * DAY : DAY;
		return now.getTime() - since.getTime() >= ms
			? `payment hold ${hold.id} has waited for an operator since ${hold.state_since.toISOString()}, and its alert did not reach a channel`
			: null;
	}
	if (alertedThisEntry) return null;
	const bound = ageBoundOf(hold);
	if (!bound || now.getTime() - bound.since.getTime() < bound.ms) return null;
	return `payment hold ${hold.id} has been ${hold.state} since ${hold.state_since.toISOString()} (${bound.what}; last observation ${hold.last_pay ?? "none"})`;
}

/** The machine's dependencies for one hold under `lease`: the store's writes bound to it, and its fence. */
export function machineDepsFor(lease: PurchaseLease, deps: SweepDeps): HoldMachineDeps {
	const stripe = deps.stripe();
	return {
		reader: stripe,
		writer: stripe,
		store: {
			write: (ref, patch) => writeHoldState(lease, ref, patch),
			reserveRefundAttempt: (ref) => reserveRefundAttempt(lease, ref),
			release: (ref, input) => releaseHold(lease, ref, input),
		},
		fence: fenceFor(lease),
		alert: deps.alert,
		now: deps.now,
	};
}

/** The open hold `id` as the database has it now, or null when it is released or gone. */
async function readOpenHold(id: string): Promise<PaymentHoldRow | null> {
	const [row] = await getServiceDb()
		.select()
		.from(paymentHolds)
		.where(and(eq(paymentHolds.id, id), ne(paymentHolds.state, "released")));
	return row ?? null;
}

/** What one hold's visit did. */
export type HoldVisit =
	| { kind: "busy" }
	| { kind: "gone" }
	| { kind: "advanced"; result: AdvanceResult; ageAlerted: boolean };

/**
 * Advances one open hold under ITS payer's lease, taken with a zero wait, then raises its age alert when
 * one is due. The caller passes the row it selected; it is re-read under the lease, so a hold another
 * caller moved or released in between is advanced from what the database has now. The lease is given
 * back whatever happens.
 */
export async function visitHold(hold: PaymentHoldRow, deps: SweepDeps): Promise<HoldVisit> {
	const lease = await tryAcquirePurchaseLease(payerLeaseKey(hold.payer_key));
	if (!lease) return { kind: "busy" };
	try {
		const fresh = await readOpenHold(hold.id);
		if (!fresh) return { kind: "gone" };
		const result = await advanceHold(fresh, machineDepsFor(lease, deps));
		const ageAlerted = result.outcome === "open" ? await raiseAgeAlert(lease, result.hold, deps) : false;
		return { kind: "advanced", result, ageAlerted };
	} finally {
		try {
			await releasePurchaseLease(lease);
		} catch (err) {
			console.error("[billing] payment-hold sweeper could not release a lease; it lapses on its own:", err);
		}
	}
}

/**
 * The age alert (§5.4) for `hold`, under `lease`: stamps `age_alerted_at` with a fenced state write
 * FIRST, and raises the alert only when that write returned the row, so two callers can never both
 * alert for one entry. True when an alert was raised.
 */
async function raiseAgeAlert(lease: PurchaseLease, hold: PaymentHoldRow, deps: SweepDeps): Promise<boolean> {
	const now = deps.now();
	const detail = ageAlertFor(hold, now);
	if (detail === null) return false;
	const stamped = await writeHoldState(lease, { id: hold.id, version: hold.version }, { ageAlertedAt: now });
	if (!stamped) return false;
	await deps.alert({
		subscriptionId: hold.subscription_id,
		customerId: hold.customer_id,
		paymentIntentId: hold.payment_intent_id,
		detail,
	});
	return true;
}

/** The predicate of a hold that is due (§3.2 E1 (b)): scheduled now, or nudged since it was observed. */
function dueNow(): SQL | undefined {
	return and(
		ne(paymentHolds.state, "released"),
		or(lte(paymentHolds.next_check_at, sql`now()`), sql`${paymentHolds.nudged_at} > ${paymentHolds.observed_at}`),
	);
}

/** Options of one tick. */
export interface SweepOptions {
	/** Only this payer's holds and emails (the operator's `reconcile --payer`). */
	payerKey?: string;
	deps?: Partial<SweepDeps>;
}

/**
 * One sweeper tick (§5.4): advances every due open hold under its payer's lease, raises the age alerts,
 * then sends the Q3 emails. Never throws for one hold's failure; a database failure in the selection
 * itself is thrown to the loop's supervisor.
 */
export async function runPaymentHoldSweep(options: SweepOptions = {}): Promise<SweepResult> {
	const deps: SweepDeps = { ...liveSweepDeps(), ...options.deps };
	const result: SweepResult = { due: 0, advanced: 0, released: 0, busy: 0, stale: 0, ageAlerts: 0, notices: 0 };

	const due = await getServiceDb()
		.select()
		.from(paymentHolds)
		.where(and(dueNow(), options.payerKey ? eq(paymentHolds.payer_key, options.payerKey) : undefined))
		// Oldest first: by the moment the hold became due — its nudge when that is what made it due,
		// else its schedule.
		.orderBy(
			asc(
				sql`CASE WHEN ${paymentHolds.nudged_at} > ${paymentHolds.observed_at} THEN LEAST(${paymentHolds.nudged_at}, ${paymentHolds.next_check_at}) ELSE ${paymentHolds.next_check_at} END`,
			),
			asc(paymentHolds.created_at),
		)
		.limit(SWEEP_BATCH);
	result.due = due.length;

	for (const hold of due) {
		try {
			const visit = await visitHold(hold, deps);
			if (visit.kind === "busy") {
				result.busy += 1;
				continue;
			}
			if (visit.kind === "gone") continue;
			result.advanced += 1;
			if (visit.result.outcome === "released") result.released += 1;
			if (visit.result.outcome === "stale" || visit.result.outcome === "lease_lost") result.stale += 1;
			if (visit.ageAlerted) result.ageAlerts += 1;
		} catch (err) {
			// One hold's failure (a database error mid-write) must not starve the rest of the batch; the
			// hold stays open and due, so the next tick retries it.
			console.error(`[billing] payment-hold sweeper failed on hold ${hold.id}:`, err);
		}
	}

	result.notices = await sendDueHoldNotices({ deliver: deps.deliver, payerKey: options.payerKey });
	return result;
}

declare global {
	var __alethiaPaymentHoldSweeper: ReturnType<typeof setInterval> | undefined;
	var __alethiaPaymentHoldSweepRun:
		| { running: boolean; again: boolean; wake: ReturnType<typeof setTimeout> | null }
		| undefined;
}

/** The in-process tick state, shared across HMR reloads. */
function runState(): { running: boolean; again: boolean; wake: ReturnType<typeof setTimeout> | null } {
	globalThis.__alethiaPaymentHoldSweepRun ??= { running: false, again: false, wake: null };
	return globalThis.__alethiaPaymentHoldSweepRun;
}

/**
 * Runs one supervised tick unless one is already running in this process. A woken tick that finds one
 * running asks for exactly one more after it (`again`), so a nudge that lands mid-tick is not lost; an
 * interval tick that finds one running is simply skipped.
 */
async function tick(fromWake: boolean): Promise<void> {
	const state = runState();
	if (state.running) {
		if (fromWake) state.again = true;
		return;
	}
	state.running = true;
	try {
		await superviseLoop(PAYMENT_HOLD_SWEEPER_LOOP_ID, () => runPaymentHoldSweep());
	} finally {
		state.running = false;
	}
	if (state.again) {
		state.again = false;
		await tick(false);
	}
}

/**
 * Starts the sweeper in-process every `SWEEP_INTERVAL_MS` (idempotent across HMR). A no-op with no
 * database configured. With no Stripe key and no hold, a tick selects nothing and never builds a client.
 */
export function startPaymentHoldSweeper(): void {
	if (globalThis.__alethiaPaymentHoldSweeper) return;
	if (!process.env.ALETHIA_DATABASE_URL) return;
	registerLoop(PAYMENT_HOLD_SWEEPER_LOOP_ID, { intervalMs: SWEEP_INTERVAL_MS });
	globalThis.__alethiaPaymentHoldSweeper = setInterval(() => {
		void tick(false);
	}, SWEEP_INTERVAL_MS);
}

/**
 * Schedules one immediate tick (§5.4), coalesced: many wakes before it starts make one tick, and a wake
 * during a running tick makes one more after it. Never awaited by its caller and never throws.
 */
export function wakePaymentHoldSweeper(): void {
	if (!process.env.ALETHIA_DATABASE_URL) return;
	const state = runState();
	if (state.wake) return;
	state.wake = setTimeout(() => {
		state.wake = null;
		void tick(true);
	}, 0);
}
