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
import { WITHDRAWAL_PERIOD_DAYS, withdrawalOutcome } from "@repo/legal/commerce";
import { authorize } from "@/lib/authz/guard";
import { getServiceDb } from "@/lib/db";
import { commerceOrder } from "@/lib/db/schema";
import { deploymentMode, isStripeConfigured } from "@/lib/billing/config";
import { getStripe } from "@/lib/billing/stripe";

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
async function latestOrder(orgId: string) {
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
 */
export async function getWithdrawalRight(now = new Date()): Promise<WithdrawalRight> {
	const actor = await authorize("manage_billing", { type: "billing" });
	const order = await latestOrder(actor.orgId);
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
	now = new Date(),
): Promise<{ refundMinorUnits: number; retainedMinorUnits: number; currency: string }> {
	withdrawSchema.parse(input);
	const actor = await authorize("manage_billing", { type: "billing" });
	requireHostedBilling();

	const order = await latestOrder(actor.orgId);
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

	const outcome = withdrawalOutcome({
		paidMinorUnits: order.totalMinorUnits,
		periodDays: order.periodDays,
		daysSupplied: daysBetween(order.placedAt, now),
		performanceStart: order.performanceStart ?? "deferred",
		acknowledgedProportionalCharge: order.proportionalChargeAcknowledgedAt !== null,
	});

	const stripe = getStripe();
	// Refund BEFORE recording, so a recorded withdrawal always corresponds to money that actually
	// moved. A failure here throws and leaves the order untouched, which the consumer can retry.
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
	}

	await getServiceDb()
		.update(commerceOrder)
		.set({
			state: "withdrawn",
			withdrawnAt: now,
			withdrawalRetainedMinorUnits: outcome.retainedMinorUnits,
			withdrawalRefundMinorUnits: outcome.refundMinorUnits,
			accessEndsAt: now,
			updatedAt: now,
		})
		.where(eq(commerceOrder.id, order.id));

	return {
		refundMinorUnits: outcome.refundMinorUnits,
		retainedMinorUnits: outcome.retainedMinorUnits,
		currency: order.currency,
	};
}

/**
 * Records an ordinary cancellation against the order, alongside the Stripe-side
 * `cancelSubscription`.
 *
 * Kept separate from withdrawal in the DATA as well as in the code: `cancelled` and `withdrawn` are
 * different states with different money attached, and a single "ended" flag would make it impossible
 * to answer "was this consumer refunded what they were owed?" from the record.
 */
export async function recordOrdinaryCancellation(
	accessEndsAt: Date,
	now = new Date(),
): Promise<void> {
	const actor = await authorize("manage_billing", { type: "billing" });
	const order = await latestOrder(actor.orgId);
	if (!order || order.state === "withdrawn" || order.state === "cancelled") return;
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
