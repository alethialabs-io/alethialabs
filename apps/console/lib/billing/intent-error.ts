// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { ActionError } from "@/lib/actions/result";

const BILLING_INTENT_FALLBACK =
	"Couldn't start the purchase. Billing may not be configured on this deployment — try again, or contact support if it persists.";

/** Returns a stable customer-facing sentence for an unexpected billing-intent rejection. */
export function billingIntentErrorMessage(error: unknown): string {
	console.error("[billing] intent creation failed", error);
	return BILLING_INTENT_FALLBACK;
}

/** Shown when the Paddle checkout overlay was closed before a payment completed. */
export const CHECKOUT_CLOSED_MESSAGE = "Checkout was closed before the payment went through. Nothing was charged.";

/**
 * The customer-facing sentence for a refused `startCheckout`: the server's own sentence for a refusal
 * it raised on purpose (the gate, the order, a plan already held), the generic one otherwise.
 */
export function checkoutErrorMessage(error: ActionError): string {
	switch (error.kind) {
		case "conflict":
		case "not-found":
		case "validation":
		case "forbidden":
		case "entitlement":
			return error.message;
		default:
			return billingIntentErrorMessage(error);
	}
}
