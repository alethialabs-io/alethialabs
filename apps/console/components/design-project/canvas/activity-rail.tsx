"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { cn } from "@repo/ui/utils";
import { getEnvironmentJobs } from "@/app/server/actions/canvas-jobs";
import { useEnvironmentStatus } from "@/lib/canvas/environment-status-context";
import { orgHref } from "@/lib/routing";
import { useActiveOrgSlug } from "@/lib/stores/use-workspace-store";
import type { NodeStatusMeta } from "@/lib/canvas/node-status";

/** A job's status → the same grayscale vocabulary the cards use. Status never reads as hue. */
const JOB_STATUS: Record<string, NodeStatusMeta["vx"]> = {
	QUEUED: "pending",
	CLAIMED: "pending",
	PROCESSING: "live",
	SUCCESS: "active",
	FAILED: "failed",
	CANCELLED: "disabled",
};

/** Job types, in the terse mono the board speaks. */
const JOB_LABEL: Record<string, string> = {
	PLAN: "Plan",
	DEPLOY: "Deploy",
	DESTROY: "Destroy",
	AUDIT: "Audit",
	DETECT_DRIFT: "Drift",
	PROBE_CLUSTER: "Probe",
	CHART_SCAN: "Chart scan",
	IAC_SCAN: "IaC scan",
	ANALYZE_REPO: "Repo scan",
};

/**
 * The environment's activity — what has run against this board, and what's running now.
 *
 * The canvas showed a deploy's effects but never the deploy. A failed component said "Failed" with
 * no route to the job that failed it; a running apply looked identical to a settled one until you
 * reloaded. This is the missing half.
 */
export function ActivityRail({
	projectId,
	environmentId,
}: {
	projectId: string;
	environmentId: string;
}) {
	const orgSlug = useActiveOrgSlug();
	const env = useEnvironmentStatus();

	const { data: jobs } = useQuery({
		queryKey: ["environment-jobs", projectId, environmentId],
		queryFn: () => getEnvironmentJobs(projectId, environmentId),
		// Follow the environment: fast while something is running, a slow heartbeat once it settles.
		refetchInterval: env.activeJob ? 4_000 : 30_000,
	});

	if (!jobs || jobs.length === 0) return null;

	return (
		<div className="pointer-events-auto absolute left-3 top-3 z-10 w-56 border border-border bg-card">
			<div className="flex items-center gap-2 border-b border-border px-2.5 py-1.5">
				<span className="vx-eyebrow">Activity</span>
				{env.activeJob && (
					<span className="vx-status vx-status--live ml-auto">
						<span className="vx-status__dot" />
						running
					</span>
				)}
			</div>

			<ul>
				{jobs.map((job) => {
					const vx = JOB_STATUS[job.status] ?? "idle";
					return (
						<li key={job.id}>
							<Link
								href={`${orgHref(orgSlug)}/~/jobs?job=${job.id}`}
								className="flex items-center gap-2 border-b border-border/60 px-2.5 py-1.5 transition-colors last:border-b-0 hover:bg-muted"
								// A failed job's reason is the most useful thing on this rail.
								title={job.error ?? job.status}
							>
								<span
									className={cn("vx-status shrink-0", `vx-status--${vx}`)}
									suppressHydrationWarning
								>
									<span className="vx-status__dot" />
								</span>
								<span className="min-w-0 flex-1 truncate font-mono text-[10px] uppercase tracking-wide">
									{JOB_LABEL[job.type] ?? job.type}
								</span>
								<span className="shrink-0 font-mono text-[9px] text-muted-foreground">
									{ago(job.createdAt)}
								</span>
							</Link>
						</li>
					);
				})}
			</ul>
		</div>
	);
}

/** Terse relative time — the rail has no room for a date, and "6 h" is what you actually want. */
function ago(iso: string): string {
	const seconds = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
	if (seconds < 60) return "now";
	const minutes = seconds / 60;
	if (minutes < 60) return `${Math.floor(minutes)} m`;
	const hours = minutes / 60;
	if (hours < 24) return `${Math.floor(hours)} h`;
	return `${Math.floor(hours / 24)} d`;
}
