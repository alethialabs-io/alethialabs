"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { ColumnDef } from "@tanstack/react-table";
import { RelativeTime } from "@/components/jobs/columns";
import type { ApprovalListItem } from "@/lib/queries/approvals";
import { ApprovalCountdown } from "./approval-countdown";
import { ApprovalStatusBadge, OperationTag, ProductionPill, RequesterMark } from "./approval-marks";
import { requestedThrough } from "./approval-vocabulary";

/** The row's "what": the operation tag, project / environment, and the Production pill. */
export function RequestCell({ row }: { row: ApprovalListItem }) {
	return (
		<span className="flex min-w-0 flex-wrap items-center gap-2">
			<OperationTag operation={row.operation} />
			<span className="min-w-0 truncate text-text-primary">
				{row.project_name} / <span className="font-mono">{row.environment_name}</span>
			</span>
			{row.environment_stage === "production" ? <ProductionPill /> : null}
		</span>
	);
}

/** The person a request is for, and under them what asked on their behalf. */
function RequestedForCell({ row }: { row: ApprovalListItem }) {
	const through = requestedThrough(row);
	return (
		<span className="flex min-w-0 flex-col">
			<span className="truncate text-text-primary">{row.requester_name ?? "Unknown person"}</span>
			<span className="flex items-center gap-1 text-ui-sm text-text-secondary">
				<RequesterMark approval={row} />
				<span className="truncate">{through.name}</span>
			</span>
		</span>
	);
}

/**
 * The last column: a waiting request's countdown, or how a decided one ended — "Approved by Dana
 * Petrova", "Used by job 5c7d2e81", "Expired without a decision", "Replaced by a newer plan".
 */
function OutcomeCell({ row }: { row: ApprovalListItem }) {
	const line = (lead: string, rest: string, mono = false) => (
		<span className="flex flex-col text-ui-sm">
			<span className="text-text-secondary">{lead}</span>
			<span className={mono ? "font-mono text-text-primary" : "text-text-primary"}>{rest}</span>
		</span>
	);
	switch (row.status) {
		case "pending":
			return <ApprovalCountdown expiresAt={row.expires_at} />;
		case "approved":
			return line("Approved by", row.approver_name ?? "a teammate");
		case "rejected":
			return line("Denied by", row.approver_name ?? "a teammate");
		case "consumed":
			return row.consumed_job_id ? line("Used by job", row.consumed_job_id.slice(0, 8), true) : line("Used", "by its job");
		case "expired":
			return row.approver_name ? line("Expired", "approved, never used") : line("Expired", "without a decision");
		case "superseded":
			return line("Replaced by", "a newer plan");
	}
}

/**
 * The approvals list's columns (spec §1.3). No Plan column: the list read carries no plan counts, and
 * reading every row's plan job to draw one would be a read per row — the counts are in the sheet.
 */
export function buildApprovalColumns(): ColumnDef<ApprovalListItem>[] {
	return [
		{
			id: "status",
			header: "Status",
			cell: ({ row }) => <ApprovalStatusBadge status={row.original.status} />,
		},
		{
			id: "request",
			header: "Request",
			cell: ({ row }) => <RequestCell row={row.original} />,
		},
		{
			id: "requester",
			header: "Requested for",
			cell: ({ row }) => <RequestedForCell row={row.original} />,
		},
		{
			id: "digest",
			header: "Digest",
			cell: ({ row }) => <span className="font-mono text-ui-sm text-text-primary">{row.original.digest_prefix}</span>,
		},
		{
			id: "created",
			header: "Requested",
			cell: ({ row }) => <RelativeTime at={row.original.created_at} />,
		},
		{
			id: "outcome",
			header: () => <span className="sr-only">Outcome</span>,
			cell: ({ row }) => <OutcomeCell row={row.original} />,
		},
	];
}
