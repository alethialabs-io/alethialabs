// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Whether a subscription's FIRST payment provably never happened (#5445) — the one question that
// decides whether an `incomplete` subscription may be cancelled and its record forgotten.
//
// A subscription's status cannot answer it. Stripe keeps a subscription `incomplete` while its first
// invoice's PaymentIntent is `processing`, and moves it to `active` only once that invoice settles — so
// `incomplete` also covers a payment that is in flight, or that succeeded a moment ago. Cancelling on
// the status alone could cancel a charge Stripe already took. The answer is read from the latest
// invoice's payments and their PaymentIntents instead.

import "server-only";
import type Stripe from "stripe";
import { getStripe } from "@/lib/billing/stripe";

/**
 * `never_paid`: no money moved and none can without the customer acting again — safe to cancel and
 * forget. `not_proven_unpaid`: anything else (a payment `processing`, `succeeded`, `requires_capture`,
 * an invoice payment that is `paid`, a payment that is not a PaymentIntent, or no payment to read on an
 * `incomplete` subscription) — never cancelled, never forgotten.
 */
export type FirstPayment = "never_paid" | "not_proven_unpaid";

/** PaymentIntent statuses under which nothing has been charged and nothing will be until the customer acts. */
const AWAITING_CUSTOMER: ReadonlySet<string> = new Set([
	"requires_payment_method",
	"requires_confirmation",
	"requires_action",
]);

/**
 * Reads the latest invoice's payments from Stripe and decides `FirstPayment` for `sub`:
 *   - `incomplete`: never paid only when the invoice has at least one payment, none of them `paid`, and
 *     every one is a PaymentIntent awaiting the customer (`requires_payment_method`,
 *     `requires_confirmation`, `requires_action`).
 *   - `incomplete_expired`: never paid when there is no payment at all, or every one is a PaymentIntent
 *     awaiting the customer or `canceled` (Stripe cancels it when the subscription expires) and none is
 *     `paid`.
 *   - any other status: not proven unpaid.
 * A failure to read Stripe is thrown, never read as "unpaid".
 */
export async function readFirstPayment(
	sub: Pick<Stripe.Subscription, "id" | "status" | "latest_invoice">,
): Promise<FirstPayment> {
	if (sub.status !== "incomplete" && sub.status !== "incomplete_expired") return "not_proven_unpaid";
	const invoiceId =
		typeof sub.latest_invoice === "string" ? sub.latest_invoice : (sub.latest_invoice?.id ?? null);
	if (!invoiceId) return sub.status === "incomplete_expired" ? "never_paid" : "not_proven_unpaid";

	const stripe = getStripe();
	const payments = await stripe.invoicePayments.list({
		invoice: invoiceId,
		limit: 100,
		expand: ["data.payment.payment_intent"],
	});
	if (payments.has_more) return "not_proven_unpaid";
	if (payments.data.length === 0) {
		return sub.status === "incomplete_expired" ? "never_paid" : "not_proven_unpaid";
	}
	const allowed =
		sub.status === "incomplete_expired"
			? new Set([...AWAITING_CUSTOMER, "canceled"])
			: AWAITING_CUSTOMER;
	for (const p of payments.data) {
		if (p.status === "paid") return "not_proven_unpaid";
		const intent = p.payment.payment_intent;
		if (p.payment.type !== "payment_intent" || !intent) return "not_proven_unpaid";
		const status =
			typeof intent === "string"
				? (await stripe.paymentIntents.retrieve(intent)).status
				: intent.status;
		if (!allowed.has(status)) return "not_proven_unpaid";
	}
	return "never_paid";
}
