"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Transaction history (Billing page) — EVERY Stripe charge the org has (paid / failed / refunded),
// newest first, on the shared DataTable in server mode. Read-only. The read is
// `billing.transactions` over GET, one keyset page at a time through Stripe's own cursor
// (`starting_after`, mapped onto the console's opaque cursor — lib/queries/billing.ts), with the
// first page prefetched by the route (#6127). The shared footer (scroll sentinel + "Load more")
// fetches the next page. This used to read the newest 24 charges and page THOSE in the browser,
// ten at a time, so charge 25 and every one after it was silently unreachable (#7493).
//
// A refused read (no hosted billing, no permission) is its own state; a failed first page is the
// table's region error with a retry, never "No transactions yet"; a failed later page keeps the
// loaded rows and says so in the footer. No count: the console carries no list counts.

import type { ColumnDef } from "@tanstack/react-table";
import { DataTable } from "@/components/data-table";
import { RegionRefusal, refusalOf } from "@/components/settings/billing/read-state";
import { SettingsSection } from "@/components/settings/settings-ui";
import { ClockText } from "@/components/settings/usage/clock-text";
import { useKeysetList } from "@/lib/query/use-keyset-list";
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

/** The ledger reads every charge from the first page on; the history has no filters to narrow it. */
const NO_FILTER = {};

/** The Transaction history section: every charge, paged, or its refused render. */
export function TransactionsTable() {
	const list = useKeysetList(orpc.billing.transactions, NO_FILTER);
	const refusal = list.query.isError ? refusalOf(list.query.error) : null;

	return (
		<SettingsSection title="Transaction history">
			{refusal ? (
				<RegionRefusal refusal={refusal} />
			) : (
				<DataTable columns={columns} keyset={list} skeletonRows={4} emptyMessage="No transactions yet." />
			)}
		</SettingsSection>
	);
}
