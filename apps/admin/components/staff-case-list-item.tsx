// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { cn } from "@repo/ui/utils";
import { caseLabel } from "@repo/support/status";
import { formatDistanceToNow } from "date-fns";
import { Building2, UserCircle2 } from "lucide-react";
import Link from "next/link";
import type { StaffCaseListItem as StaffCaseListItemData } from "@/lib/queries";
import { CaseSeverityBadge } from "./case-severity-badge";
import { CaseStatusBadge } from "./case-status-badge";

/**
 * A single row in the staff cross-tenant case list. Links to the staff case-detail thread
 * and surfaces the case reference + subject, the owning org (or "Personal" when there's no
 * org), status/severity badges, the current assignee (or "Unassigned"), relative last
 * activity, and an unread dot keyed to the staff member's own read watermark.
 */
export function StaffCaseListItem({ item }: { item: StaffCaseListItemData }) {
	return (
		<Link
			href={`/cases/${item.id}`}
			className="flex items-start gap-4 border-b border-border/60 px-4 py-3.5 transition-colors last:border-b-0 hover:bg-muted/40"
		>
			{/* Unread indicator — a single dot, no colour. */}
			<span
				className="mt-1.5 flex size-2 shrink-0 items-center justify-center"
				aria-hidden={!item.unread}
			>
				{item.unread && <span className="size-2 rounded-full bg-foreground" />}
			</span>

			<div className="min-w-0 flex-1 space-y-1">
				<div className="flex items-center gap-2">
					<span className="font-mono text-xs text-muted-foreground">
						{caseLabel(item.case_number)}
					</span>
					<span
						className={cn(
							"truncate text-sm",
							item.unread ? "font-medium text-foreground" : "text-foreground",
						)}
					>
						{item.subject}
					</span>
				</div>
				<div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
					<span className="flex items-center gap-1">
						<Building2 className="size-3" />
						{item.org_name ?? "Personal"}
					</span>
					<span aria-hidden>·</span>
					<span className="flex items-center gap-1">
						<UserCircle2 className="size-3" />
						{item.assigned_staff_name ?? "Unassigned"}
					</span>
					<span aria-hidden>·</span>
					<span>
						{formatDistanceToNow(new Date(item.last_message_at), {
							addSuffix: true,
						})}
					</span>
				</div>
			</div>

			<div className="flex shrink-0 items-center gap-2">
				<CaseSeverityBadge severity={item.severity} />
				<CaseStatusBadge status={item.status} />
			</div>
		</Link>
	);
}
