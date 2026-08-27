"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
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
import { formatDate, formatMoney } from "@repo/format";
import { Skeleton } from "@repo/ui/skeleton";
import { StatusBadge, type StatusTier } from "@repo/ui/status-badge";

// A transaction outcome is not one of the product statuses `statusTier()` knows — "paid" and
// "refunded" would both fall through to `idle` — so the tier is stated explicitly and the
// SHARED badge renders it. This replaces a file-local `StatusBadge` that collided by name
// with @repo/ui's and with the third one in settings/members/members-table.tsx.
const STATUS: Record<TransactionInfo["status"], { tier: StatusTier; label: string }> = {
	paid: { tier: "active", label: "Paid" },
	pending: { tier: "pending", label: "Pending" },
	failed: { tier: "failed", label: "Failed" },
	refunded: { tier: "idle", label: "Refunded" },
};

/** The grayscale pill for one transaction outcome. */
function TransactionStatusBadge({ status }: { status: TransactionInfo["status"] }) {
	const s = STATUS[status];
	return <StatusBadge status={status} tier={s.tier} label={s.label} />;
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
		cell: ({ row }) => <TransactionStatusBadge status={row.original.status} />,
	},
	{
		accessorKey: "amount",
		header: () => <div className="text-right">Amount</div>,
		cell: ({ row }) => (
			<div className="text-right font-mono text-foreground">
				{/* `amount` is ALREADY minor units (the Stripe charge amount), which is what
				    formatMoney takes — no /100 here, and no *100 either. */}
				{formatMoney(row.original.amount, row.original.currency.toUpperCase())}
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
				<DataTable
					columns={columns}
					data={rows}
					pageSize={10}
					emptyMessage="No transactions yet."
				/>
			)}
		</SettingsSection>
	);
}
