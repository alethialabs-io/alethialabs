"use client";

import { Badge } from "@/components/ui/badge";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { ProviderIcon } from "@/components/provider-icon";
import { getProvider } from "@/lib/cloud-providers/registry";
import {
	PublicProvisionJobsRow,
	PublicProvisionJobType,
} from "@/lib/validations/db.schemas";
import type { ColumnDef } from "@tanstack/react-table";
import { format, formatDistanceToNow } from "date-fns";
import { ArrowUpCircle, Container, FileSearch, Plug, RefreshCw, Rocket, Trash2, Upload } from "lucide-react";
import Link from "next/link";

/** Extended job row with joined vine/worker/provider data from getJobs(). */
type JobRow = PublicProvisionJobsRow & {
	vine_name?: string | null;
	vine_vineyard_id?: string | null;
	worker_name?: string | null;
	cloud_provider?: string | null;
};

const JOB_TYPES: Record<
	PublicProvisionJobType,
	{ label: string; icon: typeof Rocket; description: string }
> = {
	PLAN: {
		label: "Plan",
		icon: FileSearch,
		description: "Dry-run infrastructure plan",
	},
	DEPLOY: {
		label: "Deploy",
		icon: Upload,
		description: "Provision infrastructure from config",
	},
	DESTROY: {
		label: "Destroy",
		icon: Trash2,
		description: "Tear down infrastructure",
	},
	CONNECTION_TEST: {
		label: "Connection Test",
		icon: Plug,
		description: "Verify cloud account access",
	},
	FETCH_RESOURCES: {
		label: "Fetch Resources",
		icon: RefreshCw,
		description: "Cache cloud regions, networks, zones",
	},
	DEPLOY_WORKER: {
		label: "Deploy Tendril",
		icon: Container,
		description: "Deploy a self-hosted tendril container",
	},
	UPDATE_WORKER: {
		label: "Update Tendril",
		icon: ArrowUpCircle,
		description: "Update a tendril to a newer version",
	},
	DESTROY_WORKER: {
		label: "Destroy Tendril",
		icon: Trash2,
		description: "Tear down a self-hosted tendril",
	},
} as Record<string, { label: string; icon: typeof Rocket; description: string }>;

const STATUS_STYLES: Record<string, string> = {
	SUCCESS:
		"!text-emerald-600 border-emerald-200 bg-emerald-50 dark:!text-emerald-400 dark:border-emerald-800 dark:bg-emerald-950",
	FAILED: "!text-destructive border-destructive/30 bg-destructive/10",
	PROCESSING:
		"!text-blue-600 border-blue-200 bg-blue-50 dark:!text-blue-400 dark:border-blue-800 dark:bg-blue-950",
	CLAIMED:
		"!text-amber-600 border-amber-200 bg-amber-50 dark:!text-amber-400 dark:border-amber-800 dark:bg-amber-950",
	QUEUED: "text-muted-foreground border-border bg-muted/50",
	CANCELLED: "text-muted-foreground border-border bg-muted/30",
};

export { JOB_TYPES, STATUS_STYLES };

function formatDuration(ms: number) {
	const seconds = Math.floor(ms / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	const remainingSeconds = seconds % 60;
	return `${minutes}m ${remainingSeconds}s`;
}

function StatusBadge({ status, errorMessage }: { status: string; errorMessage?: string | null }) {
	const badge = (
		<Badge
			variant="outline"
			className={`text-[10px] py-0 ${STATUS_STYLES[status] ?? ""}`}
		>
			{status}
		</Badge>
	);

	if (status === "FAILED" && errorMessage) {
		const truncated = errorMessage.length > 120
			? errorMessage.slice(0, 120) + "..."
			: errorMessage;
		return (
			<Tooltip>
				<TooltipTrigger asChild>
					{badge}
				</TooltipTrigger>
				<TooltipContent side="top" className="text-xs max-w-xs">
					{truncated}
				</TooltipContent>
			</Tooltip>
		);
	}

	return badge;
}

export const jobColumns: ColumnDef<JobRow>[] = [
	{
		accessorKey: "job_type",
		header: "Type",
		enableSorting: true,
		cell: ({ row }) => {
			const type = row.getValue<PublicProvisionJobType>("job_type");
			const info = JOB_TYPES[type];
			if (!info) return <span className="text-xs">{type}</span>;
			const Icon = info.icon;
			return (
				<div className="flex items-center gap-2">
					<Icon className="h-3.5 w-3.5 text-muted-foreground" />
					<div>
						<span className="text-xs font-medium">
							{info.label}
						</span>
						<p className="text-[10px] text-muted-foreground hidden sm:block">
							{info.description}
						</p>
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
			const status = row.getValue("status") as string;
			const errorMessage = row.original.error_message;
			return <StatusBadge status={status} errorMessage={errorMessage} />;
		},
	},
	{
		accessorKey: "vine_id",
		header: "Vine",
		enableSorting: false,
		cell: ({ row }) => {
			const vineId = row.getValue("vine_id") as string | null;
			const vineName = row.original.vine_name;
			const vineyardId = row.original.vine_vineyard_id;
			const provider = row.original.cloud_provider;

			const providerIcon = provider ? (
				<ProviderIcon provider={provider} size={14} className="shrink-0" />
			) : null;

			if (!vineId) {
				return (
					<div className="flex items-center gap-1.5">
						{providerIcon}
						<span className="text-xs text-muted-foreground">—</span>
					</div>
				);
			}

			const href = vineyardId ? `/dashboard/vineyards/${vineyardId}/vines/${vineId}` : "#";
			return (
				<div className="flex items-center gap-1.5">
					{providerIcon}
					<Link href={href} onClick={(e) => e.stopPropagation()} className="text-xs font-medium text-foreground hover:underline">
						{vineName ?? vineId.slice(0, 8)}
					</Link>
				</div>
			);
		},
	},
	{
		accessorKey: "worker_id",
		header: "Tendril",
		enableSorting: false,
		cell: ({ row }) => {
			const workerId = row.getValue("worker_id") as string | null;
			const workerName = row.original.worker_name;
			if (!workerId) return <span className="text-xs text-muted-foreground">—</span>;
			return (
				<Link href="/dashboard/tendrils" onClick={(e) => e.stopPropagation()} className="text-xs font-medium text-foreground hover:underline">
					{workerName ?? workerId.slice(0, 8)}
				</Link>
			);
		},
	},
	{
		accessorKey: "created_at",
		header: "Created",
		enableSorting: true,
		cell: ({ row }) => {
			const date = row.getValue("created_at") as string | null;
			if (!date)
				return <span className="text-xs text-muted-foreground">—</span>;
			const parsed = new Date(date);
			return (
				<Tooltip>
					<TooltipTrigger asChild>
						<span className="text-xs text-muted-foreground cursor-default">
							{formatDistanceToNow(parsed, { addSuffix: true })}
						</span>
					</TooltipTrigger>
					<TooltipContent side="top" className="text-xs">
						{format(parsed, "MMM d, yyyy HH:mm:ss")}
					</TooltipContent>
				</Tooltip>
			);
		},
	},
	{
		id: "duration",
		header: "Duration",
		enableSorting: true,
		accessorFn: (row) => {
			if (!row.created_at) return null;
			const end = row.completed_at
				? new Date(row.completed_at)
				: new Date();
			return end.getTime() - new Date(row.created_at).getTime();
		},
		cell: ({ row }) => {
			const created = row.original.created_at;
			const completed = row.original.completed_at;
			const status = row.original.status;

			if (!created)
				return <span className="text-xs text-muted-foreground">—</span>;

			if (
				!completed &&
				(status === "PROCESSING" || status === "CLAIMED")
			) {
				const ms = Date.now() - new Date(created).getTime();
				return (
					<span className="text-xs text-blue-500 animate-pulse">
						{formatDuration(ms)}
					</span>
				);
			}

			if (!completed)
				return <span className="text-xs text-muted-foreground">—</span>;

			const ms =
				new Date(completed).getTime() - new Date(created).getTime();
			return <span className="text-xs">{formatDuration(ms)}</span>;
		},
	},
];
