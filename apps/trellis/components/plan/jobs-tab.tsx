"use client";

import { useEffect, useState } from "react";
import { getVineJobs } from "@/app/server/actions/jobs";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { formatDistanceToNow } from "date-fns";
import { Clock, ExternalLink } from "lucide-react";

interface Job {
	id: string;
	job_type: string;
	status: string;
	created_at: string;
	started_at: string | null;
	completed_at: string | null;
	error_message: string | null;
}

const STATUS_STYLES: Record<string, string> = {
	QUEUED: "border-blue-500/50 bg-blue-500/10 text-blue-700 dark:text-blue-400",
	CLAIMED: "border-blue-500/50 bg-blue-500/10 text-blue-700 dark:text-blue-400",
	PROCESSING:
		"border-amber-500/50 bg-amber-500/10 text-amber-700 dark:text-amber-400",
	SUCCESS:
		"border-emerald-500/50 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
	FAILED: "border-red-500/50 bg-red-500/10 text-red-700 dark:text-red-400",
	CANCELLED:
		"border-muted-foreground/50 bg-muted text-muted-foreground",
};

const TYPE_LABELS: Record<string, string> = {
	PLAN: "Plan",
	DEPLOY: "Deploy",
	DESTROY: "Destroy",
	BOOTSTRAP: "Bootstrap",
	CONNECTION_TEST: "Connection Test",
	FETCH_RESOURCES: "Fetch Resources",
};

function getDuration(job: Job): string | null {
	if (!job.started_at) return null;
	const start = new Date(job.started_at);
	const end = job.completed_at ? new Date(job.completed_at) : new Date();
	const seconds = Math.round((end.getTime() - start.getTime()) / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	const remaining = seconds % 60;
	return `${minutes}m ${remaining}s`;
}

interface JobsTabProps {
	vineId: string;
	onSelectJob: (jobId: string) => void;
}

export function JobsTab({ vineId, onSelectJob }: JobsTabProps) {
	const [jobs, setJobs] = useState<Job[]>([]);
	const [loading, setLoading] = useState(true);

	useEffect(() => {
		let cancelled = false;
		async function load() {
			try {
				const data = await getVineJobs(vineId);
				if (!cancelled) setJobs(data as Job[]);
			} catch {
				// ignore
			} finally {
				if (!cancelled) setLoading(false);
			}
		}
		load();
		return () => {
			cancelled = true;
		};
	}, [vineId]);

	if (loading) {
		return (
			<div className="space-y-3">
				{Array.from({ length: 3 }).map((_, i) => (
					<Skeleton key={i} className="h-16 w-full" />
				))}
			</div>
		);
	}

	if (jobs.length === 0) {
		return (
			<div className="flex flex-col items-center justify-center py-16 gap-2">
				<Clock className="h-8 w-8 text-muted-foreground" />
				<p className="text-sm text-muted-foreground">
					No jobs yet for this vine.
				</p>
			</div>
		);
	}

	return (
		<div className="divide-y rounded-md border">
			{jobs.map((job) => {
				const duration = getDuration(job);
				return (
					<button
						key={job.id}
						type="button"
						onClick={() => onSelectJob(job.id)}
						className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-accent/50"
					>
						<div className="flex-1 min-w-0 space-y-1">
							<div className="flex items-center gap-2">
								<Badge variant="outline" className="text-[10px]">
									{TYPE_LABELS[job.job_type] || job.job_type}
								</Badge>
								<Badge
									variant="outline"
									className={`text-[10px] ${STATUS_STYLES[job.status] || ""}`}
								>
									{job.status}
								</Badge>
								{duration && (
									<span className="text-[10px] text-muted-foreground">
										{duration}
									</span>
								)}
							</div>
							<div className="flex items-center gap-2 text-xs text-muted-foreground">
								<span className="font-mono">
									{job.id.slice(0, 8)}
								</span>
								<span>
									{formatDistanceToNow(
										new Date(job.created_at),
										{ addSuffix: true },
									)}
								</span>
							</div>
							{job.error_message && (
								<p className="text-xs text-red-500 truncate">
									{job.error_message}
								</p>
							)}
						</div>
						<ExternalLink className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
					</button>
				);
			})}
		</div>
	);
}
