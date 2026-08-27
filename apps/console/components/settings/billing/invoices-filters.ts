// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Pure filter plumbing for Settings · Billing › Invoices — the console filter standard's
// "normalize" step (lib/query/README.md → "Server-side filters"). `listInvoices` filters
// server-side by status + paid-date range, so this produces the stable object that is both the
// TanStack key and the action's params.
//
// There is deliberately NO free-text search here: `InvoiceListParams` has no `search`, and the
// standard forbids inventing a client-side filter over a server-paged list. Adding one means
// adding it to the action first (see the follow-up on #2877).

import type { InvoiceInfo, InvoiceListParams } from "@/app/server/actions/billing";

/** The invoices list's filter state (a type alias, for the store's `Record` constraint). */
export type InvoiceFilters = {
	statuses: string[];
	/** ISO paid-date bounds. Both empty = no date constraint ("All time"). */
	from: string;
	to: string;
	/** The label the range picker shows; carried so a shared link reproduces the trigger. */
	rangeLabel: string;
};

/** Pristine filters — the store's defaults and the Reset target. "All time", every status. */
export const DEFAULT_INVOICE_FILTERS: InvoiceFilters = {
	statuses: [],
	from: "",
	to: "",
	rangeLabel: "",
};

/** The label shown when no date window is set. */
export const ALL_TIME_LABEL = "All time";

/** The status facet's options (grayscale — no domain color). Mirrors `InvoiceInfo["status"]`. */
export const INVOICE_STATUS_OPTIONS = [
	{ value: "paid", label: "Paid" },
	{ value: "refunded", label: "Refunded" },
	{ value: "void", label: "Void" },
] as const;

/** Type guard narrowing a facet string to a concrete InvoiceInfo status. */
export function isInvoiceStatus(s: string): s is InvoiceInfo["status"] {
	return s === "paid" || s === "refunded" || s === "void";
}

/**
 * Normalize filter state into the stable query object placed in `qk.invoices` and passed to
 * `listInvoices`. Statuses are deduped and sorted — an unsorted array is a different key for
 * the same filter, which fragments the cache into entries that never hit.
 */
export function normalizeInvoiceQuery(
	filters: InvoiceFilters,
): InvoiceListParams {
	const query: InvoiceListParams = {};
	const statuses = [...new Set(filters.statuses)].filter(isInvoiceStatus).sort();
	if (statuses.length) query.status = statuses;
	if (filters.from) query.paidFrom = filters.from;
	if (filters.to) query.paidTo = filters.to;
	return query;
}

/**
 * Status facet counts over the UNFILTERED invoice universe, so an option cannot disappear as
 * you select it. `listInvoices` returns no facets, so `all` is the unfiltered list fetched
 * under the base key and counted here.
 */
export function invoiceStatusCounts(all: InvoiceInfo[]): Record<string, number> {
	const counts: Record<string, number> = { paid: 0, refunded: 0, void: 0 };
	for (const inv of all) counts[inv.status] = (counts[inv.status] ?? 0) + 1;
	return counts;
}
