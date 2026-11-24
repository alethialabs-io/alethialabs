"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Invoices table (Billing) — a presentational DataTable of the org's mirrored invoices with
// number, paid date, billing period, status, total, and per-row actions (Preview + a
// download of our stored фактура PDF). Read-only; the parent owns the data + the preview dialog.
// Server mode only (lib/query/README.md → "Paging", #7493): the Invoices page renders these columns
// over its keyset list, and the preview over the five rows it holds; neither pages in the browser.
// The PDF/download hrefs are built from the org slug (route segment `[org]`).
//
// A row whose фактура is not issued yet says "Being issued" in place of its number and offers no
// download (EA-7c, #7341): Stripe's hosted invoice and Stripe's PDF are never the customer's
// invoice, so there is nothing to link to until ours exists.

import type { ColumnDef } from "@tanstack/react-table";
import { Download, Eye } from "lucide-react";
import { useParams } from "next/navigation";
import { useMemo } from "react";
import { DataTable } from "@/components/data-table";
import { ClockText } from "@/components/settings/usage/clock-text";
import type { KeysetList } from "@/lib/query/use-keyset-list";
import type { InvoiceInfo } from "@/lib/rpc/procedures/billing";
import { formatDate, formatMoney } from "@repo/format";
import { StatusBadge, type StatusTier } from "@repo/ui/status-badge";

// An invoice status is not one of the product statuses `statusTier()` knows — "paid",
// "refunded" and "void" would all fall through to `idle` — so the tier is stated here and
// the SHARED badge renders it, in place of the file-local pill this used to hand-roll.
const INVOICE_STATUS: Record<InvoiceInfo["status"], { tier: StatusTier; label: string }> = {
	paid: { tier: "active", label: "Paid" },
	refunded: { tier: "pending", label: "Refunded" },
	void: { tier: "failed", label: "Void" },
};

/** A grayscale status pill for an invoice. */
export function InvoiceStatusBadge({ status }: { status: InvoiceInfo["status"] }) {
	const s = INVOICE_STATUS[status];
	return <StatusBadge status={status} tier={s.tier} label={s.label} />;
}

/**
 * The billing period an invoice covers ("1 Jun 2026 – 1 Jul 2026"), falling back to the
 * paid month when the period isn't known. Both halves render through the shared
 * `formatDate`, so the period can no longer disagree with the "Paid" column beside it.
 */
export function formatBillingPeriod(invoice: InvoiceInfo): string {
	if (invoice.periodStart && invoice.periodEnd) {
		return `${formatDate(invoice.periodStart)} – ${formatDate(invoice.periodEnd)}`;
	}
	return formatDate(invoice.paidAt, "month");
}

/** What a row or the preview dialog says in place of a фактура that is not issued yet. */
export const INVOICE_BEING_ISSUED = "Being issued";

/** Builds the inline-preview / download href for an invoice's PDF route. */
export function invoicePdfHref(org: string, id: string, download = false): string {
	const base = `/${org}/~/settings/billing/invoices/${id}/pdf`;
	return download ? `${base}?download=1` : base;
}

/**
 * The rows a caller holds WHOLE, as a finished list: every row shown, no further page, nothing
 * loading or failed (the caller renders those states itself before it has rows). The Billing page's
 * five-row preview is the one such caller — its "View all invoices" link, not a footer, is the way
 * to the rest. A table never pages these rows in the browser.
 */
function wholeList(rows: InvoiceInfo[]): KeysetList<InvoiceInfo> {
	return {
		rows,
		facets: null,
		universeEmpty: null,
		query: { isLoading: false, isError: false, data: rows, error: null, refetch: () => undefined },
		isPending: false,
		isPlaceholderData: false,
		hasMore: false,
		loadingMore: false,
		loadMoreFailed: false,
		loadMore: () => undefined,
	};
}

/**
 * The invoices columns: number, paid date, billing period, status, total, and per-row actions.
 * `onPreview` opens the preview dialog. Shared by the Invoices page (which renders them in its own
 * server-mode `DataTable` over a keyset list) and {@link InvoicesTable} (the preview).
 */
export function useInvoiceColumns(onPreview: (row: InvoiceInfo) => void): ColumnDef<InvoiceInfo>[] {
	const { org } = useParams<{ org: string }>();

	return useMemo<ColumnDef<InvoiceInfo>[]>(
		() => [
			{
				accessorKey: "number",
				header: "Invoice",
				cell: ({ row }) =>
					row.original.facturaIssued ? (
						<span className="font-mono text-xs text-foreground">
							{row.original.number ?? "—"}
						</span>
					) : (
						<span className="text-xs text-muted-foreground">{INVOICE_BEING_ISSUED}</span>
					),
			},
			{
				accessorKey: "paidAt",
				header: "Paid",
				cell: ({ row }) => (
					// A date in the VIEWER's zone, rendered after hydration (this table is
					// server-rendered with its rows since #6127 — see ClockText).
					<ClockText
						className="font-mono text-xs text-muted-foreground"
						sizer="30 Sept 2026"
						text={() => formatDate(row.original.paidAt)}
					/>
				),
			},
			{
				id: "period",
				header: "Billing period",
				enableSorting: false,
				cell: ({ row }) => (
					<ClockText
						className="font-mono text-xs text-muted-foreground"
						sizer="30 Sept 2026 – 30 Sept 2026"
						text={() => formatBillingPeriod(row.original)}
					/>
				),
			},
			{
				accessorKey: "status",
				header: "Status",
				cell: ({ row }) => <InvoiceStatusBadge status={row.original.status} />,
			},
			{
				accessorKey: "total",
				header: () => <div className="text-right">Total</div>,
				cell: ({ row }) => (
					<div className="text-right font-mono text-foreground">
						{/* `total` is ALREADY minor units ("Total in the smallest currency unit"),
						    which is what formatMoney takes — no conversion. */}
						{formatMoney(row.original.total, row.original.currency.toUpperCase())}
					</div>
				),
			},
			{
				id: "actions",
				header: () => <div className="text-right">Actions</div>,
				enableSorting: false,
				cell: ({ row }) => (
					<div className="flex items-center justify-end gap-3">
						<button
							type="button"
							className="inline-flex items-center gap-1.5 font-mono text-xs text-muted-foreground transition-colors hover:text-foreground"
							onClick={(e) => {
								e.stopPropagation();
								onPreview(row.original);
							}}
						>
							<Eye size={12} />
							Preview
						</button>
						{row.original.facturaIssued && (
							<a
								className="inline-flex items-center gap-1.5 font-mono text-xs text-muted-foreground underline-offset-2 transition-colors hover:text-foreground hover:underline"
								href={invoicePdfHref(org, row.original.id, true)}
								onClick={(e) => e.stopPropagation()}
							>
								<Download size={12} />
								PDF
							</a>
						)}
					</div>
				),
			},
		],
		[org, onPreview],
	);
}

/**
 * The Billing page's five-row invoice preview — presentational. `rows` are held whole by the
 * parent (one read, first page only, with a link to the full list), `onPreview` opens the preview
 * dialog (also triggered by a row click). Server mode over a finished list: no browser paging.
 */
export function InvoicesTable({
	rows,
	onPreview,
	emptyMessage,
}: {
	rows: InvoiceInfo[];
	onPreview: (row: InvoiceInfo) => void;
	/** Empty-state row text (unified empty table). */
	emptyMessage?: string;
}) {
	const columns = useInvoiceColumns(onPreview);
	const keyset = useMemo(() => wholeList(rows), [rows]);
	return <DataTable columns={columns} keyset={keyset} onRowClick={onPreview} emptyMessage={emptyMessage} />;
}
