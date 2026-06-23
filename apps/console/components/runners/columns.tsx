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
import { ReleaseNotesPopover } from "@/components/runners/release-notes-popover";
import { RunnerSelectPopover } from "@/components/runners/runner-select-popover";
import {
	useRunnersStore,
	type ActiveJob,
	type RunnerWithRelease,
} from "@/lib/stores/use-runners-store";
import type { RunnerStatus as PublicRunnerStatus } from "@/lib/db/schema";
import type { ColumnDef } from "@tanstack/react-table";
import { formatDistanceToNow } from "date-fns";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import type { RunnerMetadata } from "@/types/database-custom.types";
import { ArrowUpCircle, Cloud, Loader2, Server, Star } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";

export type RunnerRow = RunnerWithRelease & {
	activeJob: ActiveJob | null;
};

function RunnerActionsCell({ runner }: { runner: RunnerRow }) {
	const router = useRouter();
	const { setDefaultRunner, destroyRunner, deleteRunner } = useRunnersStore();
	const [showRemoveDialog, setShowRemoveDialog] = useState(false);
	const [acting, setActing] = useState(false);
	const [destroying, setDestroying] = useState(false);

	const isManaged = runner.operator === "managed";
	const isDestroying = runner.activeJob?.job_type === "DESTROY_RUNNER";
	const isProvisioning = runner.activeJob?.job_type === "DEPLOY_RUNNER";
	const isUpdating = runner.activeJob?.job_type === "UPDATE_RUNNER";
	const metadata = runner.metadata as RunnerMetadata | null;
	const hasCloudResources = !!runner.cloud_identity_id && !!metadata?.deploy_config;

	const handleToggleDefault = async () => {
		try {
			const newValue = !runner.is_default;
			await setDefaultRunner(newValue ? runner.id : null);
			toast.success(newValue ? `${runner.name} set as default` : "Default runner cleared");
		} catch (err) {
			toast.error(err instanceof Error ? err.message : "Failed to update");
		}
	};

	const handleDestroy = async (assignedRunnerId: string | null) => {
		setDestroying(true);
		try {
			const { jobId } = await destroyRunner(runner.id, assignedRunnerId);
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
			await deleteRunner(runner.id);
			toast.success(`${runner.name} removed`);
		} catch (err) {
			toast.error(err instanceof Error ? err.message : "Failed to remove");
		} finally {
			setActing(false);
			setShowRemoveDialog(false);
		}
	};

	if (isProvisioning && runner.activeJob) {
		return (
			<Link
				href={`/dashboard/jobs/${runner.activeJob.id}`}
				onClick={(e) => e.stopPropagation()}
				className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground hover:underline"
			>
				<Loader2 className="h-3 w-3 animate-spin" />
				Provisioning…
			</Link>
		);
	}

	if (isUpdating && runner.activeJob) {
		return (
			<Link
				href={`/dashboard/jobs/${runner.activeJob.id}`}
				onClick={(e) => e.stopPropagation()}
				className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground hover:underline"
			>
				<Loader2 className="h-3 w-3 animate-spin" />
				Updating…
			</Link>
		);
	}

	if (isDestroying && runner.activeJob) {
		return (
			<Link
				href={`/dashboard/jobs/${runner.activeJob.id}`}
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
							<Star className={`h-3.5 w-3.5 ${runner.is_default ? "fill-foreground text-foreground" : "text-muted-foreground hover:text-foreground"}`} />
						</button>
					</TooltipTrigger>
					<TooltipContent side="top" className="text-xs">
						{runner.is_default ? "Clear default" : "Set as default"}
					</TooltipContent>
				</Tooltip>
			</TooltipProvider>

			{!isManaged && runner.provisioning === "deployed" && hasCloudResources && (
				<RunnerSelectPopover
					trigger={
						<Button variant="ghost" size="sm" className="h-7 px-2 text-xs text-muted-foreground hover:text-destructive" disabled={destroying}>
							{destroying ? "Destroying…" : "Destroy"}
						</Button>
					}
					variant="destructive"
					confirmLabel="Destroy"
					description={`This will tear down all cloud resources for "${runner.name}" and delete the runner. This cannot be undone.`}
					excludeId={runner.id}
					onConfirm={handleDestroy}
					disabled={destroying}
				/>
			)}

			{!isManaged && !(runner.provisioning === "deployed" && hasCloudResources) && (
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
									Remove runner &ldquo;{runner.name}&rdquo;?
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

function VersionCell({ runner }: { runner: RunnerRow }) {
	const { latestRelease } = useRunnersStore();

	const release = runner.runner_releases;
	const displayVersion = release?.version ?? runner.version;
	const isRelease = displayVersion && displayVersion !== "dev";
	const isOutdated =
		latestRelease && isRelease && displayVersion !== latestRelease.version;

	return (
		<div className="flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
			{displayVersion ? (
				isRelease ? (
					<ReleaseNotesPopover version={displayVersion}>
						<button
							type="button"
							className="cursor-pointer font-mono text-xs text-muted-foreground transition-colors hover:text-foreground hover:underline"
						>
							v{displayVersion}
						</button>
					</ReleaseNotesPopover>
				) : (
					<span className="font-mono text-xs text-muted-foreground">{displayVersion}</span>
				)
			) : (
				<span className="font-mono text-xs text-muted-foreground">Unknown</span>
			)}
			{isOutdated && (
				<ReleaseNotesPopover
					version={latestRelease.version}
					runnerId={runner.id}
					isOutdated
				>
					<TooltipProvider delayDuration={300}>
						<Tooltip>
							<TooltipTrigger asChild>
								<button type="button">
									<Badge
										variant="outline"
										className="gap-1 cursor-pointer border-border bg-muted py-0 text-[10px] text-muted-foreground hover:bg-muted/80"
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
				</ReleaseNotesPopover>
			)}
		</div>
	);
}

export const runnerColumns: ColumnDef<RunnerRow>[] = [
	{
		accessorKey: "name",
		header: "Name",
		enableSorting: true,
		cell: ({ row }) => {
			const runner = row.original;
			const status = (runner.status ?? "OFFLINE") as PublicRunnerStatus;
			const isDestroying = runner.activeJob?.job_type === "DESTROY_RUNNER";
			const isProvisioning = runner.activeJob?.job_type === "DEPLOY_RUNNER";
			const isUpdating = runner.activeJob?.job_type === "UPDATE_RUNNER";
			const isBusy = isDestroying || isProvisioning || isUpdating;
			const dotStatus = isDestroying
				? "DESTROYING"
				: isProvisioning
					? "PROVISIONING"
					: isUpdating
						? "UPDATING"
						: status;
			const instanceId =
				runner.operator === "managed" ? runner.metadata?.cloud_instance_id : null;
			return (
				<div className={`flex items-center gap-2.5 ${isBusy ? "opacity-60" : ""}`}>
					<StatusBadge status={dotStatus} showLabel={false} className="shrink-0" />
					<div className="min-w-0">
						<div className="flex items-center gap-1.5">
							<span className="text-xs font-medium">{runner.name}</span>
							{runner.is_default && (
								<Star className="h-3 w-3 shrink-0 fill-foreground text-foreground" />
							)}
						</div>
						{instanceId && (
							<span className="font-mono text-[10px] text-muted-foreground">{instanceId}</span>
						)}
					</div>
				</div>
			);
		},
	},
	{
		accessorKey: "status",
		header: "Status",
		enableSorting: true,
		cell: ({ row }) => {
			const runner = row.original;
			const isDestroying = runner.activeJob?.job_type === "DESTROY_RUNNER";
			const isProvisioning = runner.activeJob?.job_type === "DEPLOY_RUNNER";
			const isUpdating = runner.activeJob?.job_type === "UPDATE_RUNNER";
			if (isProvisioning) {
				return <StatusBadge status="PROVISIONING" />;
			}
			if (isUpdating) {
				return <StatusBadge status="UPDATING" />;
			}
			if (isDestroying) {
				return <StatusBadge status="DESTROYING" />;
			}
			const status = (row.getValue("status") as PublicRunnerStatus | null) ?? "OFFLINE";
			return <StatusBadge status={status} />;
		},
	},
	{
		id: "operator",
		header: "Operator",
		enableSorting: false,
		cell: ({ row }) => {
			const runner = row.original;
			const isManaged = runner.operator === "managed";
			const OperatorIcon = isManaged ? Cloud : Server;
			const label = isManaged
				? "Managed"
				: runner.provisioning === "deployed"
					? "Self · Deployed"
					: "Self · Registered";
			return (
				<Badge variant="outline" className="text-[10px] py-0 text-muted-foreground border-border bg-muted">
					<OperatorIcon className="mr-1 h-3 w-3" />
					{label}
				</Badge>
			);
		},
	},
	{
		id: "location",
		header: "Location",
		enableSorting: false,
		cell: ({ row }) => {
			// Cloud placement of a managed runner (persisted by the fleet controller's
			// observed-view reconcile). Self-operated runners have no fleet location.
			const loc = row.original.operator === "managed" ? row.original.location : null;
			return (
				<span className="font-mono text-xs text-muted-foreground">{loc ?? "—"}</span>
			);
		},
	},
	{
		accessorKey: "version",
		header: "Version",
		enableSorting: false,
		cell: ({ row }) => <VersionCell runner={row.original} />,
	},
	{
		id: "provisioned",
		header: () => <div className="text-right">Provisioned</div>,
		enableSorting: false,
		cell: ({ row }) => {
			const runner = row.original;
			if (runner.operator !== "managed") {
				return <div className="text-right text-xs text-muted-foreground">—</div>;
			}
			const hours = runner.provisioned_hours ?? 0;
			return (
				<div className="text-right text-xs text-muted-foreground tabular-nums">
					{hours.toFixed(1)} h
				</div>
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
					{job.specs?.project_name && (
						<span className="text-muted-foreground font-normal">&middot; {job.specs.project_name}</span>
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
		cell: ({ row }) => <RunnerActionsCell runner={row.original} />,
	},
];
