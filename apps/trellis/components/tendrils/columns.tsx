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
import { ReleaseNotesDialog } from "@/components/tendrils/release-notes-dialog";
import { TendrilSelectPopover } from "@/components/tendrils/tendril-select-popover";
import { useTendrilsStore, type ActiveJob } from "@/lib/stores/use-tendrils-store";
import type {
	PublicWorkerStatus,
	PublicWorkerMode,
	PublicWorkersRow,
} from "@/lib/validations/db.schemas";
import type { ColumnDef } from "@tanstack/react-table";
import { formatDistanceToNow } from "date-fns";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import type { WorkerMetadata } from "@/types/database-custom.types";
import { ArrowUpCircle, Cloud, Loader2, MoreHorizontal, Server, Star, Trash2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";

export const TENDRIL_STATUS_STYLES: Record<PublicWorkerStatus, string> = {
	ONLINE:
		"text-emerald-600 border-emerald-200 bg-emerald-50 dark:text-emerald-400 dark:border-emerald-800 dark:bg-emerald-950",
	OFFLINE: "text-muted-foreground border-border bg-muted/50",
	DRAINING:
		"text-amber-600 border-amber-200 bg-amber-50 dark:text-amber-400 dark:border-amber-800 dark:bg-amber-950",
};

export const TENDRIL_MODE_STYLES: Record<PublicWorkerMode, string> = {
	"cloud-hosted":
		"text-blue-600 border-blue-200 bg-blue-50 dark:text-blue-400 dark:border-blue-800 dark:bg-blue-950",
	"self-hosted": "text-muted-foreground border-border bg-muted/30",
};

export const STATUS_DOT_COLORS: Record<PublicWorkerStatus, string> = {
	ONLINE: "bg-emerald-500",
	OFFLINE: "bg-gray-400",
	DRAINING: "bg-amber-500",
};

const DESTROYING_BADGE_STYLE =
	"text-orange-600 border-orange-200 bg-orange-50 dark:text-orange-400 dark:border-orange-800 dark:bg-orange-950";

export type TendrilRow = PublicWorkersRow & {
	activeJob: ActiveJob | null;
	worker_releases: { version: string; release_notes: string; released_at: string } | null;
};

function TendrilActions({ worker }: { worker: TendrilRow }) {
	const router = useRouter();
	const { latestRelease, setDefaultTendril, updateTendril, destroyTendril, deleteTendril } = useTendrilsStore();
	const [showRemoveDialog, setShowRemoveDialog] = useState(false);
	const [acting, setActing] = useState(false);

	const status = worker.status ?? "OFFLINE";
	const isDestroying = worker.activeJob?.job_type === "DESTROY_WORKER";
	const metadata = worker.metadata as WorkerMetadata | null;
	const hasCloudResources = !!worker.cloud_identity_id && !!metadata?.deploy_config;
	const canUpdate = hasCloudResources && !!metadata?.deploy_config?.worker_token;
	const isOutdated =
		latestRelease &&
		worker.version &&
		worker.version !== latestRelease.version;

	const handleUpdate = async () => {
		try {
			const { jobId } = await updateTendril(worker.id);
			toast.success("Update job queued", {
				action: {
					label: "View job",
					onClick: () => router.push(`/dashboard/jobs/${jobId}`),
				},
			});
		} catch (err) {
			toast.error(err instanceof Error ? err.message : "Failed to queue update");
		}
	};

	const handleToggleDefault = async () => {
		try {
			const newValue = !worker.is_default;
			await setDefaultTendril(newValue ? worker.id : null);
			toast.success(newValue ? `${worker.name} set as default` : "Default tendril cleared");
		} catch (err) {
			toast.error(err instanceof Error ? err.message : "Failed to update");
		}
	};

	const handleDestroy = async (assignedWorkerId: string | null) => {
		try {
			const { jobId } = await destroyTendril(worker.id, assignedWorkerId);
			toast.success("Destroy job queued", {
				action: {
					label: "View job",
					onClick: () => router.push(`/dashboard/jobs/${jobId}`),
				},
			});
		} catch (err) {
			toast.error(err instanceof Error ? err.message : "Failed to queue destroy");
		}
	};

	const handleRemove = async () => {
		setActing(true);
		try {
			await deleteTendril(worker.id);
			toast.success(`${worker.name} removed`);
		} catch (err) {
			toast.error(err instanceof Error ? err.message : "Failed to remove");
		} finally {
			setActing(false);
			setShowRemoveDialog(false);
		}
	};

	if (isDestroying && worker.activeJob) {
		return (
			<Link
				href={`/dashboard/jobs/${worker.activeJob.id}`}
				onClick={(e) => e.stopPropagation()}
				className="flex items-center gap-1.5 text-xs text-orange-600 dark:text-orange-400 hover:underline"
			>
				<Loader2 className="h-3 w-3 animate-spin" />
				Destroying…
			</Link>
		);
	}

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
					{canUpdate && isOutdated && (
						<>
							<DropdownMenuSeparator />
							<DropdownMenuItem onClick={handleUpdate}>
								<ArrowUpCircle className="mr-2 h-3.5 w-3.5 text-blue-500" />
								Update Tendril
							</DropdownMenuItem>
						</>
					)}
					{(hasCloudResources || !worker.cloud_identity_id) && <DropdownMenuSeparator />}
					{hasCloudResources && (
						<TendrilSelectPopover
							trigger={
								<DropdownMenuItem
									className="text-destructive focus:text-destructive"
									onSelect={(e) => e.preventDefault()}
								>
									<Trash2 className="mr-2 h-3.5 w-3.5" />
									Destroy
								</DropdownMenuItem>
							}
							variant="destructive"
							confirmLabel="Destroy"
							description={`This will tear down all cloud resources for "${worker.name}" and delete the tendril. This cannot be undone.`}
							onConfirm={handleDestroy}
						/>
					)}
					{!hasCloudResources && (
						<DropdownMenuItem
							className="text-destructive focus:text-destructive"
							onClick={() => setShowRemoveDialog(true)}
						>
							<Trash2 className="mr-2 h-3.5 w-3.5" />
							Remove
						</DropdownMenuItem>
					)}
				</DropdownMenuContent>
			</DropdownMenu>

			<AlertDialog
				open={showRemoveDialog}
				onOpenChange={(open) => !open && setShowRemoveDialog(false)}
			>
				<AlertDialogContent onClick={(e) => e.stopPropagation()}>
					<AlertDialogHeader>
						<AlertDialogTitle>
							Remove tendril &ldquo;{worker.name}&rdquo;?
						</AlertDialogTitle>
						<AlertDialogDescription>
							This will remove the tendril record from the database. This cannot be undone.
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel disabled={acting}>Cancel</AlertDialogCancel>
						<AlertDialogAction
							onClick={handleRemove}
							disabled={acting}
							className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
						>
							{acting ? "Removing..." : "Remove"}
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</>
	);
}

function VersionCell({ worker }: { worker: TendrilRow }) {
	const { latestRelease } = useTendrilsStore();
	const [dialogVersion, setDialogVersion] = useState<string | null>(null);

	const release = worker.worker_releases;
	const displayVersion = release?.version ?? worker.version;
	const isOutdated =
		latestRelease && displayVersion && displayVersion !== latestRelease.version;

	return (
		<>
			<div className="flex items-center gap-1.5">
				{displayVersion ? (
					<button
						type="button"
						onClick={(e) => {
							e.stopPropagation();
							setDialogVersion(displayVersion);
						}}
						className="text-xs font-mono text-muted-foreground hover:text-foreground hover:underline transition-colors"
					>
						v{displayVersion}
					</button>
				) : (
					<span className="text-xs font-mono text-muted-foreground">Unknown</span>
				)}
				{isOutdated && (
					<TooltipProvider delayDuration={300}>
						<Tooltip>
							<TooltipTrigger asChild>
								<button
									type="button"
									onClick={(e) => {
										e.stopPropagation();
										setDialogVersion(latestRelease.version);
									}}
								>
									<Badge
										variant="outline"
										className="text-[10px] py-0 gap-1 cursor-pointer text-amber-600 border-amber-200 bg-amber-50 hover:bg-amber-100 dark:text-amber-400 dark:border-amber-800 dark:bg-amber-950 dark:hover:bg-amber-900"
									>
										<ArrowUpCircle className="h-3 w-3" />
										v{latestRelease.version}
									</Badge>
								</button>
							</TooltipTrigger>
							<TooltipContent side="top" className="text-xs">
								Click to view release notes
							</TooltipContent>
						</Tooltip>
					</TooltipProvider>
				)}
			</div>
			<ReleaseNotesDialog
				open={dialogVersion !== null}
				onOpenChange={(open) => !open && setDialogVersion(null)}
				version={dialogVersion}
				workerId={worker.id}
				isOutdated={!!isOutdated && dialogVersion === latestRelease?.version}
			/>
		</>
	);
}

export const tendrilColumns: ColumnDef<TendrilRow>[] = [
	{
		accessorKey: "name",
		header: "Name",
		enableSorting: true,
		cell: ({ row }) => {
			const worker = row.original;
			const status = (worker.status ?? "OFFLINE") as PublicWorkerStatus;
			const isDestroying = worker.activeJob?.job_type === "DESTROY_WORKER";
			const dotColor = isDestroying ? "bg-orange-500" : STATUS_DOT_COLORS[status];
			const isAnimated = status === "ONLINE" || isDestroying;
			return (
				<div className={`flex items-center gap-2.5 ${isDestroying ? "opacity-60" : ""}`}>
					<span className="relative flex h-2.5 w-2.5 shrink-0">
						{isAnimated && (
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
			const worker = row.original;
			const isDestroying = worker.activeJob?.job_type === "DESTROY_WORKER";
			if (isDestroying) {
				return (
					<Badge variant="outline" className={`text-[10px] py-0 ${DESTROYING_BADGE_STYLE}`}>
						DESTROYING
					</Badge>
				);
			}
			const status = (row.getValue("status") as PublicWorkerStatus | null) ?? "OFFLINE";
			return (
				<Badge variant="outline" className={`text-[10px] py-0 ${TENDRIL_STATUS_STYLES[status]}`}>
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
				<Badge variant="outline" className={`text-[10px] py-0 ${TENDRIL_MODE_STYLES[mode]}`}>
					<ModeIcon className="mr-1 h-3 w-3" />
					{mode === "cloud-hosted" ? "Cloud" : "Self-hosted"}
				</Badge>
			);
		},
	},
	{
		accessorKey: "version",
		header: "Version",
		enableSorting: false,
		cell: ({ row }) => <VersionCell worker={row.original} />,
	},
	{
		id: "activeJob",
		header: "Active Job",
		enableSorting: false,
		cell: ({ row }) => {
			const job = row.original.activeJob;
			if (!job) return <span className="text-[11px] text-muted-foreground">Idle</span>;

			const jobInfo = JOB_TYPES[job.job_type];
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
		cell: ({ row }) => <TendrilActions worker={row.original} />,
	},
];
