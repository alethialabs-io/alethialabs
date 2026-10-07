// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// What a paid create-a-team setup can truthfully say about its plan when the setup finishes (#5522).
//
// The sheet used to end every paid setup with "Subscription active — your organization is ready.",
// whatever Stripe said. But the post-payment steps run the moment `confirmCardPayment` resolves, and
// Stripe keeps the subscription `incomplete` until its first invoice settles (lib/billing/first-payment.ts).
// So the org was often still on the free plan when it was told it was active. A setup can also reach the
// end with a subscription that was closed before it was paid (the #5489 sweep from another tab, or
// Stripe's 23h expiry), or one whose payment still needs the customer's bank.
//
// The state is decided on the SERVER, from the subscription it just read and that subscription's first
// invoice's payments. The browser only renders it. This file is the pure half — the decision and the
// words — so the server action and the sheet share one vocabulary and a test can pin every state.

import type { StatusTier } from "@repo/ui/status-badge";

/** The seven things a finished paid setup can say about its plan. */
export const NEW_ORG_PLAN_STATES = [
	"active",
	"processing",
	"confirming",
	"unconfirmed",
	"action_needed",
	"not_charged",
	"not_active",
] as const;

/** One of `NEW_ORG_PLAN_STATES`. */
export type NewOrgPlanState = (typeof NEW_ORG_PLAN_STATES)[number];

/**
 * The states that can still change on their own within seconds — the first invoice settling, or a
 * payments read that failed now succeeding — so the sheet re-reads the server while one is shown.
 */
export const SETTLING_PLAN_STATES: ReadonlySet<NewOrgPlanState> = new Set([
	"processing",
	"confirming",
	"unconfirmed",
]);

/**
 * What the server reports about a finished paid setup's plan: the state, and — only for
 * `action_needed` — Stripe's hosted page for the open first invoice, where the customer can complete
 * the payment (Billing has nothing to finish it with). Null when there is no such page.
 */
export interface NewOrgPlanReport {
	planState: NewOrgPlanState;
	paymentUrl: string | null;
}

/**
 * What the first invoice's payments show, as the server read them (`readPaymentAfterCancel`):
 *   - `in_flight`: a PaymentIntent is `processing` or `requires_capture` — money may still move;
 *   - `succeeded`: a PaymentIntent took the money;
 *   - `none`: every PaymentIntent awaits the customer or was cancelled, or there is no payment at all;
 *   - `unrecognised`: a payment that is not a PaymentIntent, or more than one page of them.
 */
export type FirstPaymentRead = "in_flight" | "succeeded" | "none" | "unrecognised";

/** Subscription statuses whose plan state depends on the first invoice's payments. */
export const PAYMENT_DEPENDENT_STATUSES: ReadonlySet<string> = new Set([
	"incomplete",
	"canceled",
	"incomplete_expired",
]);

/**
 * Decides the plan state from the subscription's Stripe status and, for the statuses in
 * `PAYMENT_DEPENDENT_STATUSES`, its first invoice's payments. `payment` is null when they were not
 * read (or could not be): the answer is then the one that claims least.
 *
 * - `active` / `trialing` → `active`: the plan is live.
 * - `incomplete`: a payment that SUCCEEDED and only awaits the invoice settling → `processing`, the
 *   one state that may say the payment went through; a payment still IN FLIGHT (`processing`, or an
 *   authorisation awaiting capture), which can still fail → `confirming`, which claims nothing about
 *   the outcome; no payment taken and the customer must act (a declined card, or a bank
 *   confirmation) → `action_needed`; a payments read that failed or could not be understood →
 *   `unconfirmed`.
 * - `canceled` / `incomplete_expired`: no money moved → `not_charged`; anything else, or unread →
 *   `not_active`, which sends the customer to support rather than claiming they were not charged.
 * - `past_due` / `unpaid` → `action_needed`: the card on file has to be fixed for the plan to apply.
 * - anything else (`paused`, an unknown status) → `not_active`.
 */
export function newOrgPlanState(status: string, payment: FirstPaymentRead | null): NewOrgPlanState {
	switch (status) {
		case "active":
		case "trialing":
			return "active";
		case "past_due":
		case "unpaid":
			return "action_needed";
		case "incomplete":
			if (payment === "none") return "action_needed";
			if (payment === "succeeded") return "processing";
			if (payment === "in_flight") return "confirming";
			return "unconfirmed";
		case "canceled":
		case "incomplete_expired":
			return payment === "none" ? "not_charged" : "not_active";
		default:
			return "not_active";
	}
}

/** How one plan state is shown: the badge's label and tier, the sentence under it, and the toast. */
interface NewOrgPlanCopy {
	label: string;
	tier: StatusTier;
	sentence: string;
	toast: string;
}

/** The words for each plan state. Only `active` says the subscription is active. */
export const NEW_ORG_PLAN_COPY: Record<NewOrgPlanState, NewOrgPlanCopy> = {
	active: {
		label: "Active",
		tier: "active",
		sentence: "Your Pro plan is active.",
		toast: "Subscription active — your organization is ready.",
	},
	processing: {
		label: "Processing",
		tier: "pending",
		sentence:
			"Your payment went through. The Pro plan switches on in a moment, once Stripe finishes recording it — there is nothing more for you to do.",
		toast:
			"Your organization is ready. Its payment went through, and the Pro plan switches on in a moment.",
	},
	confirming: {
		label: "Confirming",
		tier: "pending",
		sentence:
			"Your payment is being confirmed. Your team is on the free plan until it is; the Pro plan switches on if it completes.",
		toast:
			"Your organization is ready. Its payment is being confirmed, and the Pro plan switches on if it completes.",
	},
	unconfirmed: {
		label: "Unconfirmed",
		tier: "pending",
		sentence:
			"We couldn't confirm the payment yet. Your team is on the free plan until we can; the Pro plan switches on once the payment is confirmed, and Billing will show it.",
		toast:
			"Your organization is ready, but we couldn't confirm its payment yet. The Pro plan switches on once it is confirmed.",
	},
	action_needed: {
		label: "Action needed",
		tier: "pending",
		sentence:
			"The payment did not complete — the card may have been declined, or your bank may need you to confirm it. Your team is on the free plan until it is paid.",
		toast:
			"Your organization is ready, but its payment did not complete, so the Pro plan is not on yet.",
	},
	not_charged: {
		label: "Not charged",
		tier: "idle",
		sentence:
			"The payment did not complete, so you were not charged. Your team is on the free plan; you can upgrade it from Billing.",
		toast:
			"Your organization is ready on the free plan. The payment did not complete, so you were not charged.",
	},
	not_active: {
		label: "Not active",
		tier: "failed",
		sentence:
			"The Pro plan is not active. If your card was charged, contact support with the time of the payment.",
		toast:
			"Your organization is ready, but its Pro plan is not active. If your card was charged, contact support with the time of the payment.",
	},
};

/**
 * The one thing an `action_needed` customer can do, said truthfully: complete the payment on Stripe's
 * hosted invoice page when the server returned one, otherwise contact support — Billing has no control
 * that finishes a first payment.
 */
export function actionNeededNextStep(paymentUrl: string | null): string {
	return paymentUrl
		? "Complete the payment on Stripe's secure payment page — you can confirm it or use another card there."
		: "Contact support with the time of the payment to complete it.";
}
