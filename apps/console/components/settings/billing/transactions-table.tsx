"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Transaction history (Billing page) — the org's recent Stripe charges (paid /
// failed / refunded) on the shared DataTable (sortable + paginated). Read-only. The read is
// `billing.transactions` over GET, prefetched by the route (#6127); a failed read renders as an
// error with a retry, never as "No transactions yet".

import { useQuery } from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import { DataTable } from "@/components/data-table";
import { RegionError } from "@/components/errors/region-error";
import { RegionRefusal, refusalOf, retryUnlessRefused } from "@/components/settings/billing/read-state";
import { SettingsSection } from "@/components/settings/settings-ui";
import { ClockText } from "@/components/settings/usage/clock-text";
import { DataTableSkeleton } from "@/components/skeletons/data-table-skeleton";
import { orpc } from "@/lib/rpc/client";
import type { TransactionInfo } from "@/lib/rpc/procedures/billing";
import { formatDate, formatMoney } from "@repo/format";
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
			<ClockText
				className="font-mono text-xs text-muted-foreground"
				sizer="30 Sept 2026"
				text={() => formatDate(row.original.created)}
			/>
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

/** The Transaction history section: the table, or its pending / refused / failed render. */
export function TransactionsTable() {
	const rows = useQuery(orpc.billing.transactions.queryOptions({ retry: retryUnlessRefused }));
	const refusal = rows.isError ? refusalOf(rows.error) : null;

	return (
		<SettingsSection title="Transaction history">
			{rows.data !== undefined ? (
				<DataTable
					columns={columns}
					data={rows.data}
					pageSize={10}
					emptyMessage="No transactions yet."
				/>
			) : refusal ? (
				<RegionRefusal refusal={refusal} />
			) : rows.isError ? (
				<RegionError
					title="Couldn't load transactions"
					description="Something went wrong reading this organization's charges."
					onRetry={() => void rows.refetch()}
				/>
			) : (
				<DataTableSkeleton columns={5} rows={4} />
			)}
		</SettingsSection>
	);
}
