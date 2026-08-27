// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { formatRelative } from "@repo/format";
import { cn } from "@repo/ui/utils";
import Link from "next/link";
import type { CaseListItem as CaseListItemData } from "@/lib/queries/support";
import { SUPPORT_CATEGORY_LABELS } from "@/lib/validations/support";
import { CaseSeverityBadge } from "./case-severity-badge";
import { CaseStatusBadge } from "./case-status-badge";
import { formatCaseNumber } from "./case-query";

// `formatCaseNumber` moved to the pure `case-query` module (the search predicate there
// matches on the same reference, and a filter helper must not import a React component to
// get it). Re-exported here only because two modules outside this change's scope —
// components/shell/notifications-popover.tsx and hooks/use-support-toasts.ts — still import
// it from this path; delete this line once they point at ./case-query.
export { formatCaseNumber };

/**
 * A single row in the "My cases" list: the case reference + subject, its status and
 * severity badges, category, and relative last-activity time, with an unread dot when
 * the row has activity newer than the caller's read watermark. The whole row links to
 * the case-detail thread.
 */
export function CaseListItem({
	item,
	orgSlug,
}: {
	item: CaseListItemData;
	orgSlug: string;
}) {
	return (
		<Link
			href={`/${orgSlug}/~/support/cases/${item.id}`}
			className="flex items-start gap-4 border-b border-border/60 px-4 py-3.5 transition-colors last:border-b-0 hover:bg-muted/40"
		>
			{/* Unread indicator — a single dot, no colour. */}
			<span
				className="mt-1.5 flex size-2 shrink-0 items-center justify-center"
				aria-hidden={!item.unread}
			>
				{item.unread && (
					<span className="size-2 rounded-full bg-foreground" />
				)}
			</span>

			<div className="min-w-0 flex-1 space-y-1">
				<div className="flex items-center gap-2">
					<span className="font-mono text-xs text-muted-foreground">
						{formatCaseNumber(item.case_number)}
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
					<span>{SUPPORT_CATEGORY_LABELS[item.category]}</span>
					<span aria-hidden>·</span>
					<span>{formatRelative(item.last_message_at)}</span>
					{/* Whose case — shown only on rows the caller didn't open (i.e. an admin
					    viewing the whole org's cases); their own rows stay uncluttered. */}
					{!item.is_mine && item.requester_name && (
						<>
							<span aria-hidden>·</span>
							<span>Opened by {item.requester_name}</span>
						</>
					)}
				</div>
			</div>

			<div className="flex shrink-0 items-center gap-2">
				<CaseSeverityBadge severity={item.severity} />
				<CaseStatusBadge status={item.status} />
			</div>
		</Link>
	);
}
