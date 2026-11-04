// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The ONE "live subscription" set (ADR 0002 §2, "Live subscription"; ADR 0004 §2, "Live", which is
// defined as ADR 0002's set). Six billing paths used to write it out by hand (#6426). A copied set
// drifts, and once it drifts two paths disagree about whether a subscription is live, so every
// reader imports it from here. tests/lib/billing/subscription-status.test.ts pins the members and
// fails on a new hand-written copy anywhere in the console's source.
//
// What is NOT this set, on purpose, and keeps its own name where it is used:
// - PAID_SUBSCRIPTION_STATUSES (new-org-setup.ts): `active`, `trialing`, `past_due`, the statuses that
//   mean the charge went through. `unpaid` and `paused` still exist but are not paid.
// - the org-plan PAID set (org-plan-row.ts): `active`, `trialing`.
// - STORED_LIVE_STATUSES (org-plan-row.ts), LIVE_STATUSES (queries.ts) and LIVE_BILLING_STATUSES
//   (pending-org-setup.ts): these read OUR billing row's `billing_status`, not a Stripe status. `mapStatus` folds `unpaid` into
//   `past_due` and has no `paused`, so the row's live set is necessarily smaller.
// - `namesOtherLivePlan` (payment-holds/sweeper.ts): a row-status predicate that deliberately widens
//   "live" to `past_due` for the link's refusal only.
//
// Pure, with no server import: scripts/payment-holds.ts loads it before the server modules.

import type Stripe from "stripe";

/**
 * Stripe subscription statuses under which a subscription still exists and may bill. Not `incomplete`:
 * such a subscription is not live yet, though it can still be paid until Stripe ends it. Not `canceled`
 * or `incomplete_expired`: those are ended and never bill again.
 */
export const LIVE_SUBSCRIPTION_STATUSES = [
	"active",
	"trialing",
	"past_due",
	"unpaid",
	"paused",
] as const satisfies ReadonlyArray<Stripe.Subscription.Status>;

/** A Stripe subscription status that is live (ADR 0002 §2). */
export type LiveSubscriptionStatus = (typeof LIVE_SUBSCRIPTION_STATUSES)[number];

const LIVE: ReadonlySet<string> = new Set(LIVE_SUBSCRIPTION_STATUSES);

/** Whether a Stripe subscription status is live: the subscription still exists and may bill (ADR 0002 §2). */
export function isLiveSubscriptionStatus(status: string): status is LiveSubscriptionStatus {
	return LIVE.has(status);
}
