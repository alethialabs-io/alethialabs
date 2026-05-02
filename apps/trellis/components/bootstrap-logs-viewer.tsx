"use client";

import { useEffect, useState, useRef } from "react";
import { getBootstrapJobs, getBootstrapLogs } from "@/app/server/actions/bootstrap";
import { Loader2, Terminal, RefreshCw, CheckCircle2, XCircle } from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

export function BootstrapLogsViewer({ vineyardId }: { vineyardId: string }) {
	const [jobs, setJobs] = useState<any[]>([]);
	const [selectedJob, setSelectedJob] = useState<any | null>(null);
	const [logs, setLogs] = useState<any[]>([]);
	const [isLoading, setIsLoading] = useState(true);
	const [isPolling, setIsPolling] = useState(false);
	const scrollRef = useRef<HTMLDivElement>(null);

	const fetchJobs = async () => {
		try {
			const { jobs } = await getBootstrapJobs(vineyardId);
			setJobs(jobs);
			if (jobs.length > 0 && !selectedJob) {
				setSelectedJob(jobs[0]);
			}
		} catch (error) {
			console.error(error);
		} finally {
			setIsLoading(false);
		}
	};

	const fetchLogs = async (jobId: string) => {
		try {
			const { logs: newLogs } = await getBootstrapLogs(jobId);
			setLogs(newLogs);
		} catch (error) {
			console.error(error);
		}
	};

	useEffect(() => {
		fetchJobs();
		const interval = setInterval(fetchJobs, 10000); // Check for new jobs every 10s
		return () => clearInterval(interval);
	}, [vineyardId]);

	useEffect(() => {
		if (selectedJob) {
			fetchLogs(selectedJob.id);
			
			// Auto-poll if job is still in progress
			if (selectedJob.status === 'IN_PROGRESS' || selectedJob.status === 'QUEUED') {
				setIsPolling(true);
				const interval = setInterval(() => {
					fetchLogs(selectedJob.id);
					fetchJobs(); // refresh status
				}, 2000);
				return () => clearInterval(interval);
			} else {
				setIsPolling(false);
			}
		}
	}, [selectedJob?.id, selectedJob?.status]);

	// Auto-scroll to bottom
	useEffect(() => {
		if (scrollRef.current) {
			const scrollNode = scrollRef.current.querySelector('[data-radix-scroll-area-viewport]');
			if (scrollNode) {
				scrollNode.scrollTop = scrollNode.scrollHeight;
			}
		}
	}, [logs]);

	if (isLoading) {
		return <div className="flex items-center justify-center h-48 text-muted-foreground"><Loader2 className="w-5 h-5 animate-spin mr-2" /> Loading jobs...</div>;
	}

	if (jobs.length === 0) {
		return (
			<div className="flex flex-col items-center justify-center h-48 border border-border/50 border-dashed rounded-lg bg-muted/20">
				<Terminal className="w-8 h-8 text-muted-foreground/50 mb-3" />
				<h3 className="text-sm font-medium text-foreground">No Bootstrap Logs</h3>
				<p className="text-xs text-muted-foreground mt-1">Run `grape bootstrap` via CLI to see logs here.</p>
			</div>
		);
	}

	return (
		<div className="flex flex-col h-[500px] border border-border/50 rounded-xl overflow-hidden bg-background">
			<div className="flex items-center justify-between p-3 border-b border-border/50 bg-muted/20">
				<div className="flex items-center gap-2">
					<Terminal className="w-4 h-4 text-muted-foreground" />
					<h3 className="text-sm font-medium">Bootstrap Execution</h3>
					{selectedJob && (
						<Badge variant={selectedJob.status === 'SUCCESS' ? 'default' : selectedJob.status === 'FAILED' ? 'destructive' : 'secondary'} className="ml-2 h-5 text-[10px]">
							{selectedJob.status === 'IN_PROGRESS' && <RefreshCw className="w-3 h-3 mr-1 animate-spin" />}
							{selectedJob.status === 'SUCCESS' && <CheckCircle2 className="w-3 h-3 mr-1" />}
							{selectedJob.status === 'FAILED' && <XCircle className="w-3 h-3 mr-1" />}
							{selectedJob.status}
						</Badge>
					)}
				</div>
				<div className="flex items-center gap-2">
					{isPolling && <span className="text-[10px] text-muted-foreground flex items-center"><span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse mr-1.5"></span> Live</span>}
				</div>
			</div>
			<div className="flex-1 bg-black/95 text-green-400 font-mono text-[11px] p-4 overflow-hidden relative">
				<ScrollArea className="h-full w-full" ref={scrollRef}>
					{logs.length === 0 ? (
						<div className="text-muted-foreground/50">Waiting for logs...</div>
					) : (
						<div className="whitespace-pre-wrap leading-relaxed">
							{logs.map((log, i) => (
								<span key={i} className={log.stream_type === 'STDERR' ? 'text-red-400' : ''}>
									{log.log_chunk}
								</span>
							))}
						</div>
					)}
				</ScrollArea>
			</div>
		</div>
	);
}
