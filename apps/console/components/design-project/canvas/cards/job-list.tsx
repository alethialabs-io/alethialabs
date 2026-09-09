"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import Link from "next/link";
import { StatusBadge } from "@repo/ui/status-badge";
import type { EnvironmentJob } from "@/lib/canvas/component-status";
import { ago, JOB_LABEL, JOB_STATUS } from "@/lib/canvas/job-display";

/**
 * A list of jobs in the board's grayscale job vocabulary — status dot · type · age — shared by the
 * activity card and the inspector's Overview. Each row links to the job in the Jobs view when
 * `jobHref` is given, and carries the failure message as its title, because a failed job's reason
 * is the most useful thing on the list.
 */
export function JobList({
	jobs,
	jobHref,
}: {
	jobs: Array<EnvironmentJob & { error?: string | null }>;
	/** Builds the row's link target from the job id; omit for a plain (non-navigating) list. */
	jobHref?: (id: string) => string;
}) {
	return (
		<ul className="space-y-1">
			{jobs.map((job) => {
				const vx = JOB_STATUS[job.status] ?? "idle";
				const row = (
					<>
						<StatusBadge
							status={job.status}
							tier={vx}
							showLabel={false}
							className="shrink-0"
							suppressHydrationWarning
						/>
						<span className="min-w-0 flex-1 truncate font-mono text-ui-2xs uppercase tracking-wide">
							{JOB_LABEL[job.type] ?? job.type}
						</span>
						<span className="shrink-0 font-mono text-ui-3xs text-muted-foreground">
							{ago(job.createdAt)}
						</span>
					</>
				);
				const className =
					"flex items-center gap-2 border border-border bg-surface-sunken px-2.5 py-1.5";
				return (
					<li key={job.id}>
						{jobHref ? (
							<Link
								href={jobHref(job.id)}
								className={`${className} transition-colors hover:bg-muted`}
								title={job.error ?? job.status}
							>
								{row}
							</Link>
						) : (
							<div className={className} title={job.error ?? job.status}>
								{row}
							</div>
						)}
					</li>
				);
			})}
		</ul>
	);
}
