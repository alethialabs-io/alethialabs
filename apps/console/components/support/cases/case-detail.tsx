"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { formatBytes } from "@repo/format";
import { Alert, AlertDescription, AlertTitle } from "@repo/ui/alert";
import { Button } from "@repo/ui/button";
import { EmptyState } from "@repo/ui/empty";
import { SectionHeading } from "@repo/ui/section-heading";
import { isDefinedError } from "@orpc/client";
import { ArrowLeft, Download, Lock, Paperclip, SearchX } from "lucide-react";
import Link from "next/link";
import { useEffect } from "react";
import { markCaseRead } from "@/app/server/actions/support";
import { ClassificationControl } from "@/components/classification/classification-control";
import { RegionError } from "@/components/errors/region-error";
import { useActionMutation } from "@/lib/actions/use-action-mutation";
import { orpc } from "@/lib/rpc/client";
import {
	SUPPORT_CASE_TYPE_LABELS,
	SUPPORT_CATEGORY_LABELS,
} from "@/lib/validations/support";
import { CaseActions } from "./case-actions";
import { CaseComposer } from "./case-composer";
import { CaseDetailSkeleton } from "./case-detail-skeleton";
import { useCaseQuery } from "./case-queries";
import { formatCaseNumber } from "./case-query";
import { CaseSeverityBadge } from "./case-severity-badge";
import { CaseStatusBadge } from "./case-status-badge";
import { CaseThread } from "./case-thread";
import { CaseTime } from "./case-time";

/**
 * The case-detail view: header (reference, subject, status/severity/type/category, opened date,
 * lifecycle actions), the attachments, the conversation thread and the reply composer — or, on a
 * CLOSED case, a closed notice with the way to reopen it in place of a composer nobody can use.
 *
 * Reads `support.case` (prefetched by the route, so the first paint carries the thread). Live by
 * the bus: a staff or AI reply moves the case row, which is a `support` hint that invalidates this
 * key — there is no per-case stream any more (ADR 0005 D3, one stream per browser). Pending,
 * not-found and a failed read are three different renders; none of them is an empty thread.
 */
export function CaseDetail({
	caseId,
	orgSlug,
}: {
	caseId: string;
	orgSlug: string;
}) {
	const result = useCaseQuery(caseId);
	const { data, refetch } = result;
	const messageCount = data?.messages.length ?? 0;

	// The read watermark: advanced once the case is on screen and again whenever a newer message
	// lands, so the unread dot in "My cases" and the bell clears for what the viewer has seen.
	const markRead = useActionMutation(markCaseRead, {
		invalidates: [orpc.support.cases.key(), orpc.workspace.supportCases.key()],
	});
	const { mutate: mark } = markRead;
	const hasCase = data !== undefined;
	useEffect(() => {
		if (hasCase) mark({ id: caseId });
	}, [hasCase, messageCount, caseId, mark]);

	if (data === undefined) {
		if (!result.isError) return <CaseDetailSkeleton />;
		// A case that is not visible is a not-found, never an error and never an empty thread.
		// (The route answers this on the server; this is the case that went away while open.)
		if (isDefinedError(result.error) && result.error.code === "NOT_FOUND") {
			return (
				<EmptyState
					className="rounded-md border"
					level={2}
					icon={<SearchX />}
					title="Case not found"
					description="This support case doesn't exist, or you don't have access to it."
					action={
						<Button size="sm" nativeButton={false} render={<Link href={`/${orgSlug}/~/support/my-cases`} />}>
							My cases
						</Button>
					}
				/>
			);
		}
		return (
			<RegionError
				title="Couldn't load this case"
				description="Something went wrong fetching the case. Check your connection and try again."
				onRetry={() => refetch()}
			/>
		);
	}

	const { case: supportCase, messages, attachments } = data;
	const isClosed = supportCase.status === "closed";

	return (
		<div className="flex flex-col gap-6">
			{/* Header */}
			<div className="space-y-4">
				<Button
					variant="ghost"
					size="sm"
					className="-ml-2 h-7 w-fit text-muted-foreground"
					nativeButton={false}
					render={<Link href={`/${orgSlug}/~/support/my-cases`} />}
				>
					<ArrowLeft className="size-4" />
					My cases
				</Button>

				<div className="space-y-2">
					<div className="flex items-center gap-2 font-mono text-xs text-muted-foreground">
						{formatCaseNumber(supportCase.case_number)}
					</div>
					{/* A section heading, not a page title. The console dropped its page titles because
					    the breadcrumb already says the route's name — and the breadcrumb names this
					    route by its case NUMBER; no crumb will ever carry the case SUBJECT, which is
					    the thing the page is about. */}
					<SectionHeading
						title={supportCase.subject}
						description={
							<span className="flex flex-wrap items-center gap-2 text-xs">
								<CaseStatusBadge status={supportCase.status} />
								<CaseSeverityBadge severity={supportCase.severity} />
								<span>{SUPPORT_CASE_TYPE_LABELS[supportCase.type]}</span>
								<span aria-hidden>·</span>
								<span>{SUPPORT_CATEGORY_LABELS[supportCase.category]}</span>
								<span aria-hidden>·</span>
								<span>
									Opened <CaseTime value={supportCase.created_at} style="date" />
								</span>
							</span>
						}
						actions={
							// A closed case's one action is in the closed notice below, not twice on screen.
							isClosed ? undefined : <CaseActions caseId={caseId} status={supportCase.status} />
						}
					/>
					{/* Structured classification (Workstream B). The control shows a picker only
					    for org:edit holders (org taxonomy is an admin action), else read-only chips. */}
					<ClassificationControl kind="support_case" id={caseId} canEdit />
				</div>
			</div>

			{/* Attachments */}
			{attachments.length > 0 && (
				<div className="space-y-2 rounded-md border p-4">
					<div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
						<Paperclip className="size-3.5" />
						Attachments
					</div>
					<ul className="space-y-1">
						{attachments.map((att) => (
							<li key={att.id}>
								<a
									href={`/api/support/attachments/${att.id}`}
									className="flex items-center gap-2 text-sm text-foreground hover:underline"
								>
									<Download className="size-3.5 text-muted-foreground" />
									<span className="truncate">{att.file_name}</span>
									<span className="text-xs text-muted-foreground">
										{formatBytes(att.size_bytes)}
									</span>
								</a>
							</li>
						))}
					</ul>
				</div>
			)}

			{/* Thread */}
			<div className="rounded-md border">
				<CaseThread messages={messages} />
			</div>

			{/* A closed case takes no replies: say so, and offer the one way forward (F045). */}
			{isClosed ? (
				<Alert role="status" data-testid="case-closed-notice">
					<Lock />
					<AlertTitle>This case is closed</AlertTitle>
					<AlertDescription>
						<p>
							It no longer takes replies. Reopen it to continue the conversation, or open a new case
							for a different issue.
						</p>
						<CaseActions caseId={caseId} status={supportCase.status} variant="reopen" />
					</AlertDescription>
				</Alert>
			) : (
				<CaseComposer caseId={caseId} />
			)}
		</div>
	);
}
