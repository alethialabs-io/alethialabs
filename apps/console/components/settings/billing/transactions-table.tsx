"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Transaction history (Billing page) — the org's recent Stripe charges (paid /
// failed / refunded) on the shared DataTable (sortable + paginated). Read-only.

import type { ColumnDef } from "@tanstack/react-table";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import {
	listTransactions,
	type TransactionInfo,
} from "@/app/server/actions/billing";
import { DataTable } from "@/components/data-table";
import { SettingsSection } from "@/components/settings/settings-ui";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

/** Smallest-unit amount → localized currency (negative renders as −$x). */
function formatAmount(amount: number, currency: string): string {
	return new Intl.NumberFormat(undefined, {
		style: "currency",
		currency: currency.toUpperCase(),
		signDisplay: "auto",
	}).format(amount / 100);
}

/** "1 Jun 2026" */
function formatDate(iso: string): string {
	return new Date(iso).toLocaleDateString(undefined, {
		day: "numeric",
		month: "short",
		year: "numeric",
	});
}

const STATUS: Record<TransactionInfo["status"], { variant: string; label: string }> = {
	paid: { variant: "vx-status--active", label: "Paid" },
	pending: { variant: "vx-status--pending", label: "Pending" },
	failed: { variant: "vx-status--failed", label: "Failed" },
	refunded: { variant: "vx-status--idle", label: "Refunded" },
};

function StatusBadge({ status }: { status: TransactionInfo["status"] }) {
	const s = STATUS[status];
	return (
		<span className={cn("vx-status", s.variant)}>
			<span className="vx-status__dot" />
			{s.label}
		</span>
	);
}

const columns: ColumnDef<TransactionInfo>[] = [
	{
		accessorKey: "created",
		header: "Date",
		cell: ({ row }) => (
			<span className="whitespace-nowrap font-mono text-xs text-muted-foreground">
				{formatDate(row.original.created)}
			</span>
		),
	},
	{
		accessorKey: "description",
		header: "Description",
		cell: ({ row }) => (
			<span className="text-foreground">{row.original.description}</span>
		),
	},
	{
		accessorKey: "method",
		header: "Method",
		enableSorting: false,
		cell: ({ row }) => (
			<span className="font-mono text-xs text-muted-foreground">
				{row.original.method ?? "—"}
			</span>
		),
	},
	{
		accessorKey: "status",
		header: "Status",
		cell: ({ row }) => <StatusBadge status={row.original.status} />,
	},
	{
		accessorKey: "amount",
		header: () => <div className="text-right">Amount</div>,
		cell: ({ row }) => (
			<div className="text-right font-mono text-foreground">
				{formatAmount(row.original.amount, row.original.currency)}
			</div>
		),
	},
];

export function TransactionsTable() {
	const [rows, setRows] = useState<TransactionInfo[] | null>(null);

	useEffect(() => {
		listTransactions()
			.then(setRows)
			.catch(() => toast.error("Couldn't load transactions."));
	}, []);

	return (
		<SettingsSection title="Transaction history">
			{!rows ? (
				<Skeleton className="h-40 w-full" />
			) : (
				<DataTable columns={columns} data={rows} pageSize={10} />
			)}
		</SettingsSection>
	);
}
