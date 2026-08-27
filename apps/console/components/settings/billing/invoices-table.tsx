"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Invoices table (Billing) — a presentational DataTable of the org's mirrored invoices with
// number, paid date, billing period, status, total, and per-row actions (Preview + a
// self-hosted PDF download). Read-only; the parent owns the data + the preview dialog. The
// PDF/download hrefs are built from the org slug (route segment `[org]`).

import type { ColumnDef } from "@tanstack/react-table";
import { Download, Eye } from "lucide-react";
import { useParams } from "next/navigation";
import { useMemo } from "react";
import type { InvoiceInfo } from "@/app/server/actions/billing";
import { DataTable } from "@/components/data-table";
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

/** Builds the inline-preview / download href for an invoice's PDF route. */
export function invoicePdfHref(org: string, id: string, download = false): string {
	const base = `/${org}/~/settings/billing/invoices/${id}/pdf`;
	return download ? `${base}?download=1` : base;
}

/**
 * The invoices table — presentational. `rows` are supplied by the parent, `onPreview` opens
 * the preview dialog (also triggered by a row click), and `pageSize` caps the page.
 */
export function InvoicesTable({
	rows,
	onPreview,
	pageSize = 10,
	emptyMessage,
}: {
	rows: InvoiceInfo[];
	onPreview: (row: InvoiceInfo) => void;
	pageSize?: number;
	/** Empty-state row text (unified empty table). */
	emptyMessage?: string;
}) {
	const { org } = useParams<{ org: string }>();

	const columns = useMemo<ColumnDef<InvoiceInfo>[]>(
		() => [
			{
				accessorKey: "number",
				header: "Invoice",
				cell: ({ row }) => (
					<span className="font-mono text-xs text-foreground">
						{row.original.number ?? "—"}
					</span>
				),
			},
			{
				accessorKey: "paidAt",
				header: "Paid",
				cell: ({ row }) => (
					<span className="whitespace-nowrap font-mono text-xs text-muted-foreground">
						{formatDate(row.original.paidAt)}
					</span>
				),
			},
			{
				id: "period",
				header: "Billing period",
				enableSorting: false,
				cell: ({ row }) => (
					<span className="whitespace-nowrap font-mono text-xs text-muted-foreground">
						{formatBillingPeriod(row.original)}
					</span>
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
						{row.original.hasPdf && (
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

	return (
		<DataTable
			columns={columns}
			data={rows}
			onRowClick={onPreview}
			pageSize={pageSize}
			emptyMessage={emptyMessage}
		/>
	);
}
