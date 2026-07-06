"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
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
import { cn } from "@repo/ui/utils";

/** Maps an invoice status to the color-free badge variant + label. */
function invoiceStatusBadge(status: InvoiceInfo["status"]): {
	variant: string;
	label: string;
} {
	switch (status) {
		case "paid":
			return { variant: "vx-status--active", label: "Paid" };
		case "refunded":
			return { variant: "vx-status--pending", label: "Refunded" };
		case "void":
			return { variant: "vx-status--failed", label: "Void" };
	}
}

/** A grayscale status pill for an invoice, matching the billing panel's `vx-status` look. */
export function InvoiceStatusBadge({ status }: { status: InvoiceInfo["status"] }) {
	const s = invoiceStatusBadge(status);
	return (
		<span className={cn("vx-status", s.variant)}>
			<span className="vx-status__dot" />
			{s.label}
		</span>
	);
}

/** Smallest-unit amount → localized currency (e.g. cents → "$12.00"). */
export function formatInvoiceAmount(total: number, currency: string): string {
	return new Intl.NumberFormat(undefined, {
		style: "currency",
		currency: currency.toUpperCase(),
	}).format(total / 100);
}

/** "1 Jul 2026" — the primary display date. */
export function formatInvoiceDate(iso: string): string {
	return new Date(iso).toLocaleDateString(undefined, {
		day: "numeric",
		month: "short",
		year: "numeric",
	});
}

/** "Jul 2026" — a month-level label used as the billing-period fallback. */
function formatMonth(iso: string): string {
	return new Date(iso).toLocaleDateString(undefined, {
		month: "short",
		year: "numeric",
	});
}

/**
 * The billing period an invoice covers ("1 Jun – 1 Jul 2026"), falling back to the paid
 * month when the period isn't known.
 */
export function formatBillingPeriod(invoice: InvoiceInfo): string {
	if (invoice.periodStart && invoice.periodEnd) {
		return `${formatInvoiceDate(invoice.periodStart)} – ${formatInvoiceDate(invoice.periodEnd)}`;
	}
	return formatMonth(invoice.paidAt);
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
						{formatInvoiceDate(row.original.paidAt)}
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
						{formatInvoiceAmount(row.original.total, row.original.currency)}
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
