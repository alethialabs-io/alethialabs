"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { Button } from "@repo/ui/button";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { caseLabel } from "@repo/support/status";
import { format } from "date-fns";
import { ArrowLeft, Building2, Download, Mail, Paperclip } from "lucide-react";
import Link from "next/link";
import { useEffect } from "react";
import type { SupportAuthorType } from "@repo/support/enums";
import {
	SUPPORT_CASE_TYPE_LABELS,
	SUPPORT_CATEGORY_LABELS,
} from "@repo/support/validations";
import { getStaffCase } from "@/app/actions";
import type { StaffCaseDetail as StaffCaseDetailData } from "@/lib/queries";
import { CaseSeverityBadge } from "./case-severity-badge";
import { CaseStatusBadge } from "./case-status-badge";
import { StaffCaseActions } from "./staff-case-actions";
import { StaffCaseComposer } from "./staff-case-composer";
import { StaffCaseThread } from "./staff-case-thread";

/** One message row in the staff cache (full SupportMessage incl. is_internal). */
type StaffMessage = StaffCaseDetailData["messages"][number];

/** The JSON shape pushed over the staff SSE stream (includes internal notes). */
interface StreamMessage {
	id: string;
	author_type: SupportAuthorType;
	author_name: string | null;
	body: string;
	is_internal: boolean;
	created_at: string;
}

/** Humanises a byte count for the attachment list. */
function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * The staff case-detail view. Reads the server-prefetched `getStaffCase` cache (org +
 * customer context + FULL thread incl. internal notes), then subscribes to the staff SSE
 * stream and pushes newly-arrived messages — internal notes included — into that cache
 * (deduped by id) so replies land live without a refetch. Renders the header (reference,
 * subject, org/customer, badges, type/category, created date, lifecycle + assignment
 * actions), attachments, the thread, and the reply composer.
 */
export function StaffCaseDetail({
	caseId,
	staffId,
	staffName,
}: {
	caseId: string;
	staffId: string;
	staffName: string;
}) {
	const queryClient = useQueryClient();
	const { data } = useQuery({
		queryKey: ["support-admin", "case", caseId],
		queryFn: () => getStaffCase(caseId),
	});

	// Live thread: append SSE messages into the case cache, deduped by message id.
	useEffect(() => {
		const source = new EventSource(`/api/stream/cases/${caseId}`);
		const key = ["support-admin", "case", caseId] as const;

		source.onmessage = (event: MessageEvent<string>) => {
			let incoming: StreamMessage;
			try {
				incoming = JSON.parse(event.data) as StreamMessage;
			} catch {
				return;
			}
			queryClient.setQueryData<StaffCaseDetailData | null>(key, (current) => {
				if (!current) return current;
				if (current.messages.some((m) => m.id === incoming.id)) return current;
				const message: StaffMessage = {
					id: incoming.id,
					case_id: caseId,
					author_type: incoming.author_type,
					author_id: null,
					author_name: incoming.author_name,
					body: incoming.body,
					is_internal: incoming.is_internal,
					created_at: new Date(incoming.created_at),
				};
				return { ...current, messages: [...current.messages, message] };
			});
		};

		return () => source.close();
	}, [caseId, queryClient]);

	if (!data) return null;

	const {
		case: supportCase,
		org_name,
		customer_name,
		customer_email,
		messages,
		attachments,
	} = data;

	return (
		<div className="flex flex-col gap-6">
			{/* Header */}
			<div className="space-y-4">
				<Button
					asChild
					variant="ghost"
					size="sm"
					className="-ml-2 h-7 w-fit text-muted-foreground"
				>
					<Link href="/">
						<ArrowLeft className="size-4" />
						Cases
					</Link>
				</Button>

				<div className="flex flex-wrap items-start justify-between gap-4">
					<div className="min-w-0 space-y-2">
						<div className="flex items-center gap-2 font-mono text-xs text-muted-foreground">
							{caseLabel(supportCase.case_number)}
						</div>
						<h1 className="text-lg font-medium text-foreground">
							{supportCase.subject}
						</h1>
						<div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
							<CaseStatusBadge status={supportCase.status} />
							<CaseSeverityBadge severity={supportCase.severity} />
							<span>{SUPPORT_CASE_TYPE_LABELS[supportCase.type]}</span>
							<span aria-hidden>·</span>
							<span>{SUPPORT_CATEGORY_LABELS[supportCase.category]}</span>
							<span aria-hidden>·</span>
							<span>
								Opened{" "}
								{format(new Date(supportCase.created_at), "MMM d, yyyy")}
							</span>
						</div>
						<div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
							<span className="flex items-center gap-1">
								<Building2 className="size-3" />
								{org_name ?? "Personal"}
							</span>
							{(customer_name || customer_email) && (
								<span className="flex items-center gap-1">
									<Mail className="size-3" />
									{customer_name ?? customer_email}
									{customer_name && customer_email ? (
										<span className="text-muted-foreground/70">
											({customer_email})
										</span>
									) : null}
								</span>
							)}
						</div>
					</div>
					<StaffCaseActions
						caseId={caseId}
						status={supportCase.status}
						assignedStaffId={supportCase.assigned_staff_id}
						staffId={staffId}
					/>
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
				<StaffCaseThread messages={messages} />
			</div>

			{/* Composer */}
			<StaffCaseComposer
				caseId={caseId}
				caseNumber={supportCase.case_number}
				caseStatus={supportCase.status}
				customerName={customer_name}
				agentName={staffName}
				staffId={staffId}
			/>
		</div>
	);
}
