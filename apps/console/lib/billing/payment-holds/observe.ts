// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The observation behind every payment-hold transition (ADR 0002 §3.2, E1 `observe`, S5 #5763).
//
// `observeHold` reads, in this order, the hold's subscription, its HELD invoice (never the
// subscription's `latest_invoice`, I2), that invoice's payments, and the refunds of every payment that
// succeeded, and classifies them as the tuple O = (sub, inv, pay, refund). The order narrows the race
// with a payment landing between two reads; it does not close it, which is why the machine re-reads
// (T11r).
//
// A read that throws is retried once (`readTwice`, §5.1). One that throws twice is an OBSERVATION
// FAILURE (`HoldObservationError`): it is never read as "gone", "void", "unpaid" or "refunded", and it
// never moves a hold (I5). The one error that IS an answer is Stripe's `resource_missing`: on the
// subscription it reads `missing` (T1), and on the held invoice `none` (a deleted draft).
//
// Stripe is injected as `HoldStripeReader`, the subset of the SDK client these reads use, so the
// machine is testable without a network and the live client (`getStripe()`) satisfies it as it is.

/** A PaymentIntent as the hold reads it. */
export interface HeldPaymentIntent {
	id: string;
	status: string;
	amount_received: number;
}

/** The read half of the Stripe client a hold observation uses (a structural subset of the SDK). */
export interface HoldStripeReader {
	subscriptions: { retrieve(id: string): Promise<{ status: string }> };
	invoices: { retrieve(id: string): Promise<{ status: string | null }> };
	invoicePayments: {
		list(params: { invoice: string; limit: number; expand: string[] }): Promise<{
			has_more: boolean;
			data: ReadonlyArray<{
				status: string;
				payment: { type: string; payment_intent?: string | HeldPaymentIntent | null };
			}>;
		}>;
	};
	paymentIntents: { retrieve(id: string): Promise<HeldPaymentIntent> };
	refunds: {
		list(params: { payment_intent: string; limit: number }): Promise<{
			has_more: boolean;
			data: ReadonlyArray<HeldRefund>;
		}>;
	};
}

/** A refund as the hold reads it. */
export interface HeldRefund {
	status: string | null;
	amount: number;
	metadata?: Record<string, string> | null;
}

/** `sub` (§3.2). `ended` is `canceled` or `incomplete_expired`; `other` is a status no row names (T17). */
export type SubObservation =
	| { kind: "incomplete" }
	| { kind: "ended"; expired: boolean }
	| { kind: "live"; status: string }
	| { kind: "missing" }
	| { kind: "other"; status: string };

/** `inv` (§3.2), for the held invoice. `none` is an invoice Stripe no longer has; `other` is unknown. */
export type InvoiceObservation = "open" | "uncollectible" | "draft" | "void" | "paid" | "none" | "other";

/**
 * `refund` (§3.2) for one succeeded PaymentIntent, from the refunds' own statuses — never from
 * `amount_refunded` (S9). A LIVE refund is `succeeded`, `pending` or `requires_action`.
 *   - `none`: no live refund;
 *   - `done`: `succeeded` refunds alone cover `amount_received`;
 *   - `pending`: live refunds cover it, and one is `pending` or `requires_action`;
 *   - `partial`: anything else.
 * `uncovered` is what no live refund covers. `byThisHold` is whether a succeeded refund carries this
 * hold's id (`released(refunded)` against `released(already_refunded)`, T10). `actionRequired` is
 * whether a refund reads `requires_action` (`refund_action_since`, §3.1).
 */
export interface RefundObservation {
	kind: "none" | "pending" | "done" | "partial";
	uncovered: number;
	byThisHold: boolean;
	actionRequired: boolean;
}

/** A PaymentIntent on the held invoice that `succeeded`, what it took, and what its refunds cover. */
export interface SucceededPayment {
	id: string;
	amountReceived: number;
	refund: RefundObservation;
}

/** `pay` (§3.2): what the held invoice's payments show. `succeeded` always carries at least one. */
export type PayObservation =
	| { kind: "awaiting" }
	| { kind: "failed" }
	| { kind: "in_flight"; pi: string }
	| { kind: "capturable"; pi: string }
	| { kind: "succeeded"; pis: SucceededPayment[] }
	| { kind: "unrecognised" };

/** The tuple O (§3.2). */
export interface HoldObservation {
	sub: SubObservation;
	inv: InvoiceObservation;
	pay: PayObservation;
}

/** A read that failed twice: an observation failure (§3.1, I5). Never an event. */
export class HoldObservationError extends Error {
	constructor(
		readonly read: string,
		readonly cause: unknown,
	) {
		super(
			`payment hold observation failed reading ${read}: ${cause instanceof Error ? cause.message : String(cause)}`,
		);
		this.name = "HoldObservationError";
	}
}

/** The metadata key a hold's refunds carry, naming the hold that created them (T10). */
export const HOLD_REFUND_METADATA_KEY = "alethia_payment_hold";

/** The PaymentIntent statuses under which nothing was charged and nothing will be until the customer acts. */
const AWAITING: ReadonlySet<string> = new Set([
	"requires_payment_method",
	"requires_confirmation",
	"requires_action",
]);

/** The subscription statuses that are live (§2): the subscription still exists and may bill. */
const LIVE: ReadonlySet<string> = new Set(["active", "trialing", "past_due", "unpaid", "paused"]);

/** Whether `err` is Stripe's `resource_missing` (the object does not exist in this account). */
export function isResourceMissing(err: unknown): boolean {
	return typeof err === "object" && err !== null && "code" in err && err.code === "resource_missing";
}

/**
 * Runs `read`, retrying once when it throws (§5.1). `resource_missing` is returned as `missing` rather
 * than thrown; any other second failure is a `HoldObservationError`.
 */
async function readTwice<T>(what: string, read: () => Promise<T>): Promise<T | "missing"> {
	try {
		return await read();
	} catch {
		try {
			return await read();
		} catch (err) {
			if (isResourceMissing(err)) return "missing";
			throw new HoldObservationError(what, err);
		}
	}
}

/** Classifies a subscription status as `sub`. */
function classifySub(status: string): SubObservation {
	if (status === "incomplete") return { kind: "incomplete" };
	if (status === "canceled" || status === "incomplete_expired") {
		return { kind: "ended", expired: status === "incomplete_expired" };
	}
	return LIVE.has(status) ? { kind: "live", status } : { kind: "other", status };
}

/** Classifies one succeeded PaymentIntent's refunds as `refund` (§3.2). */
function classifyRefunds(amountReceived: number, refunds: ReadonlyArray<HeldRefund>, holdId: string): RefundObservation {
	let succeeded = 0;
	let live = 0;
	let unsettled = false;
	let actionRequired = false;
	let byThisHold = false;
	for (const r of refunds) {
		if (r.status === "succeeded") {
			succeeded += r.amount;
			live += r.amount;
			if (r.metadata?.[HOLD_REFUND_METADATA_KEY] === holdId) byThisHold = true;
		} else if (r.status === "pending" || r.status === "requires_action") {
			live += r.amount;
			unsettled = true;
			if (r.status === "requires_action") actionRequired = true;
		}
	}
	const uncovered = Math.max(0, amountReceived - live);
	const kind =
		succeeded >= amountReceived
			? "done"
			: live === 0
				? "none"
				: live >= amountReceived && unsettled
					? "pending"
					: "partial";
	return { kind, uncovered, byThisHold, actionRequired };
}

/**
 * Reads and classifies the held invoice's payments (`pay`), with the refunds of each one that
 * succeeded. A payment that is not a PaymentIntent, and a list with `has_more`, are `unrecognised`.
 * When several PaymentIntents disagree, the one that can still move money wins: `in_flight`, then
 * `capturable`, then `succeeded`, then `failed` (a `canceled` one), then `awaiting`.
 */
async function observePayments(
	invoiceId: string,
	holdId: string,
	stripe: HoldStripeReader,
): Promise<PayObservation> {
	const payments = await readTwice("invoicePayments.list", () =>
		stripe.invoicePayments.list({ invoice: invoiceId, limit: 100, expand: ["data.payment.payment_intent"] }),
	);
	if (payments === "missing") throw new HoldObservationError("invoicePayments.list", "resource_missing");
	if (payments.has_more) return { kind: "unrecognised" };

	const intents: HeldPaymentIntent[] = [];
	for (const p of payments.data) {
		const intent = p.payment.payment_intent;
		if (p.payment.type !== "payment_intent" || !intent) return { kind: "unrecognised" };
		if (typeof intent !== "string") {
			intents.push(intent);
			continue;
		}
		const read = await readTwice("paymentIntents.retrieve", () => stripe.paymentIntents.retrieve(intent));
		if (read === "missing") return { kind: "unrecognised" };
		intents.push(read);
	}

	const inFlight = intents.find((i) => i.status === "processing");
	if (inFlight) return { kind: "in_flight", pi: inFlight.id };
	const capturable = intents.find((i) => i.status === "requires_capture");
	if (capturable) return { kind: "capturable", pi: capturable.id };
	if (intents.some((i) => i.status !== "succeeded" && i.status !== "canceled" && !AWAITING.has(i.status))) {
		return { kind: "unrecognised" };
	}

	// A PaymentIntent that reads `succeeded` but took nothing is not a shape any row names: no refund
	// can be made for it, and "fully refunded" would be read from the absence of any refund.
	if (intents.some((i) => i.status === "succeeded" && i.amount_received <= 0)) return { kind: "unrecognised" };

	const pis: SucceededPayment[] = [];
	for (const i of intents.filter((x) => x.status === "succeeded")) {
		const refunds = await readTwice("refunds.list", () =>
			stripe.refunds.list({ payment_intent: i.id, limit: 100 }),
		);
		// A refund list that does not fit one page, or a PaymentIntent Stripe cannot list refunds for,
		// proves nothing about what was refunded: an observation failure, never `none`.
		if (refunds === "missing") throw new HoldObservationError("refunds.list", "resource_missing");
		if (refunds.has_more) throw new HoldObservationError("refunds.list", "more refunds than one page");
		pis.push({
			id: i.id,
			amountReceived: i.amount_received,
			refund: classifyRefunds(i.amount_received, refunds.data, holdId),
		});
	}
	if (pis.length > 0) return { kind: "succeeded", pis };
	return intents.some((i) => i.status === "canceled") ? { kind: "failed" } : { kind: "awaiting" };
}

/**
 * E1's read (§3.2): the tuple O for `hold`, read subscription → held invoice → payments → refunds.
 * Throws `HoldObservationError` on a read that fails twice; never guesses.
 */
export async function observeHold(
	hold: { id: string; subscription_id: string; invoice_id: string },
	stripe: HoldStripeReader,
): Promise<HoldObservation> {
	const sub = await readTwice("subscriptions.retrieve", () =>
		stripe.subscriptions.retrieve(hold.subscription_id),
	);
	const invoice = await readTwice("invoices.retrieve", () => stripe.invoices.retrieve(hold.invoice_id));
	const inv = invoice === "missing" ? "none" : classifyInvoice(invoice.status);
	// Only a draft can be deleted, and a draft was never finalized, so never payable: an invoice Stripe
	// no longer has carries no payment. Every other invoice's payments are read.
	const pay: PayObservation =
		inv === "none" ? { kind: "awaiting" } : await observePayments(hold.invoice_id, hold.id, stripe);
	return { sub: sub === "missing" ? { kind: "missing" } : classifySub(sub.status), inv, pay };
}

/** Narrows an invoice status to `inv`; a status no row names (or none) is `other`. */
function classifyInvoice(status: string | null): InvoiceObservation {
	switch (status) {
		case "open":
		case "uncollectible":
		case "draft":
		case "void":
		case "paid":
			return status;
		default:
			return "other";
	}
}
