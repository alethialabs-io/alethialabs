"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Invoices table (Billing page) — the org's Stripe invoices with status and a PDF
// receipt link, on the shared DataTable (sortable + paginated). Read-only; the PDFs
// are Stripe-hosted.

import type { ColumnDef } from "@tanstack/react-table";
import { Download } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { type InvoiceInfo, listInvoices } from "@/app/server/actions/billing";
import { DataTable } from "@/components/data-table";
import { SettingsSection } from "@/components/settings/settings-ui";
import { Skeleton } from "@repo/ui/skeleton";
import { cn } from "@repo/ui/utils";

/** Maps a Stripe invoice status to the color-free badge variant + label. */
function invoiceStatus(status: string): { variant: string; label: string } {
	switch (status) {
		case "paid":
			return { variant: "vx-status--active", label: "Paid" };
		case "open":
		case "draft":
			return { variant: "vx-status--pending", label: "Processing" };
		case "void":
		case "uncollectible":
			return { variant: "vx-status--failed", label: "Failed" };
		default:
			return { variant: "vx-status--pending", label: status };
	}
}

/** Smallest-unit amount → localized currency. */
function formatAmount(total: number, currency: string): string {
	return new Intl.NumberFormat(undefined, {
		style: "currency",
		currency: currency.toUpperCase(),
	}).format(total / 100);
}

function formatDate(iso: string): string {
	return new Date(iso).toLocaleDateString(undefined, {
		day: "numeric",
		month: "short",
		year: "numeric",
	});
}
function formatPeriod(iso: string): string {
	return new Date(iso).toLocaleDateString(undefined, {
		month: "short",
		year: "numeric",
	});
}

const columns: ColumnDef<InvoiceInfo>[] = [
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
		accessorKey: "created",
		header: "Issued",
		cell: ({ row }) => (
			<span className="whitespace-nowrap font-mono text-xs text-muted-foreground">
				{formatDate(row.original.created)}
			</span>
		),
	},
	{
		id: "period",
		header: "Billing period",
		enableSorting: false,
		cell: ({ row }) => (
			<span className="font-mono text-xs text-muted-foreground">
				{formatPeriod(row.original.created)}
			</span>
		),
	},
	{
		accessorKey: "status",
		header: "Status",
		cell: ({ row }) => {
			const st = invoiceStatus(row.original.status);
			return (
				<span className={cn("vx-status", st.variant)}>
					<span className="vx-status__dot" />
					{st.label}
				</span>
			);
		},
	},
	{
		accessorKey: "total",
		header: () => <div className="text-right">Total</div>,
		cell: ({ row }) => (
			<div className="text-right font-mono text-foreground">
				{formatAmount(row.original.total, row.original.currency)}
			</div>
		),
	},
	{
		id: "receipt",
		header: () => <div className="text-right">Receipt</div>,
		enableSorting: false,
		cell: ({ row }) => (
			<div className="text-right">
				{row.original.invoicePdf ? (
					<a
						className="inline-flex items-center gap-1.5 font-mono text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
						href={row.original.invoicePdf}
						target="_blank"
						rel="noopener noreferrer"
					>
						<Download size={12} />
						PDF
					</a>
				) : (
					<span className="text-muted-foreground">—</span>
				)}
			</div>
		),
	},
];

export function InvoicesTable() {
	const [rows, setRows] = useState<InvoiceInfo[] | null>(null);

	useEffect(() => {
		listInvoices()
			.then(setRows)
			.catch(() => toast.error("Couldn't load invoices."));
	}, []);

	return (
		<SettingsSection title="Invoices" className="mb-0">
			{!rows ? (
				<Skeleton className="h-40 w-full" />
			) : (
				<DataTable columns={columns} data={rows} pageSize={10} />
			)}
		</SettingsSection>
	);
}
