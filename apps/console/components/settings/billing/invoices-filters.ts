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
// THE DATE CHOICE IS ONE FILTER, IN ONE PARAM (#6731). It used to be three — absolute `from` and
// `to` plus a relative `rangeLabel` — so picking "Last 14 days" wrote a frozen window under a
// relative name (a link opened next month still said "Last 14 days" over this month's dates), and
// one choice counted as 3 on "Reset · N". `range` is now exactly one of:
//
//   ""             all time — no bound. The default: invoices are rare, and the first thing a
//                  person opening their invoice history expects is all of it.
//   a preset id    "30d" — relative, and it STAYS relative: the server resolves it at read time.
//   "<from>/<to>"  an explicit window from the date picker (ISO 8601 interval notation).

import {
	type InvoiceListParams,
	type InvoicePaidWithin,
	isInvoicePaidWithin,
} from "@/lib/rpc/inputs/invoices";
import type { InvoiceInfo } from "@/lib/rpc/procedures/billing";
import { type DateRange, RANGE_PRESETS } from "@repo/ui/range";

/** The invoices list's filter state (a type alias, for the store's `Record` constraint). */
export type InvoiceFilters = {
	statuses: string[];
	/** The paid-date choice, encoded as described in this file's header. "" = all time. */
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

/** The quick-range trigger's label while an explicit window is set (the date picker shows it). */
export const CUSTOM_RANGE_LABEL = "Custom range";

/** The date picker's trigger label while there is no window to show. */
export const NO_WINDOW_LABEL = "Pick dates";

/** The decoded paid-date choice. */
export type InvoiceRange =
	| { kind: "all" }
	| { kind: "preset"; preset: InvoicePaidWithin }
	| { kind: "window"; from: string; to: string };

/** Separates an explicit window's two bounds in the `range` param (ISO 8601 interval). */
const WINDOW_SEPARATOR = "/";

/** An ISO instant normalized to `toISOString()`, or null when the text is not a date. */
function isoInstant(text: string): string | null {
	const ms = Date.parse(text);
	return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

/**
 * Decode the `range` filter. Anything unrecognised — a hand-edited link, an old three-param one —
 * decodes as all time, the default, rather than as a window nobody chose.
 */
export function parseInvoiceRange(value: string): InvoiceRange {
	if (value === "") return { kind: "all" };
	if (isInvoicePaidWithin(value)) return { kind: "preset", preset: value };
	const parts = value.split(WINDOW_SEPARATOR);
	if (parts.length !== 2) return { kind: "all" };
	const from = isoInstant(parts[0] ?? "");
	const to = isoInstant(parts[1] ?? "");
	if (from === null || to === null) return { kind: "all" };
	return from <= to ? { kind: "window", from, to } : { kind: "window", from: to, to: from };
}

/** Encode an explicit window as the `range` filter. */
export function invoiceWindowValue(window: DateRange): string {
	return `${window.from.toISOString()}${WINDOW_SEPARATOR}${window.to.toISOString()}`;
}

/**
 * The `range` value for a quick-range pick. A preset stays its id, so it round-trips as relative;
 * anything typed ("10d", "yesterday") resolves now to an explicit window, which is what it is.
 */
export function invoiceRangeFromPick(window: DateRange, label: string): string {
	const preset = RANGE_PRESETS.find((p) => p.label === label)?.id;
	return preset !== undefined && isInvoicePaidWithin(preset) ? preset : invoiceWindowValue(window);
}

/** What the quick-range trigger says for a choice: never a relative name over a fixed window. */
export function invoiceRangeLabel(range: InvoiceRange): string {
	switch (range.kind) {
		case "all":
			return ALL_TIME_LABEL;
		case "preset":
			return RANGE_PRESETS.find((p) => p.id === range.preset)?.label ?? CUSTOM_RANGE_LABEL;
		case "window":
			return CUSTOM_RANGE_LABEL;
	}
}

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
	const range = parseInvoiceRange(filters.range);
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
