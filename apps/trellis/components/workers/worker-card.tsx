"use client";

import { useWorkersStore } from "@/lib/stores/use-workers-store";
import { Badge } from "@/components/ui/badge";
import { JOB_TYPES } from "@/components/jobs/columns";
import {
	WORKER_MODE_STYLES,
	STATUS_DOT_COLORS,
} from "@/components/workers/columns";
import type { PublicWorkersRow } from "@/lib/validations/db.schemas";
import { formatDistanceToNow } from "date-fns";
import { Cloud, Server, Star } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";

import type { ActiveJob } from "@/lib/stores/use-workers-store";

interface WorkerCardProps {
	worker: PublicWorkersRow;
	activeJob: ActiveJob | null;
}

export function WorkerCard({ worker, activeJob }: WorkerCardProps) {
	const router = useRouter();
	const { setDefaultWorker } = useWorkersStore();
	const [toggling, setToggling] = useState(false);
	const isDefault = worker.is_default;
	const status = worker.status ?? "OFFLINE";
	const ModeIcon = worker.mode === "cloud-hosted" ? Cloud : Server;
	const modeLabel = worker.mode === "cloud-hosted" ? "Cloud" : "Self-hosted";
	const dotColor = STATUS_DOT_COLORS[status];
	const isOnline = status === "ONLINE";

	const handleToggleDefault = async (e: React.MouseEvent) => {
		e.stopPropagation();
		setToggling(true);
		try {
			const newValue = !isDefault;
			await setDefaultWorker(newValue ? worker.id : null);
			toast.success(newValue ? `${worker.name} set as default` : "Default worker cleared");
		} catch (err) {
			toast.error(err instanceof Error ? err.message : "Failed to update");
		} finally {
			setToggling(false);
		}
	};

	const jobInfo = activeJob ? JOB_TYPES[activeJob.job_type as keyof typeof JOB_TYPES] : null;
	const JobIcon = jobInfo?.icon;

	return (
		<div className="rounded-lg border border-border/60 bg-card p-4 space-y-3">
			<div className="flex items-start justify-between">
				<div className="flex items-center gap-2.5">
					<span className="relative flex h-2.5 w-2.5">
						{isOnline && (
							<span
								className={`absolute inline-flex h-full w-full animate-ping rounded-full opacity-75 ${dotColor}`}
							/>
						)}
						<span
							className={`relative inline-flex h-2.5 w-2.5 rounded-full ${dotColor}`}
						/>
					</span>
					<span className="text-sm font-medium">{worker.name}</span>
					<button
						type="button"
						onClick={handleToggleDefault}
						disabled={toggling}
						className="p-0.5 rounded hover:bg-muted transition-colors disabled:opacity-50"
						title={isDefault ? "Remove as default" : "Set as default"}
					>
						<Star
							className={`h-3.5 w-3.5 ${isDefault ? "fill-amber-400 text-amber-400" : "text-muted-foreground/50"}`}
						/>
					</button>
				</div>
				<Badge
					variant="outline"
					className={`text-[10px] py-0 ${WORKER_MODE_STYLES[worker.mode]}`}
				>
					<ModeIcon className="mr-1 h-3 w-3" />
					{modeLabel}
				</Badge>
			</div>

			<p className="text-[11px] text-muted-foreground">
				{worker.last_heartbeat
					? `Last seen ${formatDistanceToNow(new Date(worker.last_heartbeat), { addSuffix: true })}`
					: "Never connected"}
			</p>

			{activeJob && JobIcon ? (
				<button
					type="button"
					onClick={() => router.push(`/dashboard/jobs/${activeJob.id}`)}
					className="w-full flex items-center gap-2.5 rounded-md border border-blue-200 bg-blue-50/50 dark:border-blue-800 dark:bg-blue-950/30 px-3 py-2 text-left transition-colors hover:bg-blue-50 dark:hover:bg-blue-950/50"
				>
					<JobIcon className="h-3.5 w-3.5 text-blue-600 dark:text-blue-400 shrink-0" />
					<div className="flex-1 min-w-0">
						<p className="text-xs font-medium text-blue-700 dark:text-blue-300 truncate">
							{jobInfo.label}
							{activeJob.vines?.project_name && (
								<span className="text-blue-500 dark:text-blue-400 font-normal">
									{" "}
									&middot; {activeJob.vines.project_name}
								</span>
							)}
						</p>
					</div>
					<span className="text-[10px] text-blue-500 dark:text-blue-400 animate-pulse shrink-0">
						Running&hellip;
					</span>
				</button>
			) : (
				<div className="flex items-center gap-2 rounded-md border border-border/40 bg-muted/30 px-3 py-2">
					<span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/40" />
					<p className="text-[11px] text-muted-foreground">
						{isOnline
							? "Idle — waiting for jobs"
							: "Offline"}
					</p>
				</div>
			)}
		</div>
	);
}
