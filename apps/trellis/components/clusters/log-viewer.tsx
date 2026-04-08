"use client";

import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetHeader,
	SheetTitle,
} from "@/components/ui/sheet";
import { createClient } from "@/lib/supabase/client";
import { Loader2, Play, RefreshCw, Terminal } from "lucide-react";
import { useEffect, useRef, useState } from "react";

interface LogViewerProps {
	clusterId: string | null;
	clusterName?: string;
	open: boolean;
	onOpenChange: (open: boolean) => void;
}

interface LogEntry {
	id: number;
	created_at: string;
	log_chunk: string;
	stream_type: string | null;
}

export function LogViewer({
	clusterId,
	clusterName,
	open,
	onOpenChange,
}: LogViewerProps) {
	const [logs, setLogs] = useState<LogEntry[]>([]);
	const [isLoading, setIsLoading] = useState(false);
	const [isSimulating, setIsSimulating] = useState(false);
	const [provisionId, setProvisionId] = useState<string | null>(null);
	const scrollRef = useRef<HTMLDivElement>(null);
	const supabase = createClient();
	const bottomRef = useRef<HTMLDivElement>(null);

	// Fetch latest provision and logs when opened
	useEffect(() => {
		if (open && clusterId) {
			fetchLatestHarvest();
		} else {
			setLogs([]);
			setProvisionId(null);
		}
	}, [open, clusterId]);

	// Subscribe to new logs when we have a provisionId
	useEffect(() => {
		if (!provisionId) return;

		const channel = supabase
			.channel(`provision_logs:${provisionId}`)
			.on(
				"postgres_changes",
				{
					event: "INSERT",
					schema: "public",
					table: "provision_logs",
					filter: `provision_id=eq.${provisionId}`,
				},
				(payload) => {
					const newLog = payload.new as LogEntry;
					setLogs((prev) => [...prev, newLog]);
					// Auto-scroll to bottom
					setTimeout(() => {
						bottomRef.current?.scrollIntoView({
							behavior: "smooth",
						});
					}, 100);
				},
			)
			.subscribe();

		return () => {
			supabase.removeChannel(channel);
		};
	}, [provisionId, supabase]);

	const fetchLatestHarvest = async () => {
		if (!clusterId) return;
		setIsLoading(true);

		try {
			// Get the most recent provision for this cluster
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

				// Fetch existing logs for this provision
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

	const simulateHarvest = async () => {
		if (!clusterId) return;
		setIsSimulating(true);

		try {
			// 1. Create a new provision
			const { data: newProvision, error: provisionError } = await supabase
				.from("provisions")
				.insert({
					cluster_id: clusterId,
					config_snapshot: {
						simulated: true,
						timestamp: new Date().toISOString(),
					},
					status: "QUEUED",
				})
				.select()
				.single();

			if (provisionError) throw provisionError;

			if (!newProvision) {
				throw new Error("Failed to create provision: No data returned");
			}

			setProvisionId(newProvision.id);
			setLogs([]); // Clear previous logs

			// 2. Stream fake logs
			const steps = [
				"Initializing Grape CLI v1.2.0...",
				"Loading configuration...",
				"Validating cloud credentials for AWS...",
				"Credentials validated successfully.",
				"Checking VPC configuration...",
				"VPC 'grape-vpc-dev' found (subnet-12345678).",
				"Harvesting infrastructure (EKS)...",
				"Creating control plane...",
				"Waiting for control plane to become active...",
				"Control plane active.",
				"Creating node group 'worker-group-1'...",
				"Instances launching: i-0abcdef1234567890",
				"Instances launching: i-0abcdef0987654321",
				"Waiting for nodes to join cluster...",
				"Nodes joined: 2/2 ready.",
				"Installing core addons (vpc-cni, kube-proxy, coredns)...",
				"Installing Tendril agent...",
				"Tendril agent connected.",
				"Harvest complete. Vine is healthy!",
				"Done in 245s.",
			];

			for (const step of steps) {
				if (!open) break; // Stop if closed

				await new Promise((resolve) =>
					setTimeout(resolve, Math.random() * 800 + 400),
				);

				const logEntry: LogEntry = {
					id: Date.now(),
					created_at: new Date().toISOString(),
					log_chunk: step,
					stream_type: "stdout",
				};

				// Optimistic update
				setLogs((prev) => [...prev, logEntry]);

				// Scroll to bottom
				setTimeout(() => {
					bottomRef.current?.scrollIntoView({ behavior: "smooth" });
				}, 50);

				const { error: logError } = await supabase
					.from("provision_logs")
					.insert({
						provision_id: newProvision.id,
						log_chunk: step,
						stream_type: "stdout",
					});

				if (logError) {
					console.error("Failed to insert log chunk:", logError);
				}
			}
		} catch (error) {
			console.error("Simulation error:", error);
		} finally {
			setIsSimulating(false);
		}
	};

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
								<SheetTitle className="text-foreground">
									Harvesting Logs
								</SheetTitle>
								<SheetDescription className="text-muted-foreground text-xs">
									Real-time activity for{" "}
									{clusterName || "Cluster"}
								</SheetDescription>
							</div>
						</div>
						<div className="flex gap-2">
							<Button
								size="sm"
								variant="outline"
								className="h-8 text-xs font-medium"
								onClick={fetchLatestHarvest}
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
								disabled={isSimulating}
							>
								{isSimulating ? (
									<Loader2 className="w-3.5 h-3.5 mr-2 animate-spin" />
								) : (
									<Play className="w-3.5 h-3.5 mr-2" />
								)}
								Simulate Harvest
							</Button>
						</div>
					</div>
				</SheetHeader>

				<div className="flex-1 overflow-hidden relative font-mono text-xs bg-muted/20">
					<ScrollArea className="h-full w-full p-6">
						{!provisionId && !isLoading && logs.length === 0 ? (
							<div className="flex flex-col items-center justify-center h-full text-muted-foreground py-20">
								<Terminal className="w-12 h-12 mb-4 opacity-20" />
								<p>No harvesting logs found.</p>
								<p className="text-[11px] mt-2">
									Click "Simulate" to generate test data.
								</p>
							</div>
						) : (
							<div className="space-y-1 pb-10">
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
											className={`break-all leading-relaxed ${log.stream_type === "stderr" ? "text-destructive" : "text-foreground/80"}`}
										>
											{log.log_chunk}
										</span>
									</div>
								))}
								<div ref={bottomRef} />
								{isSimulating && (
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
			</SheetContent>
		</Sheet>
	);
}
