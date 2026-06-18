"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only


import { getJob, getJobStatus, rerunJob, cancelJob } from "@/app/server/actions/jobs";
import { provisionVine } from "@/app/server/actions/vines";
import { useJobLogStream } from "@/hooks/use-job-log-stream";
import type { Job } from "@/lib/db/schema";
import { JOB_TYPES } from "@/components/jobs/columns";
import { TendrilSelectPopover } from "@/components/tendrils/tendril-select-popover";
import { StatusBadge } from "@/components/ui/status-badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
	AlertCircle,
	Ban,
	CheckCircle2,
	ChevronDown,
	Loader2,
	RefreshCw,
	Rocket,
	Terminal,
	XCircle,
} from "lucide-react";

import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { formatDistanceToNow } from "date-fns";

type JobState = "QUEUED" | "CLAIMED" | "PROCESSING" | "SUCCESS" | "FAILED" | "CANCELLED" | null;

/** Full-page job detail view with realtime log streaming (SSE). */
export default function JobDetailPage() {
	const { id: jobId } = useParams<{ id: string }>();
	const router = useRouter();

	const [job, setJob] = useState<Job | null>(null);
	const { logs } = useJobLogStream(jobId);
	const [jobState, setJobState] = useState<JobState>(null);
	const [jobError, setJobError] = useState<string | null>(null);
	const [isLoading, setIsLoading] = useState(true);
	const [actionLoading, setActionLoading] = useState(false);

	const bottomRef = useRef<HTMLDivElement>(null);
	const statusPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

	const scrollToBottom = useCallback(() => {
		setTimeout(() => bottomRef.current?.scrollIntoView({ behavior: "smooth" }), 100);
	}, []);

	const stopStatusPoll = useCallback(() => {
		if (statusPollRef.current) {
			clearInterval(statusPollRef.current);
			statusPollRef.current = null;
		}
	}, []);

	useEffect(() => {
		if (!jobId) return;

		getJob(jobId)
			.then((data) => {
				if (data) {
					setJob(data);
					setJobState(data.status);
					setJobError(data.error_message);
				}
				setIsLoading(false);
			})
			.catch(() => setIsLoading(false));
	}, [jobId]);

	// Auto-scroll as streamed logs (from useJobLogStream) arrive.
	useEffect(() => {
		if (logs.length > 0) scrollToBottom();
	}, [logs.length, scrollToBottom]);

	useEffect(() => {
		if (!jobId) return;

		statusPollRef.current = setInterval(async () => {
			const result = await getJobStatus(jobId);
			if (!result) return;
			setJobState(result.status);
			if (result.status === "FAILED" || result.status === "CANCELLED") {
				setJobError(result.error_message);
				stopStatusPoll();
			} else if (result.status === "SUCCESS") {
				stopStatusPoll();
			}
		}, 3000);

		return () => stopStatusPoll();
	}, [jobId, stopStatusPoll]);

	const handleRerun = async () => {
		if (!jobId) return;
		setActionLoading(true);
		try {
			const newJob = await rerunJob(jobId);
			toast.success("Job re-queued");
			router.push(`/dashboard/jobs/${newJob.id}`);
		} catch (err) {
			toast.error(err instanceof Error ? err.message : "Failed to re-run");
			setActionLoading(false);
		}
	};

	const handleCancel = async () => {
		if (!jobId) return;
		setActionLoading(true);
		try {
			await cancelJob(jobId);
			setJobState("CANCELLED");
			setJobError("Cancelled by user");
			stopStatusPoll();
			toast.success("Job cancelled");
		} catch (err) {
			toast.error(err instanceof Error ? err.message : "Failed to cancel");
		} finally {
			setActionLoading(false);
		}
	};

	const handleApply = async (workerId: string | null) => {
		if (!job?.spec_id || !jobId) return;
		setActionLoading(true);
		try {
			const { jobId: deployJobId } = await provisionVine(job.spec_id, jobId, workerId);
			toast.success("Deploy job created");
			router.push(`/dashboard/jobs/${deployJobId}`);
		} catch (err) {
			toast.error(err instanceof Error ? err.message : "Failed to apply");
			setActionLoading(false);
		}
	};

	const isActive = jobState === "QUEUED" || jobState === "CLAIMED" || jobState === "PROCESSING";
	const isTerminal = jobState === "SUCCESS" || jobState === "FAILED" || jobState === "CANCELLED";
	const isPlanSuccess = job?.job_type === "PLAN" && jobState === "SUCCESS";
	const info = job ? JOB_TYPES[job.job_type as keyof typeof JOB_TYPES] : null;
	const Icon = info?.icon;

	const duration = () => {
		if (!job?.created_at) return null;
		const end = job.completed_at ? new Date(job.completed_at) : new Date();
		const ms = end.getTime() - new Date(job.created_at).getTime();
		const seconds = Math.floor(ms / 1000);
		if (seconds < 60) return `${seconds}s`;
		const minutes = Math.floor(seconds / 60);
		return `${minutes}m ${seconds % 60}s`;
	};

	if (isLoading) {
		return (
			<div className="flex items-center justify-center h-full min-h-[50vh]">
				<Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
			</div>
		);
	}

	if (!job) {
		return (
			<div className="space-y-4">
				<p className="text-muted-foreground text-sm">Job not found.</p>
			</div>
		);
	}

	return (
		<div className="flex flex-col h-[calc(100vh-3.5rem)] -m-4 sm:-m-6 lg:-m-8 xl:-m-10">
			{/* Header */}
			<div className="px-6 py-4 border-b border-border/40 bg-muted/5 shrink-0">
				<div className="flex items-center justify-between">
					<div className="flex items-center gap-3">
						{Icon && <Icon className="h-5 w-5 text-muted-foreground" />}
						<div>
							<div className="flex items-center gap-2">
								<h1 className="text-base font-semibold">{info?.label ?? job.job_type}</h1>
								<StatusBadge status={jobState ?? job.status} />
								{duration() && <span className="text-xs text-muted-foreground">{duration()}</span>}
							</div>
							<p className="text-xs text-muted-foreground">
								<span className="font-mono">{job.id.slice(0, 8)}</span>
								{job.runner_id && <> · Worker <span className="font-mono">{job.runner_id.slice(0, 8)}</span></>}
								{job.created_at && <> · {formatDistanceToNow(new Date(job.created_at), { addSuffix: true })}</>}
							</p>
						</div>
					</div>
					<div className="flex items-center gap-2">
						{isActive && (
							<Button variant="outline" size="sm" className="h-8 text-xs text-destructive hover:text-destructive" onClick={handleCancel} disabled={actionLoading}>
								{actionLoading ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <Ban className="h-3.5 w-3.5 mr-1.5" />}
								Cancel
							</Button>
						)}
						{isPlanSuccess && job.spec_id && (
							<TendrilSelectPopover
								trigger={
									<Button size="sm" className="h-8 text-xs" disabled={actionLoading}>
										<Rocket className="h-3.5 w-3.5 mr-1.5" />
										Apply
									</Button>
								}
								onConfirm={handleApply}
								disabled={actionLoading}
							/>
						)}
						{isTerminal && (
							<Button variant="outline" size="sm" className="h-8 text-xs" onClick={handleRerun} disabled={actionLoading}>
								{actionLoading ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5 mr-1.5" />}
								Re-run
							</Button>
						)}
					</div>
				</div>
			</div>

			{/* Log Area */}
			<div className="flex-1 overflow-hidden font-mono text-xs bg-muted/20">
				<ScrollArea className="h-full w-full p-6">
					{logs.length === 0 && isActive ? (
						<div className="flex flex-col items-center justify-center text-muted-foreground py-20">
							<Loader2 className="w-8 h-8 mb-4 animate-spin opacity-30" />
							<p className="text-sm">Waiting for worker to claim job...</p>
							<p className="text-[11px] mt-2 text-muted-foreground/60">
								The worker polls every 10 seconds. Logs will appear here automatically.
							</p>
						</div>
					) : logs.length === 0 ? (
						<div className="flex flex-col items-center justify-center text-muted-foreground py-20">
							<Terminal className="w-12 h-12 mb-4 opacity-20" />
							<p className="text-sm">No logs recorded for this job.</p>
						</div>
					) : (
						<div className="space-y-0 pb-10">
							{logs.map((log, i) => (
								<div
									key={`${log.id}-${i}`}
									className="flex gap-4 group hover:bg-muted/40 px-2 py-0.5 rounded transition-colors"
								>
									<span className="text-muted-foreground/40 select-none shrink-0 w-8 text-right">{i + 1}</span>
									<span className="text-muted-foreground/60 select-none shrink-0 w-[85px]">
										{new Date(log.created_at || Date.now()).toLocaleTimeString([], { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" })}
									</span>
									<span className={`break-all leading-relaxed ${log.stream_type === "STDERR" || log.stream_type === "stderr" ? "text-destructive" : "text-foreground/80"}`}>
										{log.log_chunk}
									</span>
								</div>
							))}
							<div ref={bottomRef} />
							{isActive && logs.length > 0 && (
								<div className="flex gap-4 mt-2 px-2">
									<span className="w-8" /><span className="w-[85px]" />
									<span className="w-2 h-4 bg-muted-foreground/30 animate-pulse block" />
								</div>
							)}
						</div>
					)}
				</ScrollArea>
			</div>

			{/* Status Footer */}
			{jobState === "SUCCESS" && (
				<div className="px-6 py-3 border-t border-border bg-muted/50 flex items-center gap-3 shrink-0">
					<CheckCircle2 className="w-4 h-4 text-foreground shrink-0" />
					<p className="text-sm text-foreground">Job completed successfully.</p>
				</div>
			)}
			{jobState === "FAILED" && (
				<div className="px-6 py-3 border-t border-border bg-destructive/5 shrink-0">
					<div className="flex items-center gap-2">
						<XCircle className="w-4 h-4 text-destructive shrink-0" />
						<p className="text-sm font-medium text-foreground">Job failed</p>
					</div>
					{jobError && <p className="text-xs text-muted-foreground ml-6 mt-1 break-all">{jobError}</p>}
				</div>
			)}
			{jobState === "CANCELLED" && (
				<div className="px-6 py-3 border-t border-border bg-muted/10 shrink-0">
					<div className="flex items-center gap-2">
						<Ban className="w-4 h-4 text-muted-foreground shrink-0" />
						<p className="text-sm font-medium text-foreground">Job cancelled</p>
					</div>
					{jobError && <p className="text-xs text-muted-foreground ml-6 mt-1 break-all">{jobError}</p>}
				</div>
			)}

			{/* Collapsible Details / Config / Metadata */}
			<div className="border-t border-border/40 shrink-0">
				<Collapsible>
					<CollapsibleTrigger className="flex items-center gap-2 w-full px-6 py-2.5 text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-muted/30 transition-colors">
						<ChevronDown className="h-3 w-3" />
						Job Details
					</CollapsibleTrigger>
					<CollapsibleContent className="px-6 pb-4">
						<div className="grid grid-cols-2 md:grid-cols-3 gap-3 text-xs">
							<div>
								<p className="text-[11px] text-muted-foreground">Job ID</p>
								<p className="font-mono truncate">{job.id}</p>
							</div>
							<div>
								<p className="text-[11px] text-muted-foreground">Type</p>
								<p>{info?.label ?? job.job_type}</p>
							</div>
							<div>
								<p className="text-[11px] text-muted-foreground">Worker</p>
								<p className="font-mono">{job.runner_id ?? "—"}</p>
							</div>
							<div>
								<p className="text-[11px] text-muted-foreground">Created</p>
								<p>{job.created_at ? new Date(job.created_at).toLocaleString() : "—"}</p>
							</div>
							<div>
								<p className="text-[11px] text-muted-foreground">Started</p>
								<p>{job.started_at ? new Date(job.started_at).toLocaleString() : "—"}</p>
							</div>
							<div>
								<p className="text-[11px] text-muted-foreground">Completed</p>
								<p>{job.completed_at ? new Date(job.completed_at).toLocaleString() : "—"}</p>
							</div>
							{job.spec_id && (
								<div>
									<p className="text-[11px] text-muted-foreground">Spec</p>
									<p className="font-mono truncate">{job.spec_id}</p>
								</div>
							)}
						</div>
					</CollapsibleContent>
				</Collapsible>

				{Object.keys(job.config_snapshot || {}).length > 0 && (
					<Collapsible>
						<CollapsibleTrigger className="flex items-center gap-2 w-full px-6 py-2.5 text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-muted/30 transition-colors">
							<ChevronDown className="h-3 w-3" />
							Config Snapshot
						</CollapsibleTrigger>
						<CollapsibleContent className="px-6 pb-4">
							<pre className="text-[11px] text-muted-foreground bg-muted/30 border rounded-md p-3 whitespace-pre-wrap break-words max-h-64 overflow-y-auto font-mono">
								{JSON.stringify(job.config_snapshot, null, 2)}
							</pre>
						</CollapsibleContent>
					</Collapsible>
				)}
				{job.execution_metadata && Object.keys(job.execution_metadata).length > 0 && (
					<Collapsible>
						<CollapsibleTrigger className="flex items-center gap-2 w-full px-6 py-2.5 text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-muted/30 transition-colors">
							<ChevronDown className="h-3 w-3" />
							Execution Metadata
						</CollapsibleTrigger>
						<CollapsibleContent className="px-6 pb-4">
							<pre className="text-[11px] text-muted-foreground bg-muted/30 border rounded-md p-3 whitespace-pre-wrap break-words max-h-64 overflow-y-auto font-mono">
								{JSON.stringify(job.execution_metadata, null, 2)}
							</pre>
						</CollapsibleContent>
					</Collapsible>
				)}
			</div>
		</div>
	);
}
