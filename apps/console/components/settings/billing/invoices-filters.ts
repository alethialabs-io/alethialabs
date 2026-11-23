// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Pure filter plumbing for Settings · Billing › Invoices — the console filter standard's
// "normalize" step (lib/query/README.md → "Server-side filters"). `billing.invoices` filters
// server-side by status + paid-date range, so this produces the stable object that is both the
// procedure's input (and so its query key) and the reader's params. No "use client": the RSC
// page builds its prefetch input from this same function, so the two keys are one value.
//
// There is deliberately NO free-text search here: `InvoiceListParams` has no `search`, and the
// standard forbids inventing a client-side filter over a server-paged list. Adding one means
// adding it to the action first (see the follow-up on #2877).
//
// The paid-date choice is ONE `range` filter (lib/query/range-filter.ts, #6731). On this page its
// default ("") is ALL TIME, with no bound: invoices are rare, and someone opening their invoice
// history expects all of it.

import { parseRangeFilter } from "@/lib/query/range-filter";
import type { InvoiceListParams } from "@/lib/rpc/inputs/invoices";
import type { InvoiceInfo } from "@/lib/rpc/procedures/billing";

/** The invoices list's filter state (a type alias, for the store's `Record` constraint). */
export type InvoiceFilters = {
	statuses: string[];
	/** The paid-date choice (`lib/query/range-filter.ts`). "" = all time. */
	range: string;
};

/** Pristine filters — the store's defaults and the Reset target. All time, every status. */
export const DEFAULT_INVOICE_FILTERS: InvoiceFilters = {
	statuses: [],
	range: "",
};

/** The Billing page's Invoices section: the five newest, no filter. Shared with the route's prefetch. */
export const RECENT_INVOICES_INPUT: InvoiceListParams = { limit: 5 };

/** The label shown when no date window is set. */
export const ALL_TIME_LABEL = "All time";

/**
 * The most invoices one read returns: `listOrgInvoices`' default `limit` in `lib/billing/invoices.ts`
 * (the page never passes one). `invoices-filters.test.ts` reads that file and fails if the two part,
 * so the "showing the most recent N" note cannot go on naming a number the read no longer uses.
 */
export const INVOICE_LIST_CAP = 200;

/** The date picker's trigger label while there is no window to show. */
export const NO_WINDOW_LABEL = "Pick dates";

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
	const range = parseRangeFilter(filters.range);
	if (range.kind === "preset") query.paidWithin = range.preset;
	if (range.kind === "window") {
		query.paidFrom = range.from;
		query.paidTo = range.to;
	}
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
