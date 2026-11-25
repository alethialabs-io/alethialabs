// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The Postgres `BillingEventStore` behind `applyBillingEvent` (./apply.ts). Service role only:
// webhooks have no actor, and every write here is decided by apply.ts's rules first. Each method is
// one statement or one short transaction on the service pool — never the lock pool, which the
// webhook ledger's advisory lock already holds a connection of (lib/billing/webhook-events.ts).
// Proven against a real database in tests/integration/paddle-apply-event.test.ts.

import { and, eq, gt, isNull, lte, or } from "drizzle-orm";
import { getServiceDb } from "@/lib/db";
import { aiCreditGrant, organization, organizationBilling, paddleTransaction } from "@/lib/db/schema";
import { emitUsageHint } from "@/lib/realtime/usage-hint";
import type { BillingEventStore, BillingRowState } from "./apply";

/** The columns the guard reads, selected once. */
const rowColumns = {
	organizationId: organizationBilling.organizationId,
	billingProvider: organizationBilling.billingProvider,
	status: organizationBilling.status,
	aiSubscriptionStatus: organizationBilling.aiSubscriptionStatus,
	stripeSubscriptionId: organizationBilling.stripeSubscriptionId,
	aiStripeSubscriptionId: organizationBilling.aiStripeSubscriptionId,
	paddleSubscriptionId: organizationBilling.paddleSubscriptionId,
	paddleSubscriptionEventAt: organizationBilling.paddleSubscriptionEventAt,
	aiPaddleSubscriptionId: organizationBilling.aiPaddleSubscriptionId,
	aiPaddleSubscriptionEventAt: organizationBilling.aiPaddleSubscriptionEventAt,
};

/** The Postgres store. */
export const postgresBillingEventStore: BillingEventStore = {
	/** Whether the organization exists. */
	async orgExists(orgId) {
		const [row] = await getServiceDb()
			.select({ id: organization.id })
			.from(organization)
			.where(eq(organization.id, orgId))
			.limit(1);
		return row != null;
	},

	/** The org naming the Paddle subscription in its plan or AI slot. */
	async orgForSubscription(subscriptionId) {
		const [row] = await getServiceDb()
			.select({ organizationId: organizationBilling.organizationId })
			.from(organizationBilling)
			.where(
				or(
					eq(organizationBilling.paddleSubscriptionId, subscriptionId),
					eq(organizationBilling.aiPaddleSubscriptionId, subscriptionId),
				),
			)
			.limit(1);
		return row?.organizationId ?? null;
	},

	/** The org holding the Paddle business id. */
	async businessOwner(businessId) {
		const [row] = await getServiceDb()
			.select({ organizationId: organizationBilling.organizationId })
			.from(organizationBilling)
			.where(eq(organizationBilling.paddleBusinessId, businessId))
			.limit(1);
		return row?.organizationId ?? null;
	},

	/** Locks the org's row `FOR UPDATE` for `fn`, whose `write` inserts or updates it. */
	async withLockedRow(orgId, fn) {
		return getServiceDb().transaction(async (tx) => {
			const [found] = await tx
				.select(rowColumns)
				.from(organizationBilling)
				.where(eq(organizationBilling.organizationId, orgId))
				.limit(1)
				.for("update");
			const row: BillingRowState | null = found ?? null;
			return fn(row, async (patch) => {
				const now = new Date();
				if (row) {
					await tx
						.update(organizationBilling)
						.set({ ...patch, updatedAt: now })
						.where(eq(organizationBilling.organizationId, orgId));
				} else {
					await tx.insert(organizationBilling).values({ ...patch, organizationId: orgId, updatedAt: now });
				}
			});
		});
	},

	/** Upserts the mirror unless a newer event already wrote it (the `event_occurred_at` watermark). */
	async upsertTransaction(w) {
		const s = w.snapshot;
		const update = {
			paddleSubscriptionId: w.subscriptionId,
			paddleCustomerId: w.customerId,
			status: s.status,
			origin: s.origin,
			currency: s.total.currency,
			subtotalMinor: s.subtotal.minor,
			taxMinor: s.tax.minor,
			totalMinor: s.total.minor,
			invoiceNumber: s.invoiceNumber,
			billingPeriodStart: s.billingPeriodStart,
			billingPeriodEnd: s.billingPeriodEnd,
			billedAt: s.billedAt,
			customData: s.customData,
			eventOccurredAt: w.occurredAt,
			updatedAt: new Date(),
		};
		const values = { ...update, organizationId: w.organizationId, paddleTransactionId: w.transactionId };
		const written = await getServiceDb()
			.insert(paddleTransaction)
			.values(values)
			.onConflictDoUpdate({
				target: paddleTransaction.paddleTransactionId,
				set: update,
				// Same org only, and never older than what is stored.
				setWhere: and(
					eq(paddleTransaction.organizationId, w.organizationId),
					or(isNull(paddleTransaction.eventOccurredAt), lte(paddleTransaction.eventOccurredAt, w.occurredAt)),
				),
			})
			.returning({ id: paddleTransaction.id });
		return written.length > 0;
	},

	/** The mirrored transaction's org, total and custom data. */
	async getTransaction(transactionId) {
		const [row] = await getServiceDb()
			.select({
				organizationId: paddleTransaction.organizationId,
				totalMinor: paddleTransaction.totalMinor,
				customData: paddleTransaction.customData,
			})
			.from(paddleTransaction)
			.where(eq(paddleTransaction.paddleTransactionId, transactionId))
			.limit(1);
		return row ?? null;
	},

	/** Stamps or clears the refund / chargeback instants. */
	async markTransaction(transactionId, patch) {
		await getServiceDb()
			.update(paddleTransaction)
			.set({ ...patch, updatedAt: new Date() })
			.where(eq(paddleTransaction.paddleTransactionId, transactionId));
	},

	/** Inserts the pack grant once per transaction (`paddle_transaction_id` is unique). */
	async grantPackCredits(input) {
		const inserted = await getServiceDb()
			.insert(aiCreditGrant)
			.values({
				org_id: input.orgId,
				user_id: input.userId,
				credits: input.credits,
				paddle_transaction_id: input.transactionId,
			})
			.onConflictDoNothing({ target: aiCreditGrant.paddle_transaction_id })
			.returning({ id: aiCreditGrant.id });
		if (inserted.length > 0) emitUsageHint(input.orgId);
		return inserted.length > 0;
	},

	/**
	 * Zeroes the transaction's pack grant (the balance is Σ grants − Σ purchased usage, so a spent
	 * pack can leave it negative, which blocks further purchased use). Returns the credits removed.
	 */
	async reversePackCredits(transactionId) {
		const reversed = await getServiceDb().transaction(async (tx) => {
			const [grant] = await tx
				.select({ orgId: aiCreditGrant.org_id, credits: aiCreditGrant.credits })
				.from(aiCreditGrant)
				.where(and(eq(aiCreditGrant.paddle_transaction_id, transactionId), gt(aiCreditGrant.credits, 0)))
				.limit(1)
				.for("update");
			if (!grant) return null;
			await tx
				.update(aiCreditGrant)
				.set({ credits: 0 })
				.where(eq(aiCreditGrant.paddle_transaction_id, transactionId));
			return grant;
		});
		if (!reversed) return 0;
		if (reversed.orgId) emitUsageHint(reversed.orgId);
		return reversed.credits;
	},
};
