// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// How the card-less trial ENDS (REL-L19, #6907).
//
// `startProTrial` creates the trial with `trial_settings.end_behavior.missing_payment_method:
// "cancel"`. When the trial runs out and no payment method was added, Stripe cancels the subscription
// and sends `customer.subscription.deleted`. The webhook applies that deletion through the same
// guarded sync as any other: a `canceled` subscription grants no plan, so the organization's row reads
// `community` — Hobby, with the Hobby limits that the plan readers apply — and nothing is deleted:
// the organization, its members, projects and configuration stay where they are.
//
// What this module adds is the one question the webhook cannot answer from the status alone: was this
// deletion the trial running out, or a customer cancelling? The two get different emails. "Your
// subscription was canceled" is false for a person who never subscribed; they are told their trial
// ended and what they kept.

import type Stripe from "stripe";

/**
 * How far apart the subscription's end and its trial's end may be and still read as the trial
 * running out. Stripe ends the subscription at the trial end, but the deletion is processed
 * asynchronously; an hour is far more than that and far less than any customer cancellation that
 * happened to land near the end.
 */
export const TRIAL_END_TOLERANCE_SECONDS = 3600;

/** The id of a subscription's own default payment method, or null. */
function defaultPaymentMethodId(sub: Stripe.Subscription): string | null {
	const ref = sub.default_payment_method;
	if (!ref) return null;
	return typeof ref === "string" ? ref : ref.id;
}

/**
 * Whether a deleted subscription is a card-less trial that ran out: it was set to cancel when no
 * payment method was present, it carries no payment method of its own, and it ended at its trial end.
 * A customer who cancelled mid-trial ended well before the trial end and is told about a cancellation.
 */
export function isCardlessTrialEnd(sub: Stripe.Subscription): boolean {
	if (sub.status !== "canceled") return false;
	if (sub.trial_settings?.end_behavior?.missing_payment_method !== "cancel") return false;
	if (defaultPaymentMethodId(sub) !== null) return false;
	const trialEnd = sub.trial_end;
	const endedAt = sub.ended_at ?? sub.canceled_at;
	if (!trialEnd || !endedAt) return false;
	return Math.abs(endedAt - trialEnd) <= TRIAL_END_TOLERANCE_SECONDS;
}
