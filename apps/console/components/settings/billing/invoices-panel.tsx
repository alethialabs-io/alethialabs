"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The Invoices page body — the org's full mirrored-invoice history, on the console filter
// standard (lib/query/README.md → "Server-side filters") and its paging standard ("Paging", #7493):
// a URL-synced zustand store → `normalizeInvoiceQuery` → `useKeysetList` over the `billing.invoices`
// GET procedure, which filters by status and paid-date range SERVER-SIDE and pages by keyset. The
// route prefetches the URL's first page with the same key, so the first paint carries rows and
// facet counts. Every invoice is reachable: the table renders each loaded page and the shared
// footer (scroll sentinel + "Load more") fetches the next — the list used to read up to 200 rows
// and page them in the browser, with a note apologising for the rest.
//
// The status facet's counts come from the FIRST page's facet pass, which the server counts over
// the org's unfiltered invoices — an option that disappears the moment you select it is unusable.
// There is no search box: `InvoiceListParams` has no `search`, and inventing a client-side one over
// a server-paged list is the thing this standard exists to stop. No count pill either: the console
// carries no list counts (README → "Counts").

import { CircleDot } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { DataTable } from "@/components/data-table";
import { RegionRefusal, refusalOf } from "@/components/settings/billing/read-state";
import { SettingsSection } from "@/components/settings/settings-ui";
import { useFilterUrlSync } from "@/hooks/use-filter-url-sync";
import { useKeysetList } from "@/lib/query/use-keyset-list";
import { orpc } from "@/lib/rpc/client";
import type { InvoiceInfo } from "@/lib/rpc/procedures/billing";
import { countActiveFilters } from "@/lib/stores/create-filter-store";
import { useInvoiceFilters } from "@/lib/stores/use-settings-filters";
import { DateRangeFilter } from "@repo/ui/date-range-filter";
import { FilterEmpty } from "@repo/ui/filter-bar";
import { ListToolbar } from "@repo/ui/list-toolbar";
import { QuickRangeFilter } from "@repo/ui/quick-range-filter";
import { type DateRange, DEFAULT_PRESET, presetRange } from "@repo/ui/range";
import { cn } from "@repo/ui/utils";
import {
	parseRangeFilter,
	rangeFilterLabel,
	rangeFromPick,
	rangeWindowValue,
} from "@/lib/query/range-filter";
import {
	ALL_TIME_LABEL,
	DEFAULT_INVOICE_FILTERS,
	INVOICE_STATUS_OPTIONS,
	invoiceStatusCounts,
	NO_WINDOW_LABEL,
	normalizeInvoiceQuery,
} from "./invoices-filters";
import { InvoicePreviewDialog } from "./invoice-preview-dialog";
import { useInvoiceColumns } from "./invoices-table";

/** The Invoices page: the filter bar over the org's invoice history. */
export function InvoicesPanel() {
	// Filter state lives in the store; the URL mirrors it so a filtered view is shareable.
	const filters = useInvoiceFilters((s) => s.filters);
	const set = useInvoiceFilters((s) => s.set);
	const reset = useInvoiceFilters((s) => s.reset);
	const urlRead = useFilterUrlSync(useInvoiceFilters, DEFAULT_INVOICE_FILTERS);

	// The preview dialog (open state + selected invoice).
	const [selected, setSelected] = useState<InvoiceInfo | null>(null);
	const [previewOpen, setPreviewOpen] = useState(false);
	const openPreview = useCallback((row: InvoiceInfo) => {
		setSelected(row);
		setPreviewOpen(true);
	}, []);
	const columns = useInvoiceColumns(openPreview);

	const query = useMemo(() => normalizeInvoiceQuery(filters), [filters]);
	const activeFilters = countActiveFilters(filters, DEFAULT_INVOICE_FILTERS);

	// The filtered list, one keyset page at a time. A filter change is a new key, so the walk
	// restarts at page one; `keepPreviousData` holds the old rows on screen (dimmed) meanwhile.
	const invoices = useKeysetList(orpc.billing.invoices, query);
	const refusal = invoices.query.isError ? refusalOf(invoices.query.error) : null;
	const counts = useMemo(() => invoiceStatusCounts(invoices.facets), [invoices.facets]);

	// The list is BUSY while what it shows may not answer the URL and the bar: before the link has
	// been read into the store, before the first answer, and while the rows are the previous
	// query's placeholder — the jobs, runners, members, alerts and activity lists' rule (#4980,
	// #5045, #5471), without the debounce term because this list has no search box. Before the
	// first answer the panel is placeholder rows, which nothing else on screen tells apart from a
	// page that failed to render a list; `aria-busy` says which, for assistive tech and for the
	// audit's F8–F9 `settle()` (#5494).
	const busy = !urlRead || invoices.isPending || invoices.isPlaceholderData;

	// The paid-date choice (#6731): all time (the default — no bound), a relative preset, or an
	// explicit window. Only an explicit window is a set of dates the pickers can show as such; a
	// preset shows the window it means right now, and all time shows none.
	const choice = useMemo(() => parseRangeFilter(filters.range), [filters.range]);
	// The pickers still need a concrete value to open on. Resolved ONCE, as every other page
	// carrying this filter bar does (activity-log.tsx, usage-panel.tsx, jobs-client.tsx): called in
	// the render body it re-read the clock on every paint, so each render produced a new `to`.
	const [now] = useState(() => new Date());
	const range: DateRange = useMemo(() => {
		if (choice.kind === "window") return { from: new Date(choice.from), to: new Date(choice.to) };
		return presetRange(choice.kind === "preset" ? choice.preset : DEFAULT_PRESET, now);
	}, [choice, now]);

	return (
		<SettingsSection title="Invoices">
			<div aria-busy={busy}>
				{/* No search (see the header): the row is the Status facet, then the paid-date range in
				    `extra` — its "All time" unbounded choice is this page's own variation. */}
				<ListToolbar
					facets={[
						{
							label: "Status",
							icon: CircleDot,
							options: INVOICE_STATUS_OPTIONS.map((o) => ({
								value: o.value,
								label: o.label,
								hint: String(counts[o.value] ?? 0),
							})),
							value: filters.statuses,
							onChange: (next: string[]) => set("statuses", next),
							searchPlaceholder: "Filter status…",
							emptyText: "No statuses.",
						},
					]}
					extra={
						<>
							<QuickRangeFilter
								label={rangeFilterLabel(choice, ALL_TIME_LABEL)}
								value={range}
								onChange={(r, label) => set("range", rangeFromPick(r, label))}
								unbounded={{ label: ALL_TIME_LABEL, onSelect: () => set("range", "") }}
							/>
							<DateRangeFilter
								value={range}
								onChange={(r) => set("range", rangeWindowValue(r))}
								emptyLabel={choice.kind === "default" ? NO_WINDOW_LABEL : undefined}
							/>
						</>
					}
					reset={{ count: activeFilters, onReset: reset }}
				/>

				{refusal ? (
					<RegionRefusal refusal={refusal} />
				) : invoices.universeEmpty === false && invoices.rows.length === 0 && !invoices.isPlaceholderData ? (
					// The org has invoices and none match: offer the way back (R6 F-25), as Activity
					// does. Decided by the server's `universeEmpty`, not by whether a filter is set.
					<FilterEmpty noun="invoices" onClear={reset} />
				) : (
					// Loading (placeholder rows), the first-run empty row, a failed first page (the
					// table's region error with a retry — never "no invoices yet", which reads as a
					// fact about the account), a failed refresh (rows + the stale notice) and a failed
					// later page (rows + the footer's retry line) are all the server-mode table's.
					<div className={cn(invoices.isPlaceholderData && "opacity-60")}>
						<DataTable
							columns={columns}
							keyset={invoices}
							onRowClick={openPreview}
							emptyMessage="No invoices yet — invoices appear here after your first payment."
						/>
					</div>
				)}
			</div>

			<InvoicePreviewDialog
				invoice={selected}
				open={previewOpen}
				onOpenChange={setPreviewOpen}
			/>
		</SettingsSection>
	);
}
