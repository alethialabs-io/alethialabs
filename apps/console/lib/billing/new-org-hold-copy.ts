// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// What the create-a-team purchase tells the customer about its earlier checkouts (ADR 0002 §5.5, S8).
//
// One message per SET: the purchase reads every payment hold of its user and every subscription its
// sweep kept, and each one present contributes its clause once. A clause is chosen by the hold's
// state AND by `last_pay`, the payment the last observation saw, so a hold whose bank debit is under
// way never reads "try again in a few minutes". Every clause is true for what was read (I8):
//   - "we have raised an alert" appears only when every `needs_operator` hold behind it alerted a
//     channel (`alerted_at` is written only when `alertPaymentNeedsSupport` returned true);
//   - "refunded" appears only for a hold released `refunded` or `already_refunded`, which the machine
//     writes only once every covering refund reads `succeeded`;
//   - "you won't be charged twice / again" appears nowhere (C32): nothing proves it.
//
// Holds in `refund_pending` do not block (Q10), and a refund released in the last 14 days is appended
// to every response (C26). When nothing blocks, those clauses travel as the `notice` of the purchase
// that mints (C56), so a customer who buys again is told of the two-charges window before paying.
//
// Pure: the purchase in app/server/actions/billing.ts reads the rows and this decides the words.

import { LEGAL_ENTITY } from "@repo/legal/entity";
import type { PaymentHoldRow } from "@/lib/db/schema";

const SUPPORT_EMAIL = LEGAL_ENTITY.supportEmail;

/** How long a released refund keeps its clause on every create-a-team response (§5.5). */
export const REFUND_NOTICE_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

/** The columns of a hold its clause is chosen from. */
export type HoldForCopy = Pick<PaymentHoldRow, "state" | "last_pay" | "alerted_at" | "release_reason" | "released_at">;

/**
 * What the sweep saw on a subscription it KEPT (did not close, because its first payment is not proven
 * unpaid): a payment `in_flight`, an authorisation (`capturable`), a payment that `succeeded`, or none
 * it could prove anything about (`unproven`: no payment, more than one page, or an unreadable one).
 */
export type KeptPayment = "in_flight" | "capturable" | "succeeded" | "unproven";

const UNDER_WAY =
	"An earlier checkout's payment is still being processed, so nothing new was started. A bank debit can take several business days; you can try again once it settles.";
const AUTHORISED =
	"An earlier checkout's payment was authorised but not completed, so nothing new was started. Your bank can show the authorisation for up to 7 days before it is released or completed; you can try again once it is.";
const JUST_THROUGH =
	"An earlier checkout's payment has just gone through and is being confirmed, so nothing new was started. Try again in a few minutes.";
/** A closing hold with no payment seen, or one whose clause is not this payer's to read (T0h). */
export const NOT_CONFIRMED_CLOSED =
	"We could not confirm an earlier checkout was closed, so nothing new was started. Try again in a few minutes.";
const KEPT_UNPROVEN =
	"An earlier checkout is still open and we could not confirm it is unpaid, so nothing new was started. Try again later; it closes on its own within a day.";
const INVOICE_PAYABLE =
	"We could not yet close an earlier checkout's invoice, so nothing new was started. Try again in a few minutes.";
const REFUND_DUE =
	"An earlier payment went through after that checkout was cancelled. Its refund has not gone through yet; nothing new can be started until it has.";
const REFUND_PENDING =
	"An earlier payment went through after that checkout was cancelled. We have issued its refund, and it is on its way back to you. If you buy again now and that refund fails, you may see both charges until we have refunded it again.";
const NEEDS_OPERATOR = `We could not settle an earlier checkout's payment automatically, so nothing new was started. Contact support at ${SUPPORT_EMAIL} with the time of the payment.`;
const ALERTED = " We have raised an alert.";
const REFUNDED = "An earlier payment was refunded in full; it can take 5–10 business days to reach you.";

/**
 * T0f (§3.3): the hold could not be written, so nothing was voided or cancelled. It promises no block:
 * nothing recorded this refusal.
 */
export const HOLD_NOT_RECORDED =
	"We could not record an earlier checkout before closing it, so it was left as it is and nothing new was started. Try again in a few minutes.";

/** §5.1: the live check's `subscriptions.list` failed, so the purchase did not mint on a read it did not make. */
export const LIVE_CHECK_FAILED =
	"We could not check your earlier checkouts just now, so nothing new was started. Try again in a few minutes.";

/** A paid create-a-team subscription whose setup this user cannot finish here (linked to someone else's team). */
export const PAID_SETUP_ELSEWHERE = `Your earlier payment went through, but it is linked to a team you are not an owner of, so it can't be finished here and nothing new was started. Contact support at ${SUPPORT_EMAIL} with the time of the payment.`;

/** The clause of the payment a closing hold, or a kept subscription, last saw. */
function paymentClause(pay: string | null): string {
	if (pay === "in_flight") return UNDER_WAY;
	if (pay === "capturable") return AUTHORISED;
	if (pay === "succeeded") return JUST_THROUGH;
	return NOT_CONFIRMED_CLOSED;
}

/**
 * The clause of one OPEN hold (§5.5), or null for a released one. `needs_operator` claims an alert
 * only when this hold's alert reached a channel.
 */
export function holdClause(hold: HoldForCopy): string | null {
	switch (hold.state) {
		case "closing":
		case "cancel_unproven":
			return paymentClause(hold.last_pay);
		case "payment_in_flight":
			return hold.last_pay === "capturable" ? AUTHORISED : UNDER_WAY;
		case "invoice_payable":
			return INVOICE_PAYABLE;
		case "refund_due":
			return REFUND_DUE;
		case "refund_pending":
			return REFUND_PENDING;
		case "needs_operator":
			return NEEDS_OPERATOR + (hold.alerted_at ? ALERTED : "");
		case "released":
			return null;
	}
}

/** Whether a hold blocks its payer's next mint (§3.1): every open state but `refund_pending` (Q10). */
function holdBlocks(hold: Pick<PaymentHoldRow, "state">): boolean {
	return hold.state !== "released" && hold.state !== "refund_pending";
}

/** A hold released as refunded within `REFUND_NOTICE_WINDOW_MS` of `now`. */
function refundedRecently(hold: HoldForCopy, now: Date): boolean {
	return (
		hold.state === "released" &&
		(hold.release_reason === "refunded" || hold.release_reason === "already_refunded") &&
		hold.released_at !== null &&
		now.getTime() - hold.released_at.getTime() <= REFUND_NOTICE_WINDOW_MS
	);
}

/** What the composer decided: the refusal when anything blocks, else the notice a mint carries (either may be null). */
export interface NewOrgHoldCopy {
	refusal: string | null;
	notice: string | null;
}

/**
 * THE COMPOSER (§5.5): one message for the set of `holds` (open or released) and `kept` subscriptions
 * this request saw. When any of them blocks, `refusal` carries every clause, the non-blocking ones
 * last; otherwise the non-blocking clauses (`refund_pending`, a refund released in the last 14 days)
 * are the `notice`. Each clause appears once.
 */
export function composeNewOrgHoldCopy(input: {
	holds: readonly HoldForCopy[];
	kept: readonly KeptPayment[];
	now: Date;
}): NewOrgHoldCopy {
	const blocking = new Set<string>();
	const passing = new Set<string>();
	// "We have raised an alert" only when EVERY needs_operator hold alerted (I8).
	const operator = input.holds.filter((h) => h.state === "needs_operator");
	for (const hold of input.holds) {
		if (hold.state === "needs_operator") continue;
		const clause = holdClause(hold);
		if (clause) (holdBlocks(hold) ? blocking : passing).add(clause);
	}
	if (operator.length > 0) blocking.add(NEEDS_OPERATOR + (operator.every((h) => h.alerted_at) ? ALERTED : ""));
	for (const pay of input.kept) blocking.add(pay === "unproven" ? KEPT_UNPROVEN : paymentClause(pay));
	if (input.holds.some((h) => refundedRecently(h, input.now))) passing.add(REFUNDED);

	if (blocking.size > 0) return { refusal: [...blocking, ...passing].join(" "), notice: null };
	return { refusal: null, notice: passing.size > 0 ? [...passing].join(" ") : null };
}
