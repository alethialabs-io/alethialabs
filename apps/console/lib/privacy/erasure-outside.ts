// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The half of an erasure outside Postgres, run by `performErasure` (erasure.ts) once the erasure
// has committed. Neither system can join the transaction, so each step is recorded in the case's
// ledger, and a failure of either is recorded rather than thrown — the rows are already gone, and
// reporting the erasure as failed would be the false record #4854 was about:
//
//   · OpenFGA: every tuple naming the account is removed (`removeUserTuples`). The account's grant
//     rows went in the transaction, so the next boot's backfill cannot write them back; a failed
//     removal is therefore also repaired by that backfill, and the ledger says so.
//   · Stripe: the personal organization's customer is deleted — unless an invoice or an order
//     still refers to it. Those are statutory accounting records the register retains (GDPR art.
//     17(3)(b)), and Stripe's customer object is what those invoices are issued to, so the customer
//     is KEPT with them and the ledger records why. Deleting a customer also cancels any
//     subscription it still holds.

import "server-only";
import { count, eq } from "drizzle-orm";
import { getTupleSync } from "@/lib/authz/tuple-sync";
import { isStripeConfigured } from "@/lib/billing/config";
import { getOrgBilling, upsertOrgBilling } from "@/lib/billing/queries";
import { getStripe } from "@/lib/billing/stripe";
import { getServiceDb } from "@/lib/db";
import { commerceOrder, invoice } from "@/lib/db/schema";
import { log } from "@/lib/observability/log";
import { recordEvent } from "@/app/server/actions/privacy/ledger";

const plog = log.child({ component: "privacy" });

/** What happened to the personal organization's Stripe customer. */
export type StripeCustomerOutcome =
	| { outcome: "none" }
	| { outcome: "deleted"; customerId: string }
	| { outcome: "retained"; customerId: string; invoices: number; orders: number }
	| { outcome: "not_configured"; customerId: string }
	| { outcome: "failed"; customerId: string };

/**
 * Deletes the Stripe customer of `personalOrgId`, unless a retained accounting record needs it.
 *
 * `userId` is the account whose orders are checked: `commerce_order` is keyed on the person who
 * placed it, `invoice` on the organization it was issued to. Either one keeps the customer.
 */
export async function deleteStripeCustomerIfUnretained(
	userId: string,
	personalOrgId: string,
): Promise<StripeCustomerOutcome> {
	const billing = await getOrgBilling(personalOrgId);
	const customerId = billing?.stripeCustomerId ?? null;
	if (!billing || !customerId) return { outcome: "none" };

	const db = getServiceDb();
	const [inv] = await db
		.select({ n: count() })
		.from(invoice)
		.where(eq(invoice.organizationId, personalOrgId));
	const [ord] = await db
		.select({ n: count() })
		.from(commerceOrder)
		.where(eq(commerceOrder.placedByUserId, userId));
	const invoices = inv?.n ?? 0;
	const orders = ord?.n ?? 0;
	if (invoices > 0 || orders > 0) {
		return { outcome: "retained", customerId, invoices, orders };
	}
	if (!isStripeConfigured()) return { outcome: "not_configured", customerId };

	try {
		await getStripe().customers.del(customerId);
	} catch (err) {
		plog.error("stripe customer delete failed during erasure", { err });
		return { outcome: "failed", customerId };
	}
	await upsertOrgBilling({
		organizationId: personalOrgId,
		plan: billing.plan,
		status: billing.status,
		stripeCustomerId: null,
		stripeSubscriptionId: billing.stripeSubscriptionId,
		seats: billing.seats,
		currentPeriodEnd: billing.currentPeriodEnd,
	});
	return { outcome: "deleted", customerId };
}

/** The ledger line for a Stripe outcome. Never names the customer id: the ledger outlives the erasure. */
export function describeStripeOutcome(r: StripeCustomerOutcome): string {
	switch (r.outcome) {
		case "none":
			return "Stripe: the account had no Stripe customer; nothing to delete.";
		case "deleted":
			return "Stripe: the personal organization's Stripe customer was deleted.";
		case "retained":
			return (
				"Stripe: the personal organization's Stripe customer was KEPT, because " +
				`${r.invoices} invoice(s) and ${r.orders} order(s) issued to it are statutory accounting ` +
				"records retained under GDPR art. 17(3)(b). It is deleted when they are."
			);
		case "not_configured":
			return (
				"Stripe: the account has a Stripe customer, but this deployment has no Stripe key, so it " +
				"was not deleted. It has to be deleted by hand in the Stripe dashboard."
			);
		case "failed":
			return (
				"Stripe: deleting the Stripe customer FAILED. It has to be deleted by hand in the Stripe " +
				"dashboard; the erasure itself is complete."
			);
	}
}

/**
 * Tells OpenFGA and Stripe, after the erasure committed, and records both on the case.
 *
 * `performErasure` is its only production caller.
 */
export async function eraseOutsidePostgres(
	caseId: string,
	userId: string,
	actorUserId: string | null,
): Promise<void> {
	let fga = "OpenFGA: every authorization tuple naming the account was removed.";
	try {
		await getTupleSync().removeUserTuples(userId);
	} catch (err) {
		plog.error("fga tuple removal failed during erasure", { err });
		fga =
			"OpenFGA: removing the account's authorization tuples FAILED. Its grant rows are erased, so " +
			"the next start-up backfill reconciles the store from Postgres without them.";
	}
	await recordEvent(caseId, "note", { summary: fga }, actorUserId);

	let stripe: StripeCustomerOutcome;
	try {
		stripe = await deleteStripeCustomerIfUnretained(userId, userId);
	} catch (err) {
		plog.error("stripe step failed during erasure", { err });
		stripe = { outcome: "failed", customerId: "" };
	}
	await recordEvent(
		caseId,
		stripe.outcome === "deleted" ? "vendor_notified" : "note",
		{ summary: describeStripeOutcome(stripe) },
		actorUserId,
	);
}
