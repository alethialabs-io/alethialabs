"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { RelativeTime } from "@/components/jobs/columns";
import { ListFooter } from "@/components/list/list-footer";
import type { ApprovalListItem } from "@/lib/queries/approvals";
import type { KeysetList } from "@/lib/query/use-keyset-list";
import { ApprovalCountdown } from "./approval-countdown";
import { ApprovalStatusBadge } from "./approval-marks";
import { RequestCell } from "./approval-columns";
import { approvalTitle, requestedThrough } from "./approval-vocabulary";

/**
 * The approvals list at phone width (spec §0, Lists): a stacked list with the table's fields, each
 * item a button that opens the decision sheet, followed by the same keyset footer the table carries.
 * Hidden from `md` up, where the table takes over; the two never show at once.
 */
export function ApprovalsPhoneList({
	list,
	onOpen,
}: {
	list: KeysetList<ApprovalListItem>;
	onOpen: (row: ApprovalListItem, opener: HTMLElement) => void;
}) {
	return (
		<div className="space-y-3 md:hidden">
			<ul aria-label="Approval requests" className="divide-y divide-border rounded-lg border">
				{list.rows.map((row) => {
					const through = requestedThrough(row);
					return (
						<li key={row.id}>
							<button
								type="button"
								aria-label={`Open ${approvalTitle(row)}`}
								onClick={(event) => onOpen(row, event.currentTarget)}
								className="flex w-full flex-col gap-1.5 px-4 py-3 text-left focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring"
							>
								<span className="flex items-center justify-between gap-2">
									<ApprovalStatusBadge status={row.status} />
									{row.status === "pending" ? <ApprovalCountdown expiresAt={row.expires_at} /> : <RelativeTime at={row.created_at} />}
								</span>
								<RequestCell row={row} />
								<span className="text-ui-sm text-text-secondary">
									{row.requester_name ?? "Unknown person"} · {through.name} ·{" "}
									<span className="font-mono">{row.digest_prefix}</span>
								</span>
							</button>
						</li>
					);
				})}
			</ul>
			<ListFooter list={list} />
		</div>
	);
}
