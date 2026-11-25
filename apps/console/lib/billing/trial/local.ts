// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The card-less Pro trial for an org whose sales go through a merchant of record (Paddle). No provider
// object is created: Paddle creates a subscription only after a payment, and a trial needs none. The
// trial is a LOCAL grant on the org's billing row — plan `team`, status `trialing`, the period set to
// the trial's 30 days, `billing_provider = paddle` so the org's later checkout routes to Paddle.
//
// It lapses on its own: a row with no plan subscription at any provider is an off-provider grant, and
// `isManualGrantExpired` (lib/billing/plan.ts) drops it to community once `current_period_end` has
// passed — the same rule an Enterprise contract grant obeys. A checkout completed during the trial
// replaces the grant (the webhook's one-slot rule lets a PAID subscription take a subscription-less
// grant's slot, lib/billing/events/apply.ts).
//
// Everything `startProTrial` checks before a Stripe trial — the purchase gate, the one-per-account
// ledger, the row predicate and the ceilings — is checked before this is called; this only writes.

import { eq } from "drizzle-orm";
import { releaseTrial, type TrialReservation } from "@/lib/billing/trial";
import { getServiceDb } from "@/lib/db";
import { organizationBilling, user } from "@/lib/db/schema";

/** How long the card-less trial lasts — the same 30 days as the Stripe trial. */
export const LOCAL_TRIAL_DAYS = 30;

/** The billing-row facts of a local trial started at `now`. */
export function localTrialGrant(now: Date): {
	plan: "team";
	status: "trialing";
	billingProvider: "paddle";
	currentPeriodStart: Date;
	currentPeriodEnd: Date;
	seats: null;
	cancelEffectiveAt: null;
} {
	return {
		plan: "team",
		status: "trialing",
		billingProvider: "paddle",
		currentPeriodStart: now,
		currentPeriodEnd: new Date(now.getTime() + LOCAL_TRIAL_DAYS * 24 * 60 * 60 * 1000),
		seats: null,
		cancelEffectiveAt: null,
	};
}

/**
 * Whether a billing row IS a local trial: trialing, Pro, and backed by no provider subscription. A
 * local trial does not block the org's own checkout (it is what the checkout converts).
 */
export function isLocalTrialRow(
	row: {
		status: string;
		plan: string;
		stripeSubscriptionId: string | null;
		paddleSubscriptionId: string | null;
	} | null,
): boolean {
	return (
		row !== null &&
		row.status === "trialing" &&
		row.plan === "team" &&
		row.stripeSubscriptionId === null &&
		row.paddleSubscriptionId === null
	);
}

/** Writes the local trial grant onto the org's billing row (inserting the row when there is none). */
async function grantLocalTrial(orgId: string, now: Date = new Date()): Promise<void> {
	const grant = localTrialGrant(now);
	await getServiceDb()
		.insert(organizationBilling)
		.values({ organizationId: orgId, ...grant })
		.onConflictDoUpdate({ target: organizationBilling.organizationId, set: { ...grant, updatedAt: now } });
}

/**
 * Starts the local trial: writes the grant, then burns the account's one trial — only after the grant
 * is written, so a failed write consumes nothing. The ceilings reserved for it are given back when the
 * grant cannot be written.
 */
export async function startLocalTrial(input: {
	orgId: string;
	userId: string;
	reservation: TrialReservation;
}): Promise<void> {
	try {
		await grantLocalTrial(input.orgId);
	} catch (err) {
		await releaseTrial(input.reservation);
		throw err;
	}
	await getServiceDb()
		.update(user)
		.set({ proTrialConsumedAt: new Date(), updatedAt: new Date() })
		.where(eq(user.id, input.userId));
}
