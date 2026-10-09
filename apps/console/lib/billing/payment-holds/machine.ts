// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// `advanceHold`: the payment-hold state machine (ADR 0002 §3, S5 #5763) — the only code that moves a
// hold. NO CALLER YET: from slice 6 the sweeper runs it, and from slice 8 the create-a-team flow does,
// each under the payer's lease. Stripe, the store, the lease fence, the alert and the clock are all
// injected, so the transition table is tested without a network or a database.
//
// THE TABLE (§3.3) is `decide`: one observation in, the first matching row out, top to bottom. The rows
// are named by their T-numbers, and `advanceHold` reports every row it matched. Three rules shape it:
//
//   POSITIVE EVIDENCE. A row that releases a hold matches only a positively-read terminal state, never
//   the absence of something. T2 and T2o need a subscription that reads live. T10 needs succeeded
//   PaymentIntents (a non-empty list) whose refunds read `succeeded`. T9 needs an ENDED subscription, a
//   `void` invoice and a complete, recognised payment list — or an invoice Stripe no longer has (`none`,
//   a deleted draft, which was never payable; see `decide`). An invoice that reads `paid` with no
//   succeeded PaymentIntent (T11r), and a payment the machine does not recognise (T11), are re-read
//   once and then go to an operator; both rows sit ABOVE every refund and release row.
//
//   VOID BEFORE CANCEL (§3.4). The machine cancels only after a re-read shows the held invoice `void`
//   (T3 → T3v). A paid invoice cannot be voided (S2), so the machine never cancels a subscription whose
//   first invoice is paid. A void that fails makes no cancel (T3a).
//
//   THE REFUND ATTEMPT IS RESERVED BEFORE THE CALL (§3.5). T5 consumes an attempt number with a fenced
//   state write first, and builds the idempotency key `hold-refund-<pi>-<n>` from the number it got. No
//   refund is created unless that write returned a row. A crash after it wastes a number and never
//   reuses a key. The refund list is read before every attempt, so the read decides, not the key, and
//   one call never refunds twice, even when its re-read does not show the refund it just made.
//
// A failed observation (a Stripe read error) is not an event: it writes only `attempts`, `last_error`
// and `next_check_at` (I5). The machine reads, voids, deletes and refunds only the HELD invoice and its
// PaymentIntents, never the subscription's `latest_invoice` (I2).
// Every Stripe write is preceded by the lease fence (§4.4 rule 1); a fence that throws ends the call
// with no further write.

import type { OpenPaymentHoldState, PaymentHoldReleaseReason, PaymentHoldRow } from "@/lib/db/schema";
import {
	HOLD_REFUND_METADATA_KEY,
	type HoldObservation,
	HoldObservationError,
	type HoldStripeReader,
	isResourceMissing,
	observeHold,
	type SucceededPayment,
} from "./observe";
import type { HoldRef, HoldStatePatch, OpenHoldResult, ReleaseHoldInput } from "./store";

/** The write half of the Stripe client the machine uses (a structural subset of the SDK). */
export interface HoldStripeWriter {
	invoices: {
		voidInvoice(id: string): Promise<unknown>;
		del(id: string): Promise<unknown>;
	};
	subscriptions: {
		cancel(id: string, params: { cancellation_details: { comment: string } }): Promise<unknown>;
	};
	paymentIntents: { cancel(id: string): Promise<unknown> };
	refunds: {
		create(
			params: { payment_intent: string; amount: number; metadata: Record<string, string> },
			options: { idempotencyKey: string },
		): Promise<unknown>;
	};
}

/** The store writes the machine makes, already bound to the caller's lease (`store.ts`). */
export interface HoldStore {
	write(ref: HoldRef, patch: HoldStatePatch): Promise<PaymentHoldRow | null>;
	/** T5's reservation (§3.5): the attempt number consumed, or null when no row was written. */
	reserveRefundAttempt(ref: HoldRef): Promise<{ attempt: number; hold: PaymentHoldRow } | null>;
	release(
		ref: HoldRef,
		input: ReleaseHoldInput,
	): Promise<{ hold: PaymentHoldRow; closedSetupId: string | null } | null>;
}

/** Everything `advanceHold` touches outside itself. */
export interface HoldMachineDeps {
	reader: HoldStripeReader;
	writer: HoldStripeWriter;
	store: HoldStore;
	/** The lease renewal before every Stripe write (§4.4 rule 1). Throws when the lease is lost. */
	fence: () => Promise<void>;
	/** `alertPaymentNeedsSupport`'s shape: true only when the alert reached a channel (I8). */
	alert: (input: {
		subscriptionId: string;
		customerId: string;
		paymentIntentId: string | null;
		detail: string;
	}) => Promise<boolean>;
	now: () => Date;
}

/** The `open_note` of a hold the link opened on its refusal (C80): an operator's, never adopted by T2o. */
export const LINK_REFUSED_NOTE = "link_refused";

/** The refund budget (§3.5, Q4): the most refund attempts before an operator (T14). */
export const REFUND_BUDGET = 5;
/** The wait after the n-th refund attempt (§3.5): 5m, 30m, 2h, 6h, 24h. */
const REFUND_BACKOFF_MS = [5, 30, 120, 360, 1440].map((m) => m * 60_000);

/** The most Stripe writes one call makes (§3.3, "up to 3 steps per call"). */
const MAX_ACTS = 3;
/**
 * The most observations one call makes: the first, one after each act, and one re-read (T11r / T11),
 * which is made at most once per call.
 */
const MAX_READS = 1 + MAX_ACTS + 1;

const MINUTE = 60_000;
/** When an open state is checked next (§3.1). `refund_due` follows the §3.5 refund backoff instead. */
const NEXT_CHECK_MS: Record<Exclude<OpenPaymentHoldState, "refund_due">, number> = {
	closing: 5 * MINUTE,
	cancel_unproven: 5 * MINUTE,
	invoice_payable: 15 * MINUTE,
	payment_in_flight: 60 * MINUTE,
	refund_pending: 60 * MINUTE,
	needs_operator: 24 * 60 * MINUTE,
};

/** The rows of §3.3 the machine can match. */
export type HoldRow =
	| "T1"
	| "T2"
	| "T2o"
	| "T3"
	| "T3v"
	| "T3a"
	| "T3b"
	| "T4"
	| "T5"
	| "T6"
	| "T7"
	| "T8"
	| "T8d"
	| "T9"
	| "T10"
	| "T10p"
	| "T10f"
	| "T11"
	| "T11r"
	| "T12"
	| "T13"
	| "T14"
	| "T15"
	| "T17";

/** A Stripe write the machine makes for a row. */
type Act =
	| { do: "void" }
	| { do: "cancel" }
	| { do: "cancel_pi"; pi: string }
	| { do: "delete_draft" }
	| { do: "refund"; pis: SucceededPayment[] };

/** What one observation decides (§3.3). */
export type Decision = { row: HoldRow } & (
	| { kind: "release"; reason: PaymentHoldReleaseReason }
	| { kind: "stay"; state: OpenPaymentHoldState; alert?: string; countAttempt?: boolean }
	| { kind: "operator"; detail: string; pi?: string }
	| { kind: "reread" }
	| { kind: "act"; act: Act }
);

/** What has already happened in this call, which changes the rows a re-observation can match. */
export interface CallContext {
	/** A re-read for T11r / T11 was made: the next match of either goes to an operator. */
	reread: boolean;
	/** A cancel was attempted (T3v): a subscription still `incomplete` is `cancel_unproven`. */
	cancelAttempted: boolean;
	/** A void of an ended subscription's invoice failed (T12): no second void in this call. */
	voidFailed: boolean;
	/** This call voided the held invoice itself (T8), so its release reason is `voided_unpaid`. */
	voided: boolean;
	/** A `paymentIntents.cancel` was attempted (T7): still `requires_capture` stays `payment_in_flight`. */
	piCancelAttempted: boolean;
	/** A `refunds.create` was made: no second refund in this call, even when the re-read lags (§3.5). */
	refundAttempted: boolean;
	/** A `refunds.create` threw (T13 / T14). */
	refundFailed: boolean;
}

/** A fresh call's context. */
function newCallContext(): CallContext {
	return {
		reread: false,
		cancelAttempted: false,
		voidFailed: false,
		voided: false,
		piCancelAttempted: false,
		refundAttempted: false,
		refundFailed: false,
	};
}

/** `closing` and `cancel_unproven`: the states before the subscription is proven ended. */
function isClosing(state: string): state is "closing" | "cancel_unproven" {
	return state === "closing" || state === "cancel_unproven";
}

/**
 * The transition table (§3.3) for one observation of an OPEN hold: the first matching row. Pure.
 * A shape no row names goes to an operator (T17), never to a release.
 */
function decide(
	hold: Pick<PaymentHoldRow, "state" | "open_note" | "refund_attempt">,
	obs: HoldObservation,
	ctx: CallContext,
): Decision {
	const { sub, inv, pay } = obs;
	const state = hold.state;

	if (state === "needs_operator") {
		// T2o: a paid, live subscription is the customer's to keep. Not for the link's refusal (C80).
		if (
			sub.kind === "live" &&
			(sub.status === "active" || sub.status === "trialing") &&
			hold.open_note !== LINK_REFUSED_NOTE
		) {
			return { row: "T2o", kind: "release", reason: "adopted" };
		}
		// T1 matches from any open state. On a hold already with an operator it changes nothing but the
		// alert, which is raised once per state entry.
		if (sub.kind === "missing") {
			return {
				row: "T1",
				kind: "stay",
				state: "needs_operator",
				alert: "subscription not found in Stripe (resource_missing) while the hold was needs_operator",
			};
		}
		return { row: "T15", kind: "stay", state: "needs_operator" };
	}

	if (sub.kind === "missing") {
		return {
			row: "T1",
			kind: "operator",
			detail: `subscription not found in Stripe (resource_missing) while the hold was ${state}`,
		};
	}

	if (isClosing(state) && sub.kind === "live") return { row: "T2", kind: "release", reason: "adopted" };

	if (isClosing(state) && sub.kind === "incomplete") {
		if (ctx.cancelAttempted) {
			return state === "closing"
				? { row: "T3a", kind: "stay", state: "cancel_unproven", countAttempt: true }
				: {
						row: "T3b",
						kind: "stay",
						state: "cancel_unproven",
						countAttempt: true,
						alert: "the cancel of the subscription could not be confirmed twice",
					};
		}
		if (pay.kind === "awaiting" || pay.kind === "failed") {
			if (inv === "open" || inv === "uncollectible") return { row: "T3", kind: "act", act: { do: "void" } };
			if (inv === "void") return { row: "T3v", kind: "act", act: { do: "cancel" } };
		}
		if (pay.kind === "in_flight" || pay.kind === "capturable" || pay.kind === "succeeded") {
			return { row: "T4", kind: "stay", state };
		}
	}

	// T11r and T11: above every refund and release row. Re-read once; a second such read alerts.
	if (inv === "paid" && pay.kind !== "succeeded") {
		return ctx.reread
			? {
					row: "T11r",
					kind: "operator",
					detail: "the held invoice reads paid, but no PaymentIntent on it reads succeeded on two reads",
				}
			: { row: "T11r", kind: "reread" };
	}
	if (pay.kind === "unrecognised") {
		return ctx.reread
			? {
					row: "T11",
					kind: "operator",
					detail:
						"the held invoice has a payment that is not a PaymentIntent, or more payments than one page, on two reads",
				}
			: { row: "T11", kind: "reread" };
	}

	if (sub.kind === "ended") {
		// I3: a refund needs the subscription ended and a PaymentIntent on the held invoice succeeded, in
		// the same observation. `pis` is never empty here (`PayObservation`).
		if (pay.kind === "succeeded") return decideSucceeded(hold, pay.pis, ctx);
		if (state !== "refund_pending") {
			if (pay.kind === "in_flight") return { row: "T6", kind: "stay", state: "payment_in_flight" };
			if (pay.kind === "capturable") {
				return ctx.piCancelAttempted
					? { row: "T7", kind: "stay", state: "payment_in_flight" }
					: { row: "T7", kind: "act", act: { do: "cancel_pi", pi: pay.pi } };
			}
			// `awaiting` or `failed`: no PaymentIntent took money or is taking it.
			if (inv === "open" || inv === "uncollectible") {
				return ctx.voidFailed
					? { row: "T12", kind: "stay", state: "invoice_payable" }
					: { row: "T8", kind: "act", act: { do: "void" } };
			}
			if (inv === "draft") return { row: "T8d", kind: "act", act: { do: "delete_draft" } };
			// T9. `void` comes with a complete, recognised payment list (`observeHold`). `none` is the one
			// deliberate exception to that list (S5a's hand-off): Stripe no longer has the invoice, so no
			// payments were read and `pay = awaiting` is not a read. It is sound ONLY because an invoice
			// Stripe can delete is a draft, which was never finalised and so never payable. Nothing else
			// that leaves the payments unread or empty may release here.
			if (inv === "void" || inv === "none") {
				return {
					row: "T9",
					kind: "release",
					reason: sub.expired && !ctx.voided ? "expired_unpaid" : "voided_unpaid",
				};
			}
		}
	}

	const read = sub.kind === "live" || sub.kind === "other" ? sub.status : sub.kind;
	return {
		row: "T17",
		kind: "operator",
		detail: `no transition matches: hold ${state}, subscription ${read}, invoice ${inv}, payments ${pay.kind}`,
	};
}

/**
 * T5, T10, T10p, T10f, T13 and T14 (§3.3, §3.5): an ended subscription whose held invoice has succeeded
 * PaymentIntents. A refund is made only for a PaymentIntent whose refunds read `none` or `partial`, and
 * only for the amount no live refund covers.
 */
function decideSucceeded(
	hold: Pick<PaymentHoldRow, "state" | "refund_attempt">,
	pis: SucceededPayment[],
	ctx: CallContext,
): Decision {
	const uncovered = pis.filter((p) => p.refund.kind === "none" || p.refund.kind === "partial");
	if (uncovered.length === 0) {
		if (pis.every((p) => p.refund.kind === "done")) {
			return {
				row: "T10",
				kind: "release",
				reason: pis.some((p) => p.refund.byThisHold) ? "refunded" : "already_refunded",
			};
		}
		return { row: "T10p", kind: "stay", state: "refund_pending" };
	}
	const pi = uncovered[0]?.id;
	if (hold.state === "refund_pending") {
		return {
			row: "T10f",
			kind: "stay",
			state: "refund_due",
			alert: "a refund the hold issued no longer covers the payment (it failed or was canceled)",
		};
	}
	const spent = hold.refund_attempt >= REFUND_BUDGET;
	if (ctx.refundFailed && spent) {
		return {
			row: "T14",
			kind: "operator",
			detail: `the refund failed on all ${hold.refund_attempt} attempts`,
			pi,
		};
	}
	// A refund made in this call that the re-read does not show yet is not made again: the next call
	// reads the refunds first (§3.5).
	if (ctx.refundAttempted) return { row: "T13", kind: "stay", state: "refund_due" };
	if (spent) {
		return {
			row: "T14",
			kind: "operator",
			detail: `the refund budget of ${REFUND_BUDGET} attempts is spent`,
			pi,
		};
	}
	return { row: "T5", kind: "act", act: { do: "refund", pis: uncovered } };
}

/** How `advanceHold` ended. */
export type AdvanceOutcome =
	/** T18: the hold was already released; nothing was read or written. */
	| "inert"
	| "released"
	| "open"
	/** A state write matched no row: the version moved, the hold was released, or the store's lease fence failed. */
	| "stale"
	/** The lease fence before a Stripe write threw: no further write was made. */
	| "lease_lost";

/** What one `advanceHold` call did. */
export interface AdvanceResult {
	outcome: AdvanceOutcome;
	/** The latest row this call knows. */
	hold: PaymentHoldRow;
	/** Every row matched, in order. */
	rows: HoldRow[];
	/** The last successful observation, or null. */
	observation: HoldObservation | null;
	/** True only when an alert raised in this call reached a channel (I8). */
	alerted: boolean;
}

/** The message of whatever was thrown. */
function messageOf(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/** The ref a state write is prepared on. */
function refOf(hold: PaymentHoldRow): HoldRef {
	return { id: hold.id, version: hold.version };
}

/**
 * When a hold in `state` is next due (§3.1). `refund_due` waits the §3.5 backoff step for the attempts
 * consumed so far (the first step before any).
 */
function nextCheck(state: OpenPaymentHoldState, refundAttempt: number, now: Date): Date {
	const ms =
		state === "refund_due"
			? REFUND_BACKOFF_MS[Math.min(Math.max(refundAttempt, 1), REFUND_BACKOFF_MS.length) - 1]
			: NEXT_CHECK_MS[state];
	return new Date(now.getTime() + (ms ?? 5 * MINUTE));
}

/**
 * E1 `observe` (§3.2): advances one OPEN hold as far as the table allows, making up to 3 Stripe writes,
 * observing again after each. Every state write is the store's fenced compare-and-set; a write that
 * matches no row ends the call `stale`, and a lease fence that throws ends it `lease_lost`.
 */
export async function advanceHold(start: PaymentHoldRow, deps: HoldMachineDeps): Promise<AdvanceResult> {
	let hold = start;
	const rows: HoldRow[] = [];
	let observation: HoldObservation | null = null;
	let alerted = false;
	let lastError: string | null = null;
	const ctx = newCallContext();
	let acts = 0;

	/** Ends the call. */
	const done = (outcome: AdvanceOutcome): AdvanceResult => ({ outcome, hold, rows, observation, alerted });
	/** A state write; false when it matched no row. */
	const write = async (patch: HoldStatePatch): Promise<boolean> => {
		const row = await deps.store.write(refOf(hold), patch);
		if (!row) return false;
		hold = row;
		return true;
	};
	/** Raises the operator alert; remembers whether it reached a channel. */
	const raise = async (detail: string, paymentIntentId: string | null): Promise<boolean> => {
		const ok = await deps.alert({
			subscriptionId: hold.subscription_id,
			customerId: hold.customer_id,
			paymentIntentId,
			detail,
		});
		alerted ||= ok;
		return ok;
	};
	/** The lease fence before a Stripe write; false when the lease is lost. */
	const fenced = async (): Promise<boolean> => {
		try {
			await deps.fence();
			return true;
		} catch {
			return false;
		}
	};
	/**
	 * Re-reads the held invoice after a write to it: its status, `missing` when Stripe no longer has it,
	 * or null when it cannot be read.
	 */
	const rereadInvoice = async (): Promise<string | null> => {
		try {
			return (await deps.reader.invoices.retrieve(hold.invoice_id)).status;
		} catch (err) {
			return isResourceMissing(err) ? "missing" : null;
		}
	};

	/**
	 * Writes a row that keeps the hold open: the state, the observation, the schedule, and an alert
	 * raised at most once per state entry.
	 */
	const stay = async (
		decision: Extract<Decision, { kind: "stay" }>,
		obs: HoldObservation,
		observedAt: Date,
	): Promise<AdvanceResult> => {
		const sameEntry =
			hold.alerted_at !== null && hold.alerted_at >= hold.state_since && hold.state === decision.state;
		const ok = decision.alert !== undefined && !sameEntry ? await raise(decision.alert, null) : false;
		const pis = obs.pay.kind === "succeeded" ? obs.pay.pis : [];
		const wrote = await write({
			state: decision.state,
			lastPay: obs.pay.kind,
			observedAt,
			nextCheckAt: nextCheck(decision.state, hold.refund_attempt, observedAt),
			...(decision.countAttempt ? { attempts: hold.attempts + 1 } : {}),
			...(lastError !== null ? { lastError } : {}),
			...(ok ? { alertedAt: observedAt } : {}),
			// §3.1: every observation of `refund_pending` writes `refund_action_since`, kept from the first
			// observation that saw a refund in `requires_action`, and cleared when none is.
			...(decision.state === "refund_pending"
				? {
						refundActionSince: pis.some((p) => p.refund.actionRequired)
							? (hold.refund_action_since ?? observedAt)
							: null,
					}
				: {}),
		});
		return done(wrote ? "open" : "stale");
	};

	if (hold.state === "released") return done("inert"); // T18

	for (let reads = 0; reads < MAX_READS; reads++) {
		const observedAt = deps.now();
		try {
			observation = await observeHold(hold, deps.reader);
		} catch (err) {
			if (!(err instanceof HoldObservationError)) throw err;
			// I5: a failed observation moves nothing. It records the failure and reschedules.
			const ok = await write({
				attempts: hold.attempts + 1,
				lastError: err.message,
				nextCheckAt: nextCheck(hold.state, hold.refund_attempt, observedAt),
			});
			return done(ok ? "open" : "stale");
		}
		const obs = observation;
		const lastPay = obs.pay.kind;
		const decision = decide(hold, obs, ctx);
		rows.push(decision.row);

		if (decision.kind === "reread") {
			ctx.reread = true;
			continue;
		}

		if (decision.kind === "release") {
			const released = await deps.store.release(refOf(hold), {
				reason: decision.reason,
				observedAt,
				lastPay,
			});
			if (!released) return done("stale");
			hold = released.hold;
			return done("released");
		}

		if (decision.kind === "operator") {
			const pi =
				decision.pi ?? (obs.pay.kind === "in_flight" || obs.pay.kind === "capturable" ? obs.pay.pi : null);
			const ok = await raise(decision.detail, pi);
			const wrote = await write({
				state: "needs_operator",
				lastPay,
				observedAt,
				nextCheckAt: nextCheck("needs_operator", hold.refund_attempt, observedAt),
				...(ok ? { alertedAt: observedAt } : {}),
				...(lastError !== null ? { lastError } : {}),
			});
			return done(wrote ? "open" : "stale");
		}

		if (decision.kind === "stay") return stay(decision, obs, observedAt);

		// An act: a Stripe write, then observe again. Past the per-call budget, the hold is left due now.
		if (acts >= MAX_ACTS) {
			const wrote = await write({ lastPay, observedAt, nextCheckAt: observedAt });
			return done(wrote ? "open" : "stale");
		}
		acts += 1;
		const act = decision.act;

		if (act.do === "refund") {
			// T5. Enter `refund_due` first, so that from here on a crash leaves a hold that blocks and refunds.
			if (hold.state !== "refund_due") {
				const entered = await write({
					state: "refund_due",
					lastPay,
					observedAt,
					nextCheckAt: nextCheck("refund_due", hold.refund_attempt, observedAt),
				});
				if (!entered) return done("stale");
			}
			for (const p of act.pis) {
				// §3.5: reserve the attempt number BEFORE the call. No row, no refund.
				const reserved = await deps.store.reserveRefundAttempt(refOf(hold));
				if (!reserved) return done("stale");
				hold = reserved.hold;
				if (!(await fenced())) return done("lease_lost");
				ctx.refundAttempted = true;
				try {
					await deps.writer.refunds.create(
						{
							payment_intent: p.id,
							amount: p.refund.uncovered,
							metadata: { [HOLD_REFUND_METADATA_KEY]: hold.id },
						},
						{ idempotencyKey: `hold-refund-${p.id}-${reserved.attempt}` },
					);
				} catch (err) {
					// §5.1: the refunds are re-read next: `done` → T10, `pending` → T10p, else T13 / T14.
					ctx.refundFailed = true;
					lastError = `refunds.create: ${messageOf(err)}`;
					break;
				}
			}
			continue;
		}

		if (!(await fenced())) return done("lease_lost");

		if (act.do === "void") {
			try {
				await deps.writer.invoices.voidInvoice(hold.invoice_id);
			} catch (err) {
				lastError = `invoices.voidInvoice: ${messageOf(err)}`;
			}
			// §5.1: re-read once; only `void` counts as done.
			const after = await rereadInvoice();
			if (after === "void") {
				// T3 → T3v, or T8 → T9, in this call.
				if (decision.row === "T8") ctx.voided = true;
				continue;
			}
			if (decision.row === "T8") {
				// T12: no second void in this call. The payments are re-read: `succeeded` → T5, `in_flight`
				// → T6, otherwise `invoice_payable`.
				lastError ??= `the held invoice reads ${after ?? "unreadable"} after the void`;
				ctx.voidFailed = true;
				continue;
			}
			// T3a / T3b: no cancel without a proven void.
			lastError ??= `the held invoice reads ${after ?? "unreadable"} after the void`;
			const first = hold.state === "closing";
			rows.push(first ? "T3a" : "T3b");
			return stay(
				first
					? { row: "T3a", kind: "stay", state: "cancel_unproven", countAttempt: true }
					: {
							row: "T3b",
							kind: "stay",
							state: "cancel_unproven",
							countAttempt: true,
							alert: "the held invoice could not be voided twice, so the subscription was not cancelled",
						},
				obs,
				observedAt,
			);
		}

		if (act.do === "cancel") {
			// T3v: the held invoice was just read void.
			ctx.cancelAttempted = true;
			try {
				await deps.writer.subscriptions.cancel(hold.subscription_id, {
					cancellation_details: { comment: `alethia:checkout_closed:${hold.id}` },
				});
			} catch (err) {
				lastError = `subscriptions.cancel: ${messageOf(err)}`;
			}
			// §5.1: re-read; `ended` goes on (T9), otherwise `cancel_unproven`.
			continue;
		}

		if (act.do === "cancel_pi") {
			// T7: release the authorisation, then re-read; still `requires_capture` stays `payment_in_flight`.
			ctx.piCancelAttempted = true;
			try {
				await deps.writer.paymentIntents.cancel(act.pi);
			} catch (err) {
				lastError = `paymentIntents.cancel: ${messageOf(err)}`;
			}
			continue;
		}

		// T8d: delete the draft, then re-read. Gone is done, positive by its own act (§3.3); otherwise
		// `invoice_payable`.
		try {
			await deps.writer.invoices.del(hold.invoice_id);
		} catch (err) {
			lastError = `invoices.del: ${messageOf(err)}`;
		}
		if ((await rereadInvoice()) === "missing") {
			const released = await deps.store.release(refOf(hold), { reason: "deleted_draft", observedAt, lastPay });
			if (!released) return done("stale");
			hold = released.hold;
			return done("released");
		}
		const wrote = await write({
			state: "invoice_payable",
			lastPay,
			observedAt,
			nextCheckAt: nextCheck("invoice_payable", hold.refund_attempt, observedAt),
			...(lastError !== null ? { lastError } : {}),
		});
		return done(wrote ? "open" : "stale");
	}
	const wrote = await write({ nextCheckAt: deps.now() });
	return done(wrote ? "open" : "stale");
}

/** What E0's open means for the flow that raised it (T0, T0h, T0f). */
export type OpenDecision =
	/** T0: the hold is written in `closing`; the flow may void and cancel. */
	| { kind: "proceed"; hold: PaymentHoldRow }
	/**
	 * T0h: an open hold already names the subscription. Nothing is voided or cancelled. `hold` is that
	 * row only when it is this payer's; another payer's hold is never surfaced (S4's warning).
	 */
	| { kind: "refuse_held"; hold: PaymentHoldRow | null }
	/** T0f: no row was written. Nothing is voided or cancelled, and no block is promised. */
	| { kind: "refuse_unconfirmed" };

/**
 * Maps the store's `openHold` result to E0's rows (§3.3 T0, T0h, T0f). A thrown `openHold` is T0f
 * too, and is the caller's to catch.
 */
export function decideOpen(result: OpenHoldResult, payerKey: string): OpenDecision {
	if (result.kind === "opened") return { kind: "proceed", hold: result.hold };
	if (result.kind === "already_open") {
		return {
			kind: "refuse_held",
			hold: result.hold && result.hold.payer_key === payerKey ? result.hold : null,
		};
	}
	return { kind: "refuse_unconfirmed" };
}

/**
 * E2 `operator_release` (T16): reads the live observation for the operator to see, then releases the
 * hold with `release_reason = operator`, `released_by` and the note, by the store's compare-and-set on
 * `version`. The caller holds the payer's lease and emits the audit event only when `released` is set.
 * An observation that fails is reported, and does not stop a release a person decided on.
 */
export async function operatorRelease(
	hold: PaymentHoldRow,
	deps: Pick<HoldMachineDeps, "reader" | "store">,
	input: { operatorId: string; reason: string },
): Promise<{ observation: HoldObservation | { error: string }; released: PaymentHoldRow | null }> {
	if (input.reason.trim() === "") throw new Error("operatorRelease: a reason is required.");
	let observation: HoldObservation | { error: string };
	try {
		observation = await observeHold(hold, deps.reader);
	} catch (err) {
		observation = { error: messageOf(err) };
	}
	if (hold.state === "released") return { observation, released: null };
	const released = await deps.store.release(refOf(hold), {
		reason: "operator",
		releasedBy: input.operatorId,
		note: input.reason,
	});
	return { observation, released: released?.hold ?? null };
}
