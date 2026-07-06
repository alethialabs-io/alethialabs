"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The Invoices page body — the org's full mirrored-invoice history with a filter bar
// (status facet + a time-range picker mapped to paidFrom/paidTo). Refetches server-side on
// every filter change, renders the shared InvoicesTable, an empty state, and a skeleton
// while loading, and owns the preview dialog. No TanStack Query here — this billing area uses
// the plain useEffect + useState pattern (matching billing-panel.tsx).

import { CircleDot, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
	type InvoiceInfo,
	listInvoices,
} from "@/app/server/actions/billing";
import { SettingsSection } from "@/components/settings/settings-ui";
import { Button } from "@repo/ui/button";
import { DateRangeFilter } from "@repo/ui/date-range-filter";
import { FacetFilter } from "@repo/ui/facet-filter";
import { QuickRangeFilter } from "@repo/ui/quick-range-filter";
import {
	type DateRange,
	DEFAULT_PRESET,
	formatRangeLabel,
	presetRange,
} from "@repo/ui/range";
import { Skeleton } from "@repo/ui/skeleton";
import { InvoicePreviewDialog } from "./invoice-preview-dialog";
import { InvoicesTable } from "./invoices-table";

/** The status facet options (grayscale — no domain color). */
const STATUS_OPTIONS = [
	{ value: "paid", label: "Paid" },
	{ value: "refunded", label: "Refunded" },
	{ value: "void", label: "Void" },
];

/** Type guard narrowing a facet string to a concrete InvoiceInfo status. */
function isInvoiceStatus(s: string): s is InvoiceInfo["status"] {
	return s === "paid" || s === "refunded" || s === "void";
}

export function InvoicesPanel() {
	const [rows, setRows] = useState<InvoiceInfo[] | null>(null);

	// Filters. A null range means "no date constraint" (show everything); the pickers still
	// need a concrete value to render, so they fall back to the default preset window.
	const [statuses, setStatuses] = useState<string[]>([]);
	const [range, setRange] = useState<DateRange | null>(null);
	const [rangeLabel, setRangeLabel] = useState("All time");

	// The preview dialog (open state + selected invoice).
	const [selected, setSelected] = useState<InvoiceInfo | null>(null);
	const [previewOpen, setPreviewOpen] = useState(false);

	const filtersActive = statuses.length > 0 || range !== null;

	// The server-action params the current filters describe.
	const filters = useMemo(
		() => ({
			status: statuses.filter(isInvoiceStatus),
			paidFrom: range?.from.toISOString(),
			paidTo: range?.to.toISOString(),
		}),
		[statuses, range],
	);

	// (Re)load whenever the filters change.
	useEffect(() => {
		let cancelled = false;
		setRows(null);
		listInvoices({
			status: filters.status.length ? filters.status : undefined,
			paidFrom: filters.paidFrom,
			paidTo: filters.paidTo,
		})
			.then((next) => {
				if (!cancelled) setRows(next);
			})
			.catch(() => {
				if (cancelled) return;
				setRows([]);
				toast.error("Couldn't load invoices.");
			});
		return () => {
			cancelled = true;
		};
	}, [filters]);

	/** Open the preview dialog for a row. */
	function openPreview(row: InvoiceInfo) {
		setSelected(row);
		setPreviewOpen(true);
	}

	/** Apply a picked time window as the paid-date filter. */
	function applyRange(next: DateRange, label: string) {
		setRange(next);
		setRangeLabel(label);
	}

	/** Clear every active filter. */
	function resetFilters() {
		setStatuses([]);
		setRange(null);
		setRangeLabel("All time");
	}

	const reset = filtersActive ? (
		<Button
			variant="ghost"
			size="sm"
			className="h-7 text-[12px] text-text-tertiary"
			onClick={resetFilters}
		>
			<X size={13} />
			Reset
		</Button>
	) : undefined;

	return (
		<SettingsSection title="Invoices" action={reset}>
			{/* filter bar */}
			<div className="mb-4 flex flex-wrap items-center gap-2.5">
				<FacetFilter
					label="Status"
					icon={CircleDot}
					options={STATUS_OPTIONS}
					value={statuses}
					onChange={setStatuses}
					searchPlaceholder="Filter status…"
					emptyText="No statuses."
				/>
				<QuickRangeFilter
					label={rangeLabel}
					value={range ?? presetRange(DEFAULT_PRESET)}
					onChange={applyRange}
				/>
				<DateRangeFilter
					value={range ?? presetRange(DEFAULT_PRESET)}
					onChange={(r) => applyRange(r, formatRangeLabel(r))}
				/>
			</div>

			{rows === null ? (
				<Skeleton className="h-56 w-full" />
			) : rows.length === 0 ? (
				<div className="rounded-lg border border-border bg-surface px-6 py-10 text-center text-[13px] text-text-tertiary">
					{filtersActive
						? "No invoices match these filters."
						: "No invoices yet — invoices appear here after your first payment."}
				</div>
			) : (
				<InvoicesTable rows={rows} onPreview={openPreview} pageSize={20} />
			)}

			<InvoicePreviewDialog
				invoice={selected}
				open={previewOpen}
				onOpenChange={setPreviewOpen}
			/>
		</SettingsSection>
	);
}
