// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Payment-method ordering + dunning failover. We own the card UX in-app (no Stripe
// Customer Portal), so we let an org designate BACKUP cards to fall back on when the
// primary (default) card is declined. Stripe has no native "backup card", so the ordering
// is stored in each card's own metadata (`alethia_backup_rank`) — no schema needed — and
// the failover is real: on a failed subscription invoice we retry paying it with each
// backup in rank order before handing off to dunning.

import type Stripe from "stripe";
import { getStripe } from "@/lib/billing/stripe";

/** Metadata key holding a card's backup rank (0-based; lower = tried first). */
export const BACKUP_RANK_KEY = "alethia_backup_rank";

/** Reads a payment method's backup rank from its metadata, or null when unranked. */
export function backupRankOf(pm: Stripe.PaymentMethod): number | null {
	const raw = pm.metadata?.[BACKUP_RANK_KEY];
	if (raw === undefined || raw === null || raw === "") return null;
	const n = Number(raw);
	return Number.isInteger(n) && n >= 0 ? n : null;
}

/** The Stripe customer id off a payment method (string ref or expanded), or null. */
function customerIdOf(pm: Stripe.PaymentMethod): string | null {
	const c = pm.customer;
	if (!c) return null;
	return typeof c === "string" ? c : c.id;
}

/**
 * Writes the backup ordering onto the given cards (rank = position in the list) and clears
 * the rank from every other card on the customer, so the ordering is a single source of
 * truth in Stripe metadata. Verifies each id belongs to the customer first.
 */
export async function setBackupOrder(
	customerId: string,
	orderedPmIds: string[],
): Promise<void> {
	const stripe = getStripe();
	const pms = await stripe.paymentMethods.list({
		customer: customerId,
		type: "card",
	});
	const owned = new Set(pms.data.map((pm) => pm.id));
	for (const id of orderedPmIds) {
		if (!owned.has(id)) throw new Error("Payment method not found.");
	}
	const ranked = new Map(orderedPmIds.map((id, i) => [id, i]));
	await Promise.all(
		pms.data.map((pm) => {
			const rank = ranked.get(pm.id);
			return stripe.paymentMethods.update(pm.id, {
				metadata: { [BACKUP_RANK_KEY]: rank === undefined ? "" : String(rank) },
			});
		}),
	);
}

/**
 * On a failed subscription invoice, retries paying it with each BACKUP card (in rank
 * order, skipping the card that just failed / the current default) before we fall back to
 * dunning. On success, promotes the working card to the customer's default so the next
 * renewal uses it. Returns the payment-method id that paid, or null if none did.
 */
export async function attemptBackupPayment(
	customerId: string,
	invoiceId: string,
	failedPmId: string | null,
): Promise<string | null> {
	const stripe = getStripe();
	const customer = await stripe.customers.retrieve(customerId);
	const defaultRef =
		"deleted" in customer
			? null
			: customer.invoice_settings.default_payment_method;
	const defaultId =
		typeof defaultRef === "string" ? defaultRef : (defaultRef?.id ?? null);

	const pms = await stripe.paymentMethods.list({
		customer: customerId,
		type: "card",
	});
	// Ranked backups only, ascending, excluding the card that just failed + the default.
	const backups = pms.data
		.map((pm) => ({ pm, rank: backupRankOf(pm) }))
		.filter(
			({ pm, rank }) =>
				rank !== null && pm.id !== failedPmId && pm.id !== defaultId,
		)
		.sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0));

	for (const { pm } of backups) {
		try {
			const paid = await stripe.invoices.pay(invoiceId, {
				payment_method: pm.id,
			});
			if (paid.status === "paid") {
				// Promote the working card so future renewals don't re-trip the same decline.
				await stripe.customers
					.update(customerId, {
						invoice_settings: { default_payment_method: pm.id },
					})
					.catch(() => {});
				return pm.id;
			}
		} catch {
			// This backup declined too — try the next one.
		}
	}
	return null;
}
