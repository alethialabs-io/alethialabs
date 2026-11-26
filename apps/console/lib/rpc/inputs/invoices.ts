// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The invoices list's read input, shared by the browser (which builds it) and the procedure
// (which resolves it). No server imports, so a client component may import it — the jobs input's
// arrangement (`./jobs.ts`).

import { presetRange } from "@repo/ui/range";
import type { InvoiceDisplayStatus } from "@/lib/billing/invoice-status";
import type { InvoiceListFilters } from "@/lib/billing/invoices";
import { JOBS_RANGE_PRESETS } from "@/lib/rpc/inputs/jobs";

/** The relative paid-date windows the read resolves: the shared quick-range preset ids. */
export const INVOICE_PAID_WITHIN = JOBS_RANGE_PRESETS;

/** A now-relative paid-date window, by its quick-range preset id (`@repo/ui/range`). */
export type InvoicePaidWithin = (typeof INVOICE_PAID_WITHIN)[number];

/** Optional filters for the invoices list (period range + status). */
export interface InvoiceListParams {
	status?: InvoiceDisplayStatus[];
	/**
	 * A relative window ("the last 30 days"), resolved against the clock at READ time (#6731). It
	 * travels as the preset, never as resolved bounds, so a shared link reopened next month shows
	 * next month's last 30 days, and the server's prefetch key equals the browser's. Wins over
	 * `paidFrom`/`paidTo`.
	 */
	paidWithin?: InvoicePaidWithin;
	/** An explicit window's ISO bounds (the date picker). */
	paidFrom?: string;
	paidTo?: string;
	limit?: number;
}

/** The reader's filters for one request: a relative window resolved to its lower bound at `now`. */
export function invoiceReaderFilters(
	params: InvoiceListParams,
	now: Date = new Date(),
): InvoiceListFilters {
	const { paidWithin, paidFrom, paidTo, ...rest } = params;
	if (paidWithin) return { ...rest, paidFrom: presetRange(paidWithin, now).from.toISOString() };
	return {
		...rest,
		...(paidFrom ? { paidFrom } : {}),
		...(paidTo ? { paidTo } : {}),
	};
}
