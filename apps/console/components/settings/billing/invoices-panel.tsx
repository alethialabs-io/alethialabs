"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The Invoices page body — the org's full mirrored-invoice history, on the console filter
// standard (lib/query/README.md → "Server-side filters"): a URL-synced zustand store →
// `normalizeInvoiceQuery` → the `billing.invoices` GET procedure (#6127), which filters by status
// and paid-date range SERVER-SIDE. The route prefetches the unfiltered universe AND the URL's
// filtered view with the same inputs, so the first paint carries rows and facet counts. Replaces the hand-rolled `useEffect` + `cancelled` flag the
// standard explicitly forbids ("TanStack owns request lifecycle") and the ad-hoc Reset button.
//
// The status facet's counts come from a second query on the BASE key — the unfiltered universe
// — because an option that disappears the moment you select it is unusable. There is no search
// box: `InvoiceListParams` has no `search`, and inventing a client-side one over a
// server-filtered list is the thing this standard exists to stop.

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { CircleDot } from "lucide-react";
import { useMemo, useState } from "react";
import { RegionError } from "@/components/errors/region-error";
import { RegionRefusal, refusalOf, retryUnlessRefused } from "@/components/settings/billing/read-state";
import { SettingsSection } from "@/components/settings/settings-ui";
import { useFilterUrlSync } from "@/hooks/use-filter-url-sync";
import { orpc } from "@/lib/rpc/client";
import type { InvoiceInfo } from "@/lib/rpc/procedures/billing";
import { countActiveFilters } from "@/lib/stores/create-filter-store";
import { useInvoiceFilters } from "@/lib/stores/use-settings-filters";
import { CountPill } from "@repo/ui/count-pill";
import { DateRangeFilter } from "@repo/ui/date-range-filter";
import { FacetFilter } from "@repo/ui/facet-filter";
import { FilterBar, FilterBarReset } from "@repo/ui/filter-bar";
import { QuickRangeFilter } from "@repo/ui/quick-range-filter";
import {
	type DateRange,
	DEFAULT_PRESET,
	formatRangeLabel,
	presetRange,
} from "@repo/ui/range";
import { Skeleton } from "@repo/ui/skeleton";
import { cn } from "@repo/ui/utils";
import {
	ALL_TIME_LABEL,
	DEFAULT_INVOICE_FILTERS,
	INVOICE_STATUS_OPTIONS,
	invoiceStatusCounts,
	normalizeInvoiceQuery,
} from "./invoices-filters";
import { InvoicePreviewDialog } from "./invoice-preview-dialog";
import { InvoicesTable } from "./invoices-table";

/** The Invoices page: the filter bar over the org's invoice history. */
export function InvoicesPanel() {
	// Filter state lives in the store; the URL mirrors it so a filtered view is shareable.
	const filters = useInvoiceFilters((s) => s.filters);
	const set = useInvoiceFilters((s) => s.set);
	const patch = useInvoiceFilters((s) => s.patch);
	const reset = useInvoiceFilters((s) => s.reset);
	const urlRead = useFilterUrlSync(useInvoiceFilters, DEFAULT_INVOICE_FILTERS);

	// The preview dialog (open state + selected invoice).
	const [selected, setSelected] = useState<InvoiceInfo | null>(null);
	const [previewOpen, setPreviewOpen] = useState(false);

	const query = useMemo(() => normalizeInvoiceQuery(filters), [filters]);
	const activeFilters = countActiveFilters(filters, DEFAULT_INVOICE_FILTERS);

	// The filtered rows. `keepPreviousData` holds the current page on screen while the next
	// one loads, and `isPlaceholderData` dims it — no skeleton flash on every facet click.
	const invoices = useQuery(
		orpc.billing.invoices.queryOptions({
			input: query,
			placeholderData: keepPreviousData,
			retry: retryUnlessRefused,
		}),
	);

	// The UNFILTERED universe, purely for the facet counts. Same key the page prefetches.
	const universe = useQuery(
		orpc.billing.invoices.queryOptions({ input: {}, staleTime: 60_000, retry: retryUnlessRefused }),
	);
	const refusal = invoices.isError ? refusalOf(invoices.error) : null;
	const counts = useMemo(
		() => invoiceStatusCounts(universe.data ?? []),
		[universe.data],
	);

	const rows = invoices.data ?? [];
	// The list is BUSY while what it shows may not answer the URL and the bar: before the link has
	// been read into the store, before the first answer, and while the rows are the previous
	// query's placeholder — the jobs, runners, members, alerts and activity lists' rule (#4980,
	// #5045, #5471), without the debounce term because this list has no search box. Before the
	// first answer the panel is a skeleton under a null count pill, which nothing else on screen
	// tells apart from a page that failed to render a list; `aria-busy` says which, for assistive
	// tech and for the audit's F8–F9 `settle()` (#5494).
	const busy = !urlRead || invoices.isPending || invoices.isPlaceholderData;

	// A null window means "no date constraint"; the pickers still need a concrete value to
	// render, so they fall back to the default preset without that becoming a filter.
	//
	// Resolved ONCE, as every other page carrying this filter bar does (activity-log.tsx:95,
	// usage-panel.tsx:95, jobs-client.tsx:103). Called in the render body it re-read the clock
	// on every paint, so the window the picker opened on was never the one the trigger had just
	// shown, and each render produced a new `to`.
	const [defaultRange] = useState<DateRange>(() => presetRange(DEFAULT_PRESET));
	const range: DateRange = useMemo(
		() =>
			filters.from && filters.to
				? { from: new Date(filters.from), to: new Date(filters.to) }
				: defaultRange,
		[filters.from, filters.to, defaultRange],
	);

	/** Apply a picked time window as the paid-date filter. */
	function applyRange(next: DateRange, label: string) {
		patch({
			from: next.from.toISOString(),
			to: next.to.toISOString(),
			rangeLabel: label,
		});
	}

	return (
		<SettingsSection
			title="Invoices"
			action={<CountPill count={invoices.isPending ? null : rows.length} />}
		>
			<div aria-busy={busy}>
				<FilterBar>
					<FacetFilter
						label="Status"
						icon={CircleDot}
						options={INVOICE_STATUS_OPTIONS.map((o) => ({
							value: o.value,
							label: o.label,
							hint: String(counts[o.value] ?? 0),
						}))}
						value={filters.statuses}
						onChange={(next) => set("statuses", next)}
						searchPlaceholder="Filter status…"
						emptyText="No statuses."
					/>
					<QuickRangeFilter
						label={filters.rangeLabel || ALL_TIME_LABEL}
						value={range}
						onChange={applyRange}
					/>
					<DateRangeFilter
						value={range}
						onChange={(r) => applyRange(r, formatRangeLabel(r))}
					/>
					<FilterBarReset count={activeFilters} onReset={reset} />
				</FilterBar>

				{refusal ? (
					<RegionRefusal refusal={refusal} />
				) : invoices.isError ? (
					// A fetch failure must not render as "no invoices yet" — that reads as a fact
					// about the account rather than about the request.
					<RegionError
						title="Couldn't load invoices"
						description="Something went wrong fetching your invoice history. Check your connection and try again."
						onRetry={() => void invoices.refetch()}
					/>
				) : invoices.isPending ? (
					<Skeleton className="h-56 w-full" />
				) : (
					<div className={cn(invoices.isPlaceholderData && "opacity-60")}>
						<InvoicesTable
							rows={rows}
							onPreview={(row) => {
								setSelected(row);
								setPreviewOpen(true);
							}}
							pageSize={20}
							emptyMessage={
								activeFilters > 0
									? "No invoices match these filters."
									: "No invoices yet — invoices appear here after your first payment."
							}
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
