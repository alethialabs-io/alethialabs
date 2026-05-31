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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PublicProvisionJobsRow } from "@/lib/validations/db.schemas";
import { LogViewer } from "@/components/clusters/log-viewer";
import { FileText, Info, Loader2, RefreshCw, Settings } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { JOB_TYPES, STATUS_STYLES } from "./columns";

interface JobDetailSheetProps {
	job: PublicProvisionJobsRow | null;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onRerun?: () => void;
}

/** Expanded job detail sheet with Overview, Logs, and Config tabs. */
export function JobDetailSheet({
	job,
	open,
	onOpenChange,
	onRerun,
}: JobDetailSheetProps) {
	const [rerunning, setRerunning] = useState(false);
	const [activeTab, setActiveTab] = useState("overview");
	const [logViewerOpen, setLogViewerOpen] = useState(false);

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
		if (!job.created_at) return null;
		const end = job.completed_at ? new Date(job.completed_at) : new Date();
		const ms = end.getTime() - new Date(job.created_at).getTime();
		const seconds = Math.floor(ms / 1000);
		if (seconds < 60) return `${seconds}s`;
		const minutes = Math.floor(seconds / 60);
		return `${minutes}m ${seconds % 60}s`;
	};

	const isRunning = job.status === "PROCESSING" || job.status === "CLAIMED" || job.status === "QUEUED";

	return (
		<Sheet open={open} onOpenChange={(o) => { onOpenChange(o); if (!o) setActiveTab("overview"); }}>
			<SheetContent
				side="right"
				className="w-full sm:max-w-4xl overflow-hidden p-0 flex flex-col"
			>
				<SheetHeader className="px-6 pt-6 pb-4 border-b border-border/40 shrink-0">
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
					</div>
				</SheetHeader>

				<Tabs value={activeTab} onValueChange={setActiveTab} className="flex-1 flex flex-col overflow-hidden">
					<TabsList className="w-full justify-start border-b border-border/40 bg-transparent p-0 h-auto gap-0 rounded-none shrink-0 px-6">
						<TabsTrigger
							value="overview"
							className="rounded-none border-b-2 border-transparent data-[state=active]:border-foreground data-[state=active]:bg-transparent px-4 py-2.5 text-xs"
						>
							<Info className="h-3.5 w-3.5 mr-1.5" />
							Overview
						</TabsTrigger>
						<TabsTrigger
							value="logs"
							className="rounded-none border-b-2 border-transparent data-[state=active]:border-foreground data-[state=active]:bg-transparent px-4 py-2.5 text-xs"
						>
							<FileText className="h-3.5 w-3.5 mr-1.5" />
							Logs
							{isRunning && <span className="ml-1.5 h-2 w-2 rounded-full bg-blue-500 animate-pulse" />}
						</TabsTrigger>
						<TabsTrigger
							value="config"
							className="rounded-none border-b-2 border-transparent data-[state=active]:border-foreground data-[state=active]:bg-transparent px-4 py-2.5 text-xs"
						>
							<Settings className="h-3.5 w-3.5 mr-1.5" />
							Config
						</TabsTrigger>
					</TabsList>

					{/* Overview Tab */}
					<TabsContent value="overview" className="mt-0 flex-1 overflow-y-auto p-6 space-y-5">
						{/* Details grid */}
						<div className="space-y-3">
							<h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
								Details
							</h3>
							<div className="grid grid-cols-2 md:grid-cols-3 gap-3">
								<div>
									<p className="text-[11px] text-muted-foreground">Job ID</p>
									<p className="text-xs font-mono truncate">{job.id}</p>
								</div>
								<div>
									<p className="text-[11px] text-muted-foreground">Worker</p>
									<p className="text-xs font-mono">{job.worker_id?.slice(0, 12) ?? "—"}</p>
								</div>
								<div>
									<p className="text-[11px] text-muted-foreground">Type</p>
									<p className="text-xs">{info?.label ?? job.job_type}</p>
								</div>
								<div>
									<p className="text-[11px] text-muted-foreground">Created</p>
									<p className="text-xs">{formatDate(job.created_at)}</p>
								</div>
								<div>
									<p className="text-[11px] text-muted-foreground">Started</p>
									<p className="text-xs">{formatDate(job.started_at)}</p>
								</div>
								<div>
									<p className="text-[11px] text-muted-foreground">Completed</p>
									<p className="text-xs">{formatDate(job.completed_at)}</p>
								</div>
								{job.vine_id && (
									<div>
										<p className="text-[11px] text-muted-foreground">Vine</p>
										<p className="text-xs font-mono truncate">{job.vine_id}</p>
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
									<pre className="text-xs text-destructive bg-destructive/5 border border-destructive/20 rounded-md p-3 whitespace-pre-wrap break-words overflow-y-auto max-h-64">
										{job.error_message}
									</pre>
								</div>
							</>
						)}
					</TabsContent>

					{/* Logs Tab */}
					<TabsContent value="logs" className="mt-0 flex-1 overflow-y-auto p-6">
						<div className="flex flex-col items-center justify-center py-8 text-center">
							<FileText className="h-8 w-8 text-muted-foreground mb-3 opacity-30" />
							<p className="text-sm text-foreground mb-1">Execution Logs</p>
							<p className="text-xs text-muted-foreground mb-4">
								{isRunning ? "View live streaming output from the worker." : "View the full execution log for this job."}
							</p>
							<Button
								variant="outline"
								size="sm"
								className="text-xs"
								onClick={() => setLogViewerOpen(true)}
							>
								<FileText className="h-3.5 w-3.5 mr-1.5" />
								{isRunning ? "Open Live Logs" : "View Logs"}
							</Button>
						</div>
						<LogViewer
							jobId={job.id}
							open={logViewerOpen}
							onOpenChange={setLogViewerOpen}
						/>
					</TabsContent>

					{/* Config Tab */}
					<TabsContent value="config" className="mt-0 flex-1 overflow-y-auto p-6 space-y-5">
						{job.config_snapshot &&
							Object.keys(job.config_snapshot).length > 0 && (
								<div className="space-y-2">
									<h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
										Config Snapshot
									</h3>
									<pre className="text-[11px] text-muted-foreground bg-muted/30 border rounded-md p-3 whitespace-pre-wrap break-words overflow-y-auto font-mono">
										{JSON.stringify(job.config_snapshot, null, 2)}
									</pre>
								</div>
							)}

						{job.execution_metadata &&
							Object.keys(job.execution_metadata).length > 0 && (
								<div className="space-y-2">
									<h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
										Execution Metadata
									</h3>
									<pre className="text-[11px] text-muted-foreground bg-muted/30 border rounded-md p-3 whitespace-pre-wrap break-words overflow-y-auto font-mono">
										{JSON.stringify(job.execution_metadata, null, 2)}
									</pre>
								</div>
							)}

						{(!job.config_snapshot || Object.keys(job.config_snapshot).length === 0) &&
							(!job.execution_metadata || Object.keys(job.execution_metadata).length === 0) && (
								<div className="text-center py-12 text-muted-foreground">
									<Settings className="h-8 w-8 mx-auto mb-2 opacity-20" />
									<p className="text-sm">No configuration data.</p>
								</div>
							)}
					</TabsContent>
				</Tabs>
			</SheetContent>
		</Sheet>
	);
}
