"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only


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
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/ui/status-badge";
import { JOB_TYPES } from "@/components/jobs/columns";
import { ReleaseNotesDialog } from "@/components/tendrils/release-notes-dialog";
import { TendrilSelectPopover } from "@/components/tendrils/tendril-select-popover";
import { useTendrilsStore, type ActiveJob } from "@/lib/stores/use-tendrils-store";
import type {
	WorkerStatus as PublicWorkerStatus,
	WorkerMode as PublicWorkerMode,
	Runner as PublicWorkersRow,
} from "@/lib/db/schema";
import type { ColumnDef } from "@tanstack/react-table";
import { formatDistanceToNow } from "date-fns";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import type { WorkerMetadata } from "@/types/database-custom.types";
import { ArrowUpCircle, Cloud, Loader2, Server, Star } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";

export type TendrilRow = PublicWorkersRow & {
	activeJob: ActiveJob | null;
	worker_releases: { version: string; release_notes: string; released_at: string } | null;
};

function TendrilActions({ worker }: { worker: TendrilRow }) {
	const router = useRouter();
	const { latestRelease, setDefaultTendril, updateTendril, destroyTendril, deleteTendril } = useTendrilsStore();
	const [showRemoveDialog, setShowRemoveDialog] = useState(false);
	const [acting, setActing] = useState(false);
	const [destroying, setDestroying] = useState(false);

	const status = worker.status ?? "OFFLINE";
	const isCloudHosted = worker.mode === "cloud-hosted";
	const isDestroying = worker.activeJob?.job_type === "DESTROY_WORKER";
	const isProvisioning = worker.activeJob?.job_type === "DEPLOY_WORKER";
	const isUpdating = worker.activeJob?.job_type === "UPDATE_WORKER";
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
			toast.success(newValue ? `${worker.name} set as default` : "Default runner cleared");
		} catch (err) {
			toast.error(err instanceof Error ? err.message : "Failed to update");
		}
	};

	const handleDestroy = async (assignedWorkerId: string | null) => {
		setDestroying(true);
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
			setDestroying(false);
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

	if (isProvisioning && worker.activeJob) {
		return (
			<Link
				href={`/dashboard/jobs/${worker.activeJob.id}`}
				onClick={(e) => e.stopPropagation()}
				className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground hover:underline"
			>
				<Loader2 className="h-3 w-3 animate-spin" />
				Provisioning…
			</Link>
		);
	}

	if (isUpdating && worker.activeJob) {
		return (
			<Link
				href={`/dashboard/jobs/${worker.activeJob.id}`}
				onClick={(e) => e.stopPropagation()}
				className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground hover:underline"
			>
				<Loader2 className="h-3 w-3 animate-spin" />
				Updating…
			</Link>
		);
	}

	if (isDestroying && worker.activeJob) {
		return (
			<Link
				href={`/dashboard/jobs/${worker.activeJob.id}`}
				onClick={(e) => e.stopPropagation()}
				className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground hover:underline"
			>
				<Loader2 className="h-3 w-3 animate-spin" />
				Destroying…
			</Link>
		);
	}

	return (
		<div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
			<TooltipProvider delayDuration={300}>
				<Tooltip>
					<TooltipTrigger asChild>
						<button
							type="button"
							onClick={handleToggleDefault}
							className="p-1 rounded hover:bg-muted transition-colors"
						>
							<Star className={`h-3.5 w-3.5 ${worker.is_default ? "fill-foreground text-foreground" : "text-muted-foreground hover:text-foreground"}`} />
						</button>
					</TooltipTrigger>
					<TooltipContent side="top" className="text-xs">
						{worker.is_default ? "Clear default" : "Set as default"}
					</TooltipContent>
				</Tooltip>
			</TooltipProvider>

			{!isCloudHosted && hasCloudResources && (
				<TendrilSelectPopover
					trigger={
						<Button variant="ghost" size="sm" className="h-7 px-2 text-xs text-muted-foreground hover:text-destructive" disabled={destroying}>
							{destroying ? "Destroying…" : "Destroy"}
						</Button>
					}
					variant="destructive"
					confirmLabel="Destroy"
					description={`This will tear down all cloud resources for "${worker.name}" and delete the runner. This cannot be undone.`}
					excludeId={worker.id}
					onConfirm={handleDestroy}
					disabled={destroying}
				/>
			)}

			{!isCloudHosted && !hasCloudResources && (
				<>
					<Button
						variant="ghost"
						size="sm"
						className="h-7 px-2 text-xs text-muted-foreground hover:text-destructive"
						onClick={() => setShowRemoveDialog(true)}
					>
						Remove
					</Button>

					<AlertDialog
						open={showRemoveDialog}
						onOpenChange={(open) => !open && setShowRemoveDialog(false)}
					>
						<AlertDialogContent onClick={(e) => e.stopPropagation()}>
							<AlertDialogHeader>
								<AlertDialogTitle>
									Remove runner &ldquo;{worker.name}&rdquo;?
								</AlertDialogTitle>
								<AlertDialogDescription>
									This will remove the runner record from the database. This cannot be undone.
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
			)}
		</div>
	);
}

function VersionCell({ worker }: { worker: TendrilRow }) {
	const { latestRelease } = useTendrilsStore();
	const [dialogVersion, setDialogVersion] = useState<string | null>(null);

	const release = worker.worker_releases;
	const displayVersion = release?.version ?? worker.version;
	const isRelease = displayVersion && displayVersion !== "dev";
	const isOutdated =
		latestRelease && isRelease && displayVersion !== latestRelease.version;

	return (
		<>
			<div className="flex items-center gap-1.5">
				{displayVersion ? (
					<button
						type="button"
						onClick={(e) => {
							e.stopPropagation();
							if (isRelease) setDialogVersion(displayVersion);
						}}
						className={`text-xs font-mono text-muted-foreground transition-colors ${isRelease ? "hover:text-foreground hover:underline cursor-pointer" : "cursor-default"}`}
					>
						{isRelease ? `v${displayVersion}` : displayVersion}
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
										className="text-[10px] py-0 gap-1 cursor-pointer text-muted-foreground border-border bg-muted hover:bg-muted/80"
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
			const isProvisioning = worker.activeJob?.job_type === "DEPLOY_WORKER";
			const isUpdating = worker.activeJob?.job_type === "UPDATE_WORKER";
			const isBusy = isDestroying || isProvisioning || isUpdating;
			const dotStatus = isDestroying
				? "DESTROYING"
				: isProvisioning
					? "PROVISIONING"
					: isUpdating
						? "UPDATING"
						: status;
			return (
				<div className={`flex items-center gap-2.5 ${isBusy ? "opacity-60" : ""}`}>
					<StatusBadge status={dotStatus} showLabel={false} className="shrink-0" />
					<span className="text-xs font-medium">{worker.name}</span>
					{worker.is_default && (
						<Star className="h-3 w-3 fill-foreground text-foreground shrink-0" />
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
			const isProvisioning = worker.activeJob?.job_type === "DEPLOY_WORKER";
			const isUpdating = worker.activeJob?.job_type === "UPDATE_WORKER";
			if (isProvisioning) {
				return <StatusBadge status="PROVISIONING" />;
			}
			if (isUpdating) {
				return <StatusBadge status="UPDATING" />;
			}
			if (isDestroying) {
				return <StatusBadge status="DESTROYING" />;
			}
			const status = (row.getValue("status") as PublicWorkerStatus | null) ?? "OFFLINE";
			return <StatusBadge status={status} />;
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
				<Badge variant="outline" className="text-[10px] py-0 text-muted-foreground border-border bg-muted">
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
					className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground hover:underline"
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
