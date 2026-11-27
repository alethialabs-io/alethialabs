// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The status an invoice SHOWS on the Invoices list, for both of its sources. No server imports, so
// the filter bar (a client module) and the zod input read the same closed list the query writes.
//
// The Stripe-era `invoice` mirror stores only invoices money already moved on, so its closed
// `invoice_status` enum (paid / refunded / void) is enough for it. A Paddle invoice is different:
// Paddle bills a transaction BEFORE it is paid (`billed`), and a billed one whose payment has not
// arrived goes `past_due`. Reading those as "paid" tells the customer a bill is settled when it is
// owed, and dropping `past_due` hides exactly the invoice that needs their attention. So the
// displayed scale is the stored one plus two states only a Paddle invoice reaches: `open` (billed,
// not yet paid) and `overdue` (past due).

import type { InvoiceStatus } from "@/lib/db/schema/enums";
import type { PaddleTransaction, PaddleTransactionStatus } from "@/lib/db/schema/paddle-transaction";

/** Every status the Invoices list can show, in the filter bar's order. */
export const INVOICE_DISPLAY_STATUSES = ["open", "overdue", "paid", "refunded", "void"] as const;

/** One of {@link INVOICE_DISPLAY_STATUSES}. */
export type InvoiceDisplayStatus = (typeof INVOICE_DISPLAY_STATUSES)[number];

/** The statuses the Stripe-era `invoice` table can hold — its `invoice_status` enum's values. */
export const LOCAL_INVOICE_STATUSES = ["paid", "refunded", "void"] as const satisfies readonly InvoiceStatus[];

/** Narrows a displayed status to one the Stripe-era `invoice` table can hold. */
export function isLocalInvoiceStatus(status: InvoiceDisplayStatus): status is InvoiceStatus {
	return status === "paid" || status === "refunded" || status === "void";
}

/** Narrows any string (a facet value, a URL param) to a displayed invoice status. */
export function isInvoiceDisplayStatus(value: string): value is InvoiceDisplayStatus {
	return INVOICE_DISPLAY_STATUSES.some((s) => s === value);
}

/**
 * The Paddle transaction statuses that are invoices: every one Paddle has issued an invoice for.
 * `draft` and `ready` have none yet. `canceled` is listed only once it was billed (see
 * `paddleScope`), because a canceled checkout that never billed was never an invoice.
 */
export const PADDLE_INVOICE_STATUSES = [
	"billed",
	"past_due",
	"paid",
	"completed",
	"canceled",
] as const satisfies readonly PaddleTransactionStatus[];

/**
 * A mirrored Paddle invoice's displayed status. A recorded refund or chargeback wins (money went
 * back either way); otherwise Paddle's own status decides: `billed` is open (issued, not yet paid),
 * `past_due` is overdue, `paid` and `completed` are paid, and `canceled` is void. `draft` and
 * `ready` are never listed; they read as open so the function stays total. The SQL twin is
 * `PADDLE_STATUS_SQL` (lib/queries/billing.ts), which must answer the same for the same row.
 */
export function paddleInvoiceStatus(
	row: Pick<PaddleTransaction, "status" | "refundedAt" | "chargebackAt">,
): InvoiceDisplayStatus {
	if (row.refundedAt !== null || row.chargebackAt !== null) return "refunded";
	switch (row.status) {
		case "paid":
		case "completed":
			return "paid";
		case "past_due":
			return "overdue";
		case "canceled":
			return "void";
		case "billed":
		case "draft":
		case "ready":
			return "open";
	}
}
