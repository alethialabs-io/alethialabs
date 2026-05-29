"use client";

import { getJobStatus } from "@/app/server/actions/jobs";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetHeader,
	SheetTitle,
} from "@/components/ui/sheet";
import { createClient } from "@/lib/supabase/client";
import {
	AlertCircle,
	CheckCircle2,
	Loader2,
	Play,
	RefreshCw,
	Terminal,
	XCircle,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

interface LogViewerProps {
	clusterId?: string | null;
	clusterName?: string;
	jobId?: string | null;
	open: boolean;
	onOpenChange: (open: boolean) => void;
}

interface LogEntry {
	id: number;
	created_at: string;
	log_chunk: string;
	stream_type: string | null;
}

type JobState = "QUEUED" | "CLAIMED" | "PROCESSING" | "SUCCESS" | "FAILED" | null;
type JobError = string | null;

export function LogViewer({
	clusterId,
	clusterName,
	jobId: externalJobId,
	open,
	onOpenChange,
}: LogViewerProps) {
	const [logs, setLogs] = useState<LogEntry[]>([]);
	const [isLoading, setIsLoading] = useState(false);
	const [jobState, setJobState] = useState<JobState>(null);
	const [jobError, setJobError] = useState<JobError>(null);
	const [provisionId, setProvisionId] = useState<string | null>(null);
	const scrollRef = useRef<HTMLDivElement>(null);
	const supabase = createClient();
	const bottomRef = useRef<HTMLDivElement>(null);
	const statusPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

	const scrollToBottom = useCallback(() => {
		setTimeout(() => {
			bottomRef.current?.scrollIntoView({ behavior: "smooth" });
		}, 100);
	}, []);

	const stopStatusPoll = useCallback(() => {
		if (statusPollRef.current) {
			clearInterval(statusPollRef.current);
			statusPollRef.current = null;
		}
	}, []);

	useEffect(() => {
		if (open && externalJobId) {
			setProvisionId(externalJobId);
			setJobState("QUEUED");
			setLogs([]);
			fetchLogsForJob(externalJobId);
			startStatusPoll(externalJobId);
		} else if (open && clusterId) {
			fetchLatestHarvest();
		} else {
			setLogs([]);
			setProvisionId(null);
			setJobState(null);
			setJobError(null);
			stopStatusPoll();
		}

		return () => stopStatusPoll();
	}, [open, clusterId, externalJobId]);

	useEffect(() => {
		if (!provisionId) return;

		const useJobLogs = !!externalJobId;
		const table = useJobLogs ? "job_logs" : "provision_logs";
		const filterCol = useJobLogs ? "job_id" : "provision_id";

		const channel = supabase
			.channel(`${table}:${provisionId}`)
			.on(
				"postgres_changes",
				{
					event: "INSERT",
					schema: "public",
					table,
					filter: `${filterCol}=eq.${provisionId}`,
				},
				(payload) => {
					const newLog = payload.new as LogEntry;
					setLogs((prev) => [...prev, newLog]);
					scrollToBottom();
				},
			)
			.subscribe();

		return () => {
			supabase.removeChannel(channel);
		};
	}, [provisionId, externalJobId, supabase, scrollToBottom]);

	const startStatusPoll = (jId: string) => {
		stopStatusPoll();
		statusPollRef.current = setInterval(async () => {
			try {
				const result = await getJobStatus(jId);
				if (!result) return;
				setJobState(result.status as JobState);
				if (result.status === "FAILED") {
					setJobError(result.error_message);
					stopStatusPoll();
					fetchLogsForJob(jId);
				} else if (result.status === "SUCCESS") {
					stopStatusPoll();
					fetchLogsForJob(jId);
				}
			} catch {
				// ignore polling errors
			}
		}, 3000);
	};

	const fetchLogsForJob = async (jId: string) => {
		setIsLoading(true);
		try {
			const { data: existingLogs, error: logsError } = await supabase
				.from("job_logs")
				.select("*")
				.eq("job_id", jId)
				.order("id", { ascending: true });

			if (logsError) throw logsError;
			setLogs(existingLogs as LogEntry[]);
			scrollToBottom();
		} catch (error) {
			console.error("Error fetching job logs:", error);
		} finally {
			setIsLoading(false);
		}
	};

	const fetchLatestHarvest = async () => {
		if (!clusterId) return;
		setIsLoading(true);

		try {
			const { data: provisions, error } = await supabase
				.from("provisions")
				.select("id, status, created_at")
				.eq("cluster_id", clusterId)
				.order("created_at", { ascending: false })
				.limit(1);

			if (error) throw error;

			if (provisions && provisions.length > 0) {
				const latestProvision = provisions[0];
				setProvisionId(latestProvision.id);

				const { data: existingLogs, error: logsError } = await supabase
					.from("provision_logs")
					.select("*")
					.eq("provision_id", latestProvision.id)
					.order("id", { ascending: true });

				if (logsError) throw logsError;
				setLogs(existingLogs as LogEntry[]);
			} else {
				setProvisionId(null);
				setLogs([]);
			}
		} catch (error) {
			console.error("Error fetching logs:", error);
		} finally {
			setIsLoading(false);
		}
	};

	const handleRefresh = () => {
		if (externalJobId) {
			fetchLogsForJob(externalJobId);
		} else {
			fetchLatestHarvest();
		}
	};

	const [isSimulating, setIsSimulating] = useState(false);

	const simulateHarvest = async () => {
		setIsSimulating(true);
		setLogs([]);
		setJobState("PROCESSING");

		const steps = [
			{ msg: "Initializing Grape CLI v1.2.0...", type: "STDOUT" },
			{ msg: "Loading configuration...", type: "STDOUT" },
			{ msg: "Validating cloud credentials for AWS...", type: "STDOUT" },
			{ msg: "Credentials validated successfully.", type: "STDOUT" },
			{ msg: "Creating S3 state bucket: e2e-test-dev-eu-west-1-idp-state...", type: "STDOUT" },
			{ msg: "Bucket created.", type: "STDOUT" },
			{ msg: "Cloning environment template repository...", type: "STDOUT" },
			{ msg: "Cloning GitOps template repository...", type: "STDOUT" },
			{ msg: "Generating Terraform variables from configuration...", type: "STDOUT" },
			{ msg: "Running terraform init...", type: "STDOUT" },
			{ msg: "Terraform has been successfully initialized!", type: "STDOUT" },
			{ msg: "Running terraform plan...", type: "STDOUT" },
			{ msg: "Plan: 47 to add, 0 to change, 0 to destroy.", type: "STDOUT" },
			{ msg: "Running terraform apply...", type: "STDOUT" },
			{ msg: "aws_vpc.main: Creating...", type: "STDOUT" },
			{ msg: "aws_vpc.main: Creation complete after 3s", type: "STDOUT" },
			{ msg: "aws_subnet.private[0]: Creating...", type: "STDOUT" },
			{ msg: "aws_subnet.private[1]: Creating...", type: "STDOUT" },
			{ msg: "aws_subnet.public[0]: Creating...", type: "STDOUT" },
			{ msg: "aws_eks_cluster.main: Creating...", type: "STDOUT" },
			{ msg: "aws_eks_cluster.main: Still creating... [5m elapsed]", type: "STDOUT" },
			{ msg: "aws_eks_cluster.main: Still creating... [10m elapsed]", type: "STDOUT" },
			{ msg: "aws_eks_cluster.main: Creation complete after 12m", type: "STDOUT" },
			{ msg: "aws_eks_node_group.workers: Creating...", type: "STDOUT" },
			{ msg: "aws_eks_node_group.workers: Creation complete after 3m", type: "STDOUT" },
			{ msg: "Apply complete! Resources: 47 added, 0 changed, 0 destroyed.", type: "STDOUT" },
			{ msg: "Retrieving EKS cluster outputs...", type: "STDOUT" },
			{ msg: "Configuring kubectl for cluster e2e-test-dev...", type: "STDOUT" },
			{ msg: "Generating infra-facts.yaml...", type: "STDOUT" },
			{ msg: "Bootstrapping GitOps repository...", type: "STDOUT" },
			{ msg: "Installing ArgoCD via Helm...", type: "STDOUT" },
			{ msg: "ArgoCD installed. Namespace: argocd", type: "STDOUT" },
			{ msg: "Applying ArgoCD app-of-apps manifest...", type: "STDOUT" },
			{ msg: "Infrastructure services syncing via ArgoCD...", type: "STDOUT" },
			{ msg: "Provisioning complete. Vine is healthy!", type: "STDOUT" },
			{ msg: "Done in 892s.", type: "STDOUT" },
		];

		try {
			for (const step of steps) {
				if (!open) break;
				await new Promise((resolve) =>
					setTimeout(resolve, Math.random() * 600 + 200),
				);
				const logEntry: LogEntry = {
					id: Date.now(),
					created_at: new Date().toISOString(),
					log_chunk: step.msg,
					stream_type: step.type,
				};
				setLogs((prev) => [...prev, logEntry]);
				scrollToBottom();
			}
			setJobState("SUCCESS");
		} catch {
			setJobState("FAILED");
		} finally {
			setIsSimulating(false);
		}
	};

	const isActive =
		isSimulating ||
		jobState === "QUEUED" ||
		jobState === "CLAIMED" ||
		jobState === "PROCESSING";

	return (
		<Sheet open={open} onOpenChange={onOpenChange}>
			<SheetContent className="w-full sm:max-w-4xl flex flex-col h-full bg-background border-l border-border p-0 gap-0">
				<SheetHeader className="p-6 border-b border-border bg-muted/5">
					<div className="flex items-center justify-between">
						<div className="flex items-center gap-3">
							<div className="p-2 border border-border bg-muted/30 rounded-lg">
								<Terminal className="w-5 h-5 text-foreground" />
							</div>
							<div>
								<div className="flex items-center gap-2">
									<SheetTitle className="text-foreground">
										Provisioning Logs
									</SheetTitle>
									{jobState && <JobStatusBadge status={jobState} />}
								</div>
								<SheetDescription className="text-muted-foreground text-xs">
									{clusterName || "Job"} — real-time output
								</SheetDescription>
							</div>
						</div>
						<div className="flex gap-2">
							<Button
								size="sm"
								variant="outline"
								className="h-8 text-xs font-medium"
								onClick={handleRefresh}
								disabled={isLoading || isSimulating}
							>
								<RefreshCw
									className={`w-3.5 h-3.5 mr-2 ${isLoading ? "animate-spin" : ""}`}
								/>
								Refresh
							</Button>
							<Button
								size="sm"
								variant="secondary"
								className="h-8 text-xs font-medium"
								onClick={simulateHarvest}
								disabled={isSimulating || isActive}
							>
								{isSimulating ? (
									<Loader2 className="w-3.5 h-3.5 mr-2 animate-spin" />
								) : (
									<Play className="w-3.5 h-3.5 mr-2" />
								)}
								Simulate
							</Button>
						</div>
					</div>
				</SheetHeader>

				<div className="flex-1 overflow-hidden relative font-mono text-xs bg-muted/20">
					<ScrollArea className="h-full w-full p-6">
						{isLoading && logs.length === 0 ? (
							<div className="flex flex-col items-center justify-center text-muted-foreground py-20">
								<Loader2 className="w-8 h-8 mb-4 animate-spin opacity-30" />
								<p className="text-sm">Loading logs...</p>
							</div>
						) : logs.length === 0 && isActive ? (
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
								<p className="text-sm">No logs yet.</p>
							</div>
						) : (
							<div className="space-y-0 pb-10">
								{logs.map((log, i) => (
									<div
										key={log.id || i}
										className="flex gap-4 group hover:bg-muted/40 px-2 py-0.5 rounded transition-colors"
									>
										<span className="text-muted-foreground/40 select-none shrink-0 w-8 text-right font-mono">
											{i + 1}
										</span>
										<span className="text-muted-foreground/60 select-none shrink-0 w-[85px]">
											{new Date(
												log.created_at || Date.now(),
											).toLocaleTimeString([], {
												hour12: false,
												hour: "2-digit",
												minute: "2-digit",
												second: "2-digit",
											})}
										</span>
										<span
											className={`break-all leading-relaxed ${log.stream_type === "STDERR" || log.stream_type === "stderr" ? "text-destructive" : "text-foreground/80"}`}
										>
											{log.log_chunk}
										</span>
									</div>
								))}
								<div ref={bottomRef} />
								{isActive && logs.length > 0 && (
									<div className="flex gap-4 mt-2 px-2">
										<span className="w-8" />
										<span className="w-[85px]" />
										<span className="w-2 h-4 bg-muted-foreground/30 animate-pulse block" />
									</div>
								)}
							</div>
						)}
					</ScrollArea>
				</div>

				{jobState === "SUCCESS" && (
					<div className="p-4 border-t border-border bg-emerald-500/5 flex items-center gap-3">
						<CheckCircle2 className="w-4 h-4 text-emerald-500 shrink-0" />
						<p className="text-sm text-foreground">Provisioning completed successfully.</p>
					</div>
				)}
				{jobState === "FAILED" && (
					<div className="p-4 border-t border-border bg-destructive/5 flex flex-col gap-1">
						<div className="flex items-center gap-2">
							<XCircle className="w-4 h-4 text-destructive shrink-0" />
							<p className="text-sm font-medium text-foreground">Provisioning failed</p>
						</div>
						{jobError && (
							<p className="text-xs text-muted-foreground ml-6 break-all">{jobError}</p>
						)}
					</div>
				)}
			</SheetContent>
		</Sheet>
	);
}

function JobStatusBadge({ status }: { status: string }) {
	switch (status) {
		case "SUCCESS":
			return (
				<Badge variant="default" className="bg-emerald-600 text-white text-[10px]">
					<CheckCircle2 className="mr-1 h-2.5 w-2.5" />
					Success
				</Badge>
			);
		case "FAILED":
			return (
				<Badge variant="destructive" className="text-[10px]">
					<XCircle className="mr-1 h-2.5 w-2.5" />
					Failed
				</Badge>
			);
		case "PROCESSING":
			return (
				<Badge variant="secondary" className="text-[10px]">
					<Loader2 className="mr-1 h-2.5 w-2.5 animate-spin" />
					Processing
				</Badge>
			);
		case "CLAIMED":
			return (
				<Badge variant="secondary" className="text-[10px]">
					<Loader2 className="mr-1 h-2.5 w-2.5 animate-spin" />
					Claimed
				</Badge>
			);
		case "QUEUED":
			return (
				<Badge variant="outline" className="text-[10px]">
					<AlertCircle className="mr-1 h-2.5 w-2.5" />
					Queued
				</Badge>
			);
		default:
			return null;
	}
}
