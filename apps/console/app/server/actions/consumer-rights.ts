"use server";

// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The statutory withdrawal right, and the ordinary cancellation it is NOT (#2372).
//
// These are two different things that both end a subscription, and conflating them is the mistake
// this file is arranged to prevent:
//
//   ORDINARY CANCELLATION — a contractual right. Access runs to the end of the paid period and
//   there is no refund, discretionary or otherwise. `cancelSubscription` in billing.ts does this.
//
//   STATUTORY WITHDRAWAL — a consumer's non-waivable right to withdraw from a distance contract
//   within 14 days (CRD arts. 9–14). Access ends AT ONCE and money comes back, in an amount the law
//   computes rather than the trader. It applies only to `consumer` orders, only inside the window,
//   and the proportion retained depends on two choices captured at purchase.
//
// Offering the second as if it were the first (or the first as if it were the second) is not a UX
// detail — one of them is money the consumer is owed.

import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import {
	WITHDRAWAL_PERIOD_DAYS,
	consumerLocaleFor,
	withdrawalOutcome,
} from "@repo/legal/commerce";
import { authorize, authorizeRead } from "@/lib/authz/guard";
import { getServiceDb } from "@/lib/db";
import { commerceOrder, type CommerceOrder } from "@/lib/db/schema";
import { deploymentMode, isStripeConfigured } from "@/lib/billing/config";
import { getStripe } from "@/lib/billing/stripe";
import { forgetSubscription } from "@/lib/billing/subscription-cache";
import { getOrgBilling } from "@/lib/billing/queries";
import { alertOperator } from "@/lib/billing/operator-alert";
import { formatMoney } from "@repo/format";
import { sendWithdrawalAcknowledgementEmail } from "@/lib/email/withdrawal-email";

// THE CLOCK IS READ HERE, NEVER RECEIVED. Every exported function in this file is a Server Action,
// and a Server Action's arguments are whatever the request carried. The instant that decides
// whether the window is still open, how many days were supplied, and when access ends is therefore
// taken from the server's own clock inside each action, and the time-taking logic lives in
// non-exported helpers that the actions call with `new Date()`.

/** Guards that billing is actually wired before any Stripe call. Mirrors billing.ts's own guard —
 *  a withdrawal that cannot refund must fail loudly rather than record a refund that never moved. */
function requireHostedBilling(): void {
	if (!isStripeConfigured()) {
		throw new Error(
			`Billing is not enabled on this deployment (${deploymentMode()} mode).`,
		);
	}
}

/** Days between two instants, floored — never negative. */
function daysBetween(from: Date, to: Date): number {
	const ms = to.getTime() - from.getTime();
	return ms <= 0 ? 0 : Math.floor(ms / 86_400_000);
}

/** What the console needs to show a consumer their withdrawal right honestly. */
export interface WithdrawalRight {
	/** False for an organization order, or when no order exists. */
	readonly available: boolean;
	/** Why it is unavailable — rendered instead of a silent absence. */
	readonly reason?: "not_a_consumer_order" | "period_expired" | "no_order" | "already_ended";
	readonly expiresAt?: string;
	/** What the consumer would get back today, in minor units, if they withdrew now. */
	readonly refundMinorUnits?: number;
	readonly retainedMinorUnits?: number;
	readonly currency?: string;
	/** The plain-language basis for that split. */
	readonly basis?: string;
}

/** The most recent order for the active org, or null. */
async function latestOrder(orgId: string): Promise<CommerceOrder | null> {
	const [row] = await getServiceDb()
		.select()
		.from(commerceOrder)
		.where(eq(commerceOrder.organizationId, orgId))
		.orderBy(desc(commerceOrder.placedAt))
		.limit(1);
	return row ?? null;
}

/**
 * The consumer's current withdrawal position, computed rather than stated.
 *
 * Shown BEFORE they act, because CRD art. 6 requires the consumer to be told what withdrawing will
 * cost them, and a figure produced only after the fact is not that. It runs the same
 * `withdrawalOutcome` the actual withdrawal runs, so the preview cannot disagree with the outcome.
 *
 * A READ, so it is gated by `authorizeRead`, never `authorize`. `manage_billing` is not one of the
 * actions `lib/authz/activity.ts` treats as read-only, so `authorize` would record an ALLOWED
 * "manage_billing" activity row every time the billing page mounts the withdrawal section — an
 * audit entry saying the admin managed billing when they only looked at it. That row is
 * fire-and-forget and lands late, which is how the destructive-action spec caught it: it fell
 * inside `billing.subscription.cancel`'s Cancel window. A denial is still recorded.
 */
export async function getWithdrawalRight(): Promise<WithdrawalRight> {
	const actor = await authorizeRead("manage_billing", { type: "billing" });
	return withdrawalRightAt(await latestOrder(actor.orgId), new Date());
}

/** {@link getWithdrawalRight}'s computation for `order` at the instant `now`. Not exported: `now`
 *  is always the server clock, supplied by the action. */
function withdrawalRightAt(order: CommerceOrder | null, now: Date): WithdrawalRight {
	if (!order) return { available: false, reason: "no_order" };
	if (order.capacity !== "consumer") {
		return { available: false, reason: "not_a_consumer_order" };
	}
	if (order.state === "withdrawn" || order.state === "refunded") {
		return { available: false, reason: "already_ended" };
	}
	const expiresAt =
		order.withdrawalPeriodEndsAt ??
		new Date(order.placedAt.getTime() + WITHDRAWAL_PERIOD_DAYS * 86_400_000);
	if (now > expiresAt) {
		return {
			available: false,
			reason: "period_expired",
			expiresAt: expiresAt.toISOString(),
		};
	}

	const outcome = withdrawalOutcome({
		paidMinorUnits: order.totalMinorUnits,
		periodDays: order.periodDays,
		daysSupplied: daysBetween(order.placedAt, now),
		performanceStart: order.performanceStart ?? "deferred",
		acknowledgedProportionalCharge: order.proportionalChargeAcknowledgedAt !== null,
	});
	return {
		available: true,
		expiresAt: expiresAt.toISOString(),
		refundMinorUnits: outcome.refundMinorUnits,
		retainedMinorUnits: outcome.retainedMinorUnits,
		currency: order.currency,
		basis: outcome.basis,
	};
}

const withdrawSchema = z.object({
	/** Free-text reason. Optional BY LAW — a consumer need give none, and requiring one would be an
	 *  obstacle to a right they cannot be made to justify. */
	reason: z.string().trim().max(2000).nullable().default(null),
});

export type WithdrawInput = z.input<typeof withdrawSchema>;

/** What a withdrawal computed, and whether the refund it computed was actually issued. */
export interface WithdrawalResult {
	/** What the consumer is owed back, in minor units, as `withdrawalOutcome` computed it. */
	readonly refundMinorUnits: number;
	readonly retainedMinorUnits: number;
	readonly currency: string;
	/**
	 * True when that refund was issued at Stripe, or when none was owed. False when an amount was
	 * owed but the order carries no payment to refund against — the order is withdrawn, the owed
	 * amount is NOT recorded as refunded, and it has to be settled outside this action.
	 */
	readonly refundIssued: boolean;
}

/**
 * Exercises the statutory withdrawal right.
 *
 * The order of operations is deliberate and is the whole safety property: compute → refund → record
 * → end access. Ending access first would leave a consumer cut off with a refund that might still
 * fail; recording first would claim a refund that had not happened.
 *
 * The amount is NOT a policy decision made here — `withdrawalOutcome` computes it from what was
 * captured at purchase, and this action's only job is to move that money and write down what it did.
 */
export async function withdrawFromContract(
	input: WithdrawInput = { reason: null },
): Promise<WithdrawalResult> {
	withdrawSchema.parse(input);
	const actor = await authorize("manage_billing", { type: "billing" });
	requireHostedBilling();
	return withdrawAt(await latestOrder(actor.orgId), new Date());
}

/** {@link withdrawFromContract}'s work for `order` at the instant `now`. Not exported: `now` is
 *  always the server clock, supplied by the action. */
async function withdrawAt(order: CommerceOrder | null, now: Date): Promise<WithdrawalResult> {
	if (!order) throw new Error("There is no order to withdraw from.");
	if (order.capacity !== "consumer") {
		throw new Error(
			"The statutory withdrawal right applies to consumer purchases. This order was placed on " +
				"behalf of an organization — cancel it instead, and access runs to the end of the paid period.",
		);
	}
	if (order.state === "withdrawn" || order.state === "refunded") {
		throw new Error("This order has already been withdrawn from.");
	}
	const expiresAt =
		order.withdrawalPeriodEndsAt ??
		new Date(order.placedAt.getTime() + WITHDRAWAL_PERIOD_DAYS * 86_400_000);
	if (now > expiresAt) {
		throw new Error(
			`The ${WITHDRAWAL_PERIOD_DAYS}-day withdrawal period for this order ended on ` +
				`${expiresAt.toISOString().slice(0, 10)}. You can still cancel, and access runs to the end ` +
				`of the paid period.`,
		);
	}

	// The acknowledgement quotes `basis`, so it is computed in the consumer's language: Bulgarian for
	// a Bulgarian billing country (ЗЗП art. 52a). The figures do not depend on the locale.
	const locale = consumerLocaleFor(order.billingCountry);
	const outcome = withdrawalOutcome(
		{
			paidMinorUnits: order.totalMinorUnits,
			periodDays: order.periodDays,
			daysSupplied: daysBetween(order.placedAt, now),
			performanceStart: order.performanceStart ?? "deferred",
			acknowledgedProportionalCharge: order.proportionalChargeAcknowledgedAt !== null,
		},
		locale,
	);

	const stripe = getStripe();
	// Refund BEFORE recording, so a recorded withdrawal always corresponds to money that actually
	// moved. A failure here throws and leaves the order untouched, which the consumer can retry.
	// With an amount owed but no payment intent on the order there is nothing to refund against:
	// the withdrawal still takes effect, but the record must not say money moved when it did not.
	const refundIssued = outcome.refundMinorUnits === 0 || order.stripePaymentIntentId !== null;
	if (outcome.refundMinorUnits > 0 && order.stripePaymentIntentId) {
		await stripe.refunds.create({
			payment_intent: order.stripePaymentIntentId,
			amount: outcome.refundMinorUnits,
			reason: "requested_by_customer",
			metadata: {
				organization_id: order.organizationId,
				commerce_order_id: order.id,
				basis: "statutory_withdrawal",
			},
		});
	}
	// Access ends AT ONCE on withdrawal — unlike cancellation, which runs to the period end. The
	// contract is treated as never having been concluded, so continuing to serve it would be
	// supplying under an agreement that no longer exists (and would keep metering usage).
	if (order.stripeSubscriptionId) {
		await stripe.subscriptions.cancel(order.stripeSubscriptionId);
		forgetSubscription(order.stripeSubscriptionId); // the plan card's cached read of it is now stale (lib/billing/subscription-cache.ts)
	}

	await getServiceDb()
		.update(commerceOrder)
		.set({
			state: "withdrawn",
			withdrawnAt: now,
			withdrawalRetainedMinorUnits: outcome.retainedMinorUnits,
			// Only what was actually refunded. Null — not the computed figure, and not 0, which would
			// read as "nothing was owed" — when an owed refund could not be issued.
			withdrawalRefundMinorUnits: refundIssued ? outcome.refundMinorUnits : null,
			accessEndsAt: now,
			updatedAt: now,
		})
		.where(eq(commerceOrder.id, order.id));

	// An owed refund that could not be issued here is money the consumer is owed and has not had. The
	// Consumer rights page promises "we contact you within 14 days to arrange it" (CRD art. 13: the
	// refund is due within 14 days of the withdrawal), and this alert is what puts that in front of a
	// person. `alertOperator` never throws.
	if (!refundIssued) {
		await alertOperator({
			title: "Withdrawal refund owed but not issued",
			subject: { type: "user", id: order.placedByUserId },
			summary:
				`The withdrawal from order ${order.id} is recorded, but the ` +
				`${formatMoney(outcome.refundMinorUnits, order.currency)} refund owed could not be issued ` +
				"automatically (the order carries no payment to refund against). Contact the consumer and " +
				"arrange the refund within 14 days of the withdrawal (CRD art. 13).",
		});
	}

	// The acknowledgement on a durable medium (CRD art. 11a, ЗЗП art. 52a), sent only once the
	// withdrawal is recorded so it never acknowledges one that did not take effect. It never throws:
	// the withdrawal has happened, and a failed send is logged for a hand send rather than reported
	// to the consumer as a failed withdrawal (lib/email/withdrawal-email.ts).
	await sendWithdrawalAcknowledgementEmail({
		orderId: order.id,
		placedByUserId: order.placedByUserId,
		withdrawnAt: now,
		refundMinorUnits: outcome.refundMinorUnits,
		retainedMinorUnits: outcome.retainedMinorUnits,
		currency: order.currency,
		refundIssued,
		basis: outcome.basis,
		locale,
	});

	return {
		refundMinorUnits: outcome.refundMinorUnits,
		retainedMinorUnits: outcome.retainedMinorUnits,
		currency: order.currency,
		refundIssued,
	};
}

/**
 * When access ends for an ordinary cancellation of `order` made at `now`: the end of the paid
 * period that is running, read from server-held records only.
 *
 * Preferred source is the org's billing row, which the Stripe webhooks keep current — but only
 * when it describes THIS order's subscription and its period end is still ahead. Otherwise the
 * order's own terms decide: the first boundary of its `periodDays` cycle, counted from `placedAt`,
 * that lies after `now`. Never earlier than `now`.
 */
function paidPeriodEnd(
	order: CommerceOrder,
	billingPeriodEnd: Date | null,
	now: Date,
): Date {
	if (billingPeriodEnd && billingPeriodEnd > now) return billingPeriodEnd;
	const periodMs = Math.max(1, order.periodDays) * 86_400_000;
	const elapsed = now.getTime() - order.placedAt.getTime();
	const periods = Math.max(1, Math.floor(elapsed / periodMs) + 1);
	const end = new Date(order.placedAt.getTime() + periods * periodMs);
	return end > now ? end : now;
}

/**
 * Records an ordinary cancellation against the order, alongside the Stripe-side
 * `cancelSubscription`.
 *
 * Kept separate from withdrawal in the DATA as well as in the code: `cancelled` and `withdrawn` are
 * different states with different money attached, and a single "ended" flag would make it impossible
 * to answer "was this consumer refunded what they were owed?" from the record.
 */
export async function recordOrdinaryCancellation(): Promise<void> {
	const actor = await authorize("manage_billing", { type: "billing" });
	const now = new Date();
	const order = await latestOrder(actor.orgId);
	if (!order || order.state === "withdrawn" || order.state === "cancelled") return;
	const billing = await getOrgBilling(actor.orgId);
	const sameSubscription =
		billing !== null &&
		order.stripeSubscriptionId !== null &&
		billing.stripeSubscriptionId === order.stripeSubscriptionId;
	const accessEndsAt = paidPeriodEnd(
		order,
		sameSubscription ? billing.currentPeriodEnd : null,
		now,
	);
	await getServiceDb()
		.update(commerceOrder)
		.set({
			state: "cancelled",
			cancelledAt: now,
			// Access to the END of the paid period, never the cancellation instant, and NO refund —
			// which is the honest bargain: the consumer keeps what they paid for.
			accessEndsAt,
			updatedAt: now,
		})
		.where(
			and(
				eq(commerceOrder.id, order.id),
				eq(commerceOrder.organizationId, actor.orgId),
			),
		);
}
