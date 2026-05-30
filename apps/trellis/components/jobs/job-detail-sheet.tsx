"use client";

import { rerunJob } from "@/app/server/actions/jobs";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetHeader,
	SheetTitle,
} from "@/components/ui/sheet";
import { JOB_TYPES, STATUS_STYLES } from "./columns";
import { Loader2, RefreshCw } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

interface JobDetailSheetProps {
	job: {
		id: string;
		job_type: string;
		status: string;
		vine_id: string | null;
		worker_id: string | null;
		cloud_identity_id: string | null;
		created_at: string | null;
		started_at: string | null;
		completed_at: string | null;
		error_message: string | null;
		config_snapshot: Record<string, unknown> | null;
		execution_metadata: Record<string, unknown> | null;
	} | null;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onRerun?: () => void;
}

export function JobDetailSheet({
	job,
	open,
	onOpenChange,
	onRerun,
}: JobDetailSheetProps) {
	const [rerunning, setRerunning] = useState(false);

	if (!job) return null;

	const info = JOB_TYPES[job.job_type];
	const Icon = info?.icon;

	const handleRerun = async () => {
		setRerunning(true);
		try {
			await rerunJob(job.id);
			toast.success("Job re-queued successfully");
			onOpenChange(false);
			onRerun?.();
		} catch (err) {
			toast.error(
				err instanceof Error ? err.message : "Failed to re-run job",
			);
		} finally {
			setRerunning(false);
		}
	};

	const formatDate = (d: string | null) => {
		if (!d) return "—";
		return new Date(d).toLocaleString();
	};

	const duration = () => {
		if (!job.created_at || !job.completed_at) return null;
		const ms =
			new Date(job.completed_at).getTime() -
			new Date(job.created_at).getTime();
		const seconds = Math.floor(ms / 1000);
		if (seconds < 60) return `${seconds}s`;
		const minutes = Math.floor(seconds / 60);
		return `${minutes}m ${seconds % 60}s`;
	};

	return (
		<Sheet open={open} onOpenChange={onOpenChange}>
			<SheetContent
				side="right"
				className="w-full sm:max-w-lg overflow-y-auto p-0"
			>
				<SheetHeader className="px-6 pt-6 pb-4 border-b border-border/40">
					<div className="flex items-center justify-between">
						<div className="flex items-center gap-3">
							{Icon && (
								<Icon className="h-5 w-5 text-muted-foreground" />
							)}
							<div>
								<SheetTitle className="text-base">
									{info?.label ?? job.job_type}
								</SheetTitle>
								<SheetDescription className="text-xs">
									{info?.description ?? "Job execution"}
								</SheetDescription>
							</div>
						</div>
						<Button
							variant="outline"
							size="sm"
							className="h-8 text-xs"
							onClick={handleRerun}
							disabled={rerunning}
						>
							{rerunning ? (
								<Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
							) : (
								<RefreshCw className="h-3.5 w-3.5 mr-1.5" />
							)}
							Re-run
						</Button>
					</div>
				</SheetHeader>

				<div className="px-6 py-5 space-y-5">
					{/* Status */}
					<div className="flex items-center gap-2">
						<Badge
							variant="outline"
							className={`text-xs ${STATUS_STYLES[job.status] ?? ""}`}
						>
							{job.status}
						</Badge>
						{duration() && (
							<span className="text-xs text-muted-foreground">
								{duration()}
							</span>
						)}
					</div>

					{/* Details grid */}
					<div className="space-y-3">
						<h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
							Details
						</h3>
						<div className="grid grid-cols-2 gap-3">
							<div>
								<p className="text-[11px] text-muted-foreground">
									Job ID
								</p>
								<p className="text-xs font-mono truncate">
									{job.id}
								</p>
							</div>
							<div>
								<p className="text-[11px] text-muted-foreground">
									Worker
								</p>
								<p className="text-xs font-mono">
									{job.worker_id?.slice(0, 12) ?? "—"}
								</p>
							</div>
							<div>
								<p className="text-[11px] text-muted-foreground">
									Created
								</p>
								<p className="text-xs">
									{formatDate(job.created_at)}
								</p>
							</div>
							<div>
								<p className="text-[11px] text-muted-foreground">
									Started
								</p>
								<p className="text-xs">
									{formatDate(job.started_at)}
								</p>
							</div>
							<div>
								<p className="text-[11px] text-muted-foreground">
									Completed
								</p>
								<p className="text-xs">
									{formatDate(job.completed_at)}
								</p>
							</div>
							{job.vine_id && (
								<div>
									<p className="text-[11px] text-muted-foreground">
										Vine
									</p>
									<p className="text-xs font-mono truncate">
										{job.vine_id}
									</p>
								</div>
							)}
						</div>
					</div>

					{/* Error */}
					{job.error_message && (
						<>
							<Separator />
							<div className="space-y-2">
								<h3 className="text-xs font-semibold uppercase tracking-wider text-destructive">
									Error
								</h3>
								<pre className="text-xs text-destructive bg-destructive/5 border border-destructive/20 rounded-md p-3 whitespace-pre-wrap break-words max-h-48 overflow-y-auto">
									{job.error_message}
								</pre>
							</div>
						</>
					)}

					{/* Config Snapshot */}
					{job.config_snapshot &&
						Object.keys(
							job.config_snapshot as Record<string, unknown>,
						).length > 0 && (
							<>
								<Separator />
								<div className="space-y-2">
									<h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
										Config Snapshot
									</h3>
									<pre className="text-[11px] text-muted-foreground bg-muted/30 border rounded-md p-3 whitespace-pre-wrap break-words max-h-64 overflow-y-auto font-mono">
										{JSON.stringify(
											job.config_snapshot,
											null,
											2,
										)}
									</pre>
								</div>
							</>
						)}

					{/* Execution Metadata */}
					{job.execution_metadata &&
						Object.keys(
							job.execution_metadata as Record<string, unknown>,
						).length > 0 && (
							<>
								<Separator />
								<div className="space-y-2">
									<h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
										Execution Metadata
									</h3>
									<pre className="text-[11px] text-muted-foreground bg-muted/30 border rounded-md p-3 whitespace-pre-wrap break-words max-h-64 overflow-y-auto font-mono">
										{JSON.stringify(
											job.execution_metadata,
											null,
											2,
										)}
									</pre>
								</div>
							</>
						)}
				</div>
			</SheetContent>
		</Sheet>
	);
}
