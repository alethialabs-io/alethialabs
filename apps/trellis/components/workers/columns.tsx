"use client";

import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { JOB_TYPES } from "@/components/jobs/columns";
import { useWorkersStore, type ActiveJob } from "@/lib/stores/use-workers-store";
import type {
	PublicWorkerStatus,
	PublicWorkerMode,
	PublicWorkersRow,
} from "@/lib/validations/db.schemas";
import type { ColumnDef } from "@tanstack/react-table";
import { formatDistanceToNow } from "date-fns";
import { Cloud, MoreHorizontal, Server, Star, Trash2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";

export const WORKER_STATUS_STYLES: Record<PublicWorkerStatus, string> = {
	ONLINE:
		"text-emerald-600 border-emerald-200 bg-emerald-50 dark:text-emerald-400 dark:border-emerald-800 dark:bg-emerald-950",
	OFFLINE: "text-muted-foreground border-border bg-muted/50",
	DRAINING:
		"text-amber-600 border-amber-200 bg-amber-50 dark:text-amber-400 dark:border-amber-800 dark:bg-amber-950",
};

export const WORKER_MODE_STYLES: Record<PublicWorkerMode, string> = {
	"cloud-hosted":
		"text-blue-600 border-blue-200 bg-blue-50 dark:text-blue-400 dark:border-blue-800 dark:bg-blue-950",
	"self-hosted": "text-muted-foreground border-border bg-muted/30",
};

export const STATUS_DOT_COLORS: Record<PublicWorkerStatus, string> = {
	ONLINE: "bg-emerald-500",
	OFFLINE: "bg-gray-400",
	DRAINING: "bg-amber-500",
};

export type WorkerRow = PublicWorkersRow & {
	activeJob: ActiveJob | null;
};

function WorkerActions({ worker }: { worker: WorkerRow }) {
	const router = useRouter();
	const { setDefaultWorker, destroyWorker, deleteWorker } = useWorkersStore();
	const [confirmAction, setConfirmAction] = useState<"destroy" | "remove" | null>(null);
	const [acting, setActing] = useState(false);

	const status = worker.status ?? "OFFLINE";
	const isOnline = status === "ONLINE";
	const hasCloudResources = !!worker.cloud_identity_id && !!(worker.metadata as Record<string, unknown>)?.deploy_config;

	const handleToggleDefault = async () => {
		try {
			const newValue = !worker.is_default;
			await setDefaultWorker(newValue ? worker.id : null);
			toast.success(newValue ? `${worker.name} set as default` : "Default worker cleared");
		} catch (err) {
			toast.error(err instanceof Error ? err.message : "Failed to update");
		}
	};

	const handleConfirm = async () => {
		setActing(true);
		try {
			if (confirmAction === "destroy") {
				const { jobId } = await destroyWorker(worker.id);
				toast.success("Destroy job queued", {
					action: {
						label: "View job",
						onClick: () => router.push(`/dashboard/jobs/${jobId}`),
					},
				});
			} else if (confirmAction === "remove") {
				await deleteWorker(worker.id);
				toast.success(`${worker.name} removed`);
			}
		} catch (err) {
			toast.error(err instanceof Error ? err.message : "Operation failed");
		} finally {
			setActing(false);
			setConfirmAction(null);
		}
	};

	return (
		<>
			<DropdownMenu>
				<DropdownMenuTrigger asChild>
					<button
						type="button"
						className="p-1 rounded hover:bg-muted transition-colors"
						onClick={(e) => e.stopPropagation()}
					>
						<MoreHorizontal className="h-3.5 w-3.5 text-muted-foreground" />
					</button>
				</DropdownMenuTrigger>
				<DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
					<DropdownMenuItem onClick={handleToggleDefault}>
						<Star className={`mr-2 h-3.5 w-3.5 ${worker.is_default ? "fill-amber-400 text-amber-400" : ""}`} />
						{worker.is_default ? "Clear default" : "Set as default"}
					</DropdownMenuItem>
					{(hasCloudResources || !worker.cloud_identity_id) && <DropdownMenuSeparator />}
					{hasCloudResources && (
						<DropdownMenuItem
							className="text-destructive focus:text-destructive"
							onClick={() => setConfirmAction("destroy")}
						>
							<Trash2 className="mr-2 h-3.5 w-3.5" />
							Destroy
						</DropdownMenuItem>
					)}
					{!hasCloudResources && (
						<DropdownMenuItem
							className="text-destructive focus:text-destructive"
							onClick={() => setConfirmAction("remove")}
						>
							<Trash2 className="mr-2 h-3.5 w-3.5" />
							Remove
						</DropdownMenuItem>
					)}
				</DropdownMenuContent>
			</DropdownMenu>

			<AlertDialog
				open={confirmAction !== null}
				onOpenChange={(open) => !open && setConfirmAction(null)}
			>
				<AlertDialogContent onClick={(e) => e.stopPropagation()}>
					<AlertDialogHeader>
						<AlertDialogTitle>
							{confirmAction === "destroy"
								? `Destroy worker "${worker.name}"?`
								: `Remove worker "${worker.name}"?`}
						</AlertDialogTitle>
						<AlertDialogDescription>
							{confirmAction === "destroy"
								? isOnline
									? "This worker is currently online. Destroying it will terminate all running infrastructure and delete the worker. This cannot be undone."
									: "This will tear down all cloud resources provisioned for this worker and delete the record. This cannot be undone."
								: "This will remove the worker record from the database. This cannot be undone."}
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel disabled={acting}>Cancel</AlertDialogCancel>
						<AlertDialogAction
							onClick={handleConfirm}
							disabled={acting}
							className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
						>
							{acting ? "Processing..." : confirmAction === "destroy" ? "Destroy" : "Remove"}
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</>
	);
}

export const workerColumns: ColumnDef<WorkerRow>[] = [
	{
		accessorKey: "name",
		header: "Name",
		enableSorting: true,
		cell: ({ row }) => {
			const worker = row.original;
			const status = (worker.status ?? "OFFLINE") as PublicWorkerStatus;
			const dotColor = STATUS_DOT_COLORS[status];
			const isOnline = status === "ONLINE";
			return (
				<div className="flex items-center gap-2.5">
					<span className="relative flex h-2.5 w-2.5 shrink-0">
						{isOnline && (
							<span className={`absolute inline-flex h-full w-full animate-ping rounded-full opacity-75 ${dotColor}`} />
						)}
						<span className={`relative inline-flex h-2.5 w-2.5 rounded-full ${dotColor}`} />
					</span>
					<span className="text-xs font-medium">{worker.name}</span>
					{worker.is_default && (
						<Star className="h-3 w-3 fill-amber-400 text-amber-400 shrink-0" />
					)}
				</div>
			);
		},
	},
	{
		accessorKey: "status",
		header: "Status",
		enableSorting: true,
		cell: ({ row }) => {
			const status = (row.getValue("status") as PublicWorkerStatus | null) ?? "OFFLINE";
			return (
				<Badge variant="outline" className={`text-[10px] py-0 ${WORKER_STATUS_STYLES[status]}`}>
					{status}
				</Badge>
			);
		},
	},
	{
		accessorKey: "mode",
		header: "Mode",
		enableSorting: false,
		cell: ({ row }) => {
			const mode = row.getValue("mode") as PublicWorkerMode;
			const ModeIcon = mode === "cloud-hosted" ? Cloud : Server;
			return (
				<Badge variant="outline" className={`text-[10px] py-0 ${WORKER_MODE_STYLES[mode]}`}>
					<ModeIcon className="mr-1 h-3 w-3" />
					{mode === "cloud-hosted" ? "Cloud" : "Self-hosted"}
				</Badge>
			);
		},
	},
	{
		id: "activeJob",
		header: "Active Job",
		enableSorting: false,
		cell: ({ row }) => {
			const job = row.original.activeJob;
			if (!job) return <span className="text-[11px] text-muted-foreground">Idle</span>;

			const jobInfo = JOB_TYPES[job.job_type as keyof typeof JOB_TYPES];
			const Icon = jobInfo?.icon;
			return (
				<Link
					href={`/dashboard/jobs/${job.id}`}
					onClick={(e) => e.stopPropagation()}
					className="flex items-center gap-1.5 text-xs text-blue-600 dark:text-blue-400 hover:underline"
				>
					{Icon && <Icon className="h-3 w-3 shrink-0" />}
					<span>{jobInfo?.label ?? job.job_type}</span>
					{job.vines?.project_name && (
						<span className="text-muted-foreground font-normal">&middot; {job.vines.project_name}</span>
					)}
				</Link>
			);
		},
	},
	{
		accessorKey: "last_heartbeat",
		header: "Last Seen",
		enableSorting: true,
		cell: ({ row }) => {
			const hb = row.getValue("last_heartbeat") as string | null;
			if (!hb) return <span className="text-xs text-muted-foreground">Never</span>;
			return (
				<span className="text-xs text-muted-foreground">
					{formatDistanceToNow(new Date(hb), { addSuffix: true })}
				</span>
			);
		},
	},
	{
		id: "actions",
		header: "",
		enableSorting: false,
		cell: ({ row }) => <WorkerActions worker={row.original} />,
	},
];
