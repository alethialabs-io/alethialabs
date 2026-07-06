"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Overview Recent-jobs card — the latest provisioning jobs from the shared jobs store.
// Type label + duration come from lib/jobs/format (same source as the jobs table); status
// renders through StatusBadge.

import Link from "next/link";
import { formatDistanceToNow } from "date-fns";
import { ProviderIcon } from "@repo/ui/provider-icon";
import { StatusBadge } from "@repo/ui/status-badge";
import { Skeleton } from "@repo/ui/skeleton";
import type { JobWithMeta } from "@/app/server/actions/jobs";
import { JOB_TYPES, formatDuration } from "@/lib/jobs/format";
import { globalHref } from "@/lib/routing";
import { useJobsQuery } from "@/lib/query/use-jobs-query";

const MAX_ROWS = 5;

/** Renders a job's duration: elapsed for live jobs, total for finished, "—" otherwise. */
function jobDuration(job: JobWithMeta): string {
	if (!job.created_at) return "—";
	const start = new Date(job.created_at).getTime();
	if (!job.completed_at) {
		if (job.status === "PROCESSING" || job.status === "CLAIMED") {
			return formatDuration(Date.now() - start);
		}
		return "—";
	}
	return formatDuration(new Date(job.completed_at).getTime() - start);
}

/** Latest provisioning jobs (last few) for the org. */
export function RecentJobsCard({ orgSlug }: { orgSlug: string }) {
	const { data: jobs = [], isPending } = useJobsQuery();

	const recent = jobs.slice(0, MAX_ROWS);
	const loading = isPending;

	return (
		<div className="rounded-lg border bg-card shadow-sm">
			<div className="flex min-h-[50px] items-center gap-2 border-b px-4 py-2.5">
				<span className="font-display text-sm font-semibold">Recent jobs</span>
				<span className="font-mono text-[10px] text-muted-foreground">
					last 24h
				</span>
				<Link
					href={globalHref(orgSlug, "jobs")}
					className="ml-auto font-mono text-[11px] text-muted-foreground transition-colors hover:text-foreground"
				>
					All →
				</Link>
			</div>

			{loading ? (
				<div className="space-y-2 p-4">
					{[0, 1, 2].map((i) => (
						<Skeleton key={i} className="h-10 w-full rounded-md" />
					))}
				</div>
			) : recent.length === 0 ? (
				<p className="px-4 py-8 text-center font-mono text-xs text-muted-foreground">
					No jobs yet.
				</p>
			) : (
				recent.map((job) => {
					const action = JOB_TYPES[job.job_type]?.label ?? job.job_type;
					return (
						<div
							key={job.id}
							className="flex items-center gap-3 border-b border-border/60 px-4 py-3 transition-colors last:border-b-0 hover:bg-muted/40"
						>
							<span className="grid size-7 shrink-0 place-items-center rounded-sm border bg-muted/40">
								{job.cloud_provider ? (
									<ProviderIcon provider={job.cloud_provider} size={14} />
								) : (
									<span className="font-mono text-[10px] text-muted-foreground">
										·
									</span>
								)}
							</span>
							<div className="flex min-w-0 flex-1 flex-col gap-0.5">
								<span className="truncate text-[13px] font-medium text-foreground">
									{job.project_name ?? "—"}
								</span>
								<span className="font-mono text-[10px] text-muted-foreground">
									{action} · OpenTofu
								</span>
							</div>
							<div className="flex shrink-0 flex-col items-end gap-1">
								<StatusBadge status={job.status} />
								<span className="font-mono text-[10px] text-muted-foreground">
									{jobDuration(job)}
									{job.created_at
										? ` · ${formatDistanceToNow(new Date(job.created_at), { addSuffix: true })}`
										: ""}
								</span>
							</div>
						</div>
					);
				})
			)}
		</div>
	);
}
