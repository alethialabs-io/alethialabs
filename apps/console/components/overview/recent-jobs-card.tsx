"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Overview Recent-jobs card — the newest provisioning jobs. Type label + duration come from
// lib/jobs/format (same source as the jobs table); status renders through StatusBadge.
//
// The read is the shell's job feed, `workspace.recentJobs` (`useRecentJobsQuery`: the newest jobs,
// capped and slim, #6114), which the `[org]` layout prefetches — so the card neither adds a read nor
// fetches on mount. Live through the `jobs` topic (lib/query/topics.ts): no poll. #6118 adds the
// distinct forbidden / failed / empty renders and the clock-after-hydration text.

import type { ReactNode } from "react";
import Link from "next/link";
import { Lock } from "lucide-react";
import { ProviderIcon } from "@repo/ui/provider-icon";
import { StatusBadge } from "@repo/ui/status-badge";
import { EmptyState } from "@repo/ui/empty";
import { Skeleton } from "@repo/ui/skeleton";
import { formatDuration, formatRelative } from "@repo/format";
import { RegionError } from "@/components/errors/region-error";
import { CARD_EMPTY } from "@/components/overview/card-empty";
import type { ProvisionJobStatus, ProvisionJobType } from "@/lib/db/schema/enums";
import { JOB_TYPES } from "@/lib/jobs/format";
import { globalHref } from "@/lib/routing";
import { useHydrated } from "@/hooks/use-hydrated";
import { useRecentJobsQuery } from "@/lib/query/use-jobs-query";
import { ClockSlot } from "./clock-slot";
import { isForbidden } from "./overview-reads";

const MAX_ROWS = 5;

/** The fields of a job row this card renders. */
interface RecentJob {
	id: string;
	status: ProvisionJobStatus;
	job_type: ProvisionJobType;
	project_name: string | null;
	cloud_provider: string | null;
	created_at: Date | string | null;
	completed_at: Date | string | null;
}

/**
 * A job's duration: elapsed for live jobs, total for finished, "—" otherwise. Reads the clock for a
 * live job, so it renders through `ClockSlot` (after hydration only).
 */
function jobDuration(job: RecentJob, now: number = Date.now()): string {
	if (!job.created_at) return "—";
	const start = new Date(job.created_at).getTime();
	if (!job.completed_at) {
		if (job.status === "PROCESSING" || job.status === "CLAIMED") {
			return formatDuration(now - start);
		}
		return "—";
	}
	return formatDuration(new Date(job.completed_at).getTime() - start);
}

/** The card's frame and header strip — shared by every render, the route skeleton included. */
function RecentJobsFrame({ orgSlug, children }: { orgSlug?: string; children: ReactNode }) {
	return (
		<section aria-label="Recent jobs" className="rounded-lg border bg-card shadow-sm">
			<div className="flex min-h-[50px] items-center gap-2 border-b px-4 py-2.5">
				<span className="font-display text-sm font-semibold">Recent jobs</span>
				{/* Describes what the card SHOWS: the newest MAX_ROWS jobs, whatever their age — not a
				    "last 24h" window, which an org whose last deploy was a month ago would read as five
				    failures today. A window would also empty the card for the orgs with least to show. */}
				<span className="font-mono text-ui-2xs text-muted-foreground">latest {MAX_ROWS}</span>
				{orgSlug ? (
					<Link
						href={globalHref(orgSlug, "jobs")}
						className="ml-auto font-mono text-ui-xs text-muted-foreground transition-colors hover:text-foreground"
					>
						All →
					</Link>
				) : null}
			</div>
			{children}
		</section>
	);
}

/** One job row's placeholder, at the row's real height. */
function JobSkeleton() {
	return (
		<div className="flex items-center gap-3 border-b border-border/60 px-4 py-3 last:border-b-0">
			<Skeleton className="size-7 shrink-0 rounded-sm" />
			<div className="flex min-w-0 flex-1 flex-col gap-1.5">
				<Skeleton className="h-3.5 w-32" />
				<Skeleton className="h-2.5 w-24" />
			</div>
			<div className="flex shrink-0 flex-col items-end gap-1.5">
				<Skeleton className="h-4 w-16 rounded-full" />
				<Skeleton className="h-2.5 w-20" />
			</div>
		</div>
	);
}

/** The card while its read is pending; the route's `loading.tsx` renders this too. */
export function RecentJobsCardSkeleton() {
	return (
		<RecentJobsFrame>
			<div aria-busy="true">
				<JobSkeleton />
				<JobSkeleton />
				<JobSkeleton />
			</div>
		</RecentJobsFrame>
	);
}

/** Latest provisioning jobs (last few) for the org. */
export function RecentJobsCard({ orgSlug }: { orgSlug: string }) {
	const jobs = useRecentJobsQuery();
	// THE SHELL READS THIS SAME QUERY (the bell, toasts, breadcrumbs, palette). The layout prefetches
	// it, so normally the server and the hydrating render both hold it. But if that prefetch failed,
	// the server rendered this card pending while the shell — which hydrates in an earlier pass —
	// may have fetched it by the time this card hydrates; drawing the rows then is React #418, and
	// React throws the page's server HTML away (#5786). So until hydration is over the card renders
	// exactly what the server could have: the pending frame. Rows follow one commit later, from the
	// cache, with no request.
	const hydrated = useHydrated();

	if (jobs.data === undefined || !hydrated) {
		if (!hydrated) return <RecentJobsCardSkeleton />;
		if (jobs.isError && isForbidden(jobs.error)) {
			return (
				<RecentJobsFrame orgSlug={orgSlug}>
					<EmptyState
						className={CARD_EMPTY}
						icon={<Lock />}
						title="You don't have access to jobs."
						description="Ask an organization admin for a role that can view jobs."
					/>
				</RecentJobsFrame>
			);
		}
		if (jobs.isError) {
			// A fetch failure must not read as "No jobs yet." — a different render, with a retry.
			return (
				<RecentJobsFrame orgSlug={orgSlug}>
					<RegionError
						title="Couldn't load recent jobs"
						description="Something went wrong loading this organization's jobs."
						onRetry={() => jobs.refetch()}
					/>
				</RecentJobsFrame>
			);
		}
		return <RecentJobsCardSkeleton />;
	}

	// The clock — a live job's elapsed time, every "3 minutes ago" — renders through `ClockSlot`,
	// which also waits for hydration, for a client mount that is not a hydration (a soft navigation).
	const recent = jobs.data.slice(0, MAX_ROWS);
	return (
		<RecentJobsFrame orgSlug={orgSlug}>
			{recent.length === 0 ? (
				<EmptyState className={CARD_EMPTY} title="No jobs yet." />
			) : (
				recent.map((job) => <RecentJobRow key={job.id} job={job} />)
			)}
		</RecentJobsFrame>
	);
}

/** One job: provider mark, project, type, status and timing. */
function RecentJobRow({ job }: { job: RecentJob }) {
	const action = JOB_TYPES[job.job_type]?.label ?? job.job_type;
	const createdAt = job.created_at;
	return (
		<div className="flex items-center gap-3 border-b border-border/60 px-4 py-3 transition-colors last:border-b-0 hover:bg-muted/40">
			<span className="grid size-7 shrink-0 place-items-center rounded-sm border bg-muted/40">
				{job.cloud_provider ? (
					<ProviderIcon provider={job.cloud_provider} size={14} />
				) : (
					<span className="font-mono text-ui-2xs text-muted-foreground">·</span>
				)}
			</span>
			<div className="flex min-w-0 flex-1 flex-col gap-0.5">
				<span className="truncate text-ui-md font-medium text-foreground">{job.project_name ?? "—"}</span>
				<span className="font-mono text-ui-2xs text-muted-foreground">{action} · OpenTofu</span>
			</div>
			<div className="flex shrink-0 flex-col items-end gap-1">
				<StatusBadge status={job.status} />
				<ClockSlot
					sizer="12m 30s · less than a minute ago"
					className="justify-items-end font-mono text-ui-2xs text-muted-foreground"
					render={() => `${jobDuration(job)}${createdAt ? ` · ${formatRelative(createdAt)}` : ""}`}
				/>
			</div>
		</div>
	);
}
