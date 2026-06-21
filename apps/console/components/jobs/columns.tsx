"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only


import { StatusBadge } from "@/components/ui/status-badge";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { ProviderIcon } from "@/components/provider-icon";
import type { JobWithMeta } from "@/app/server/actions/jobs";
import type { ProvisionJobType } from "@/lib/db/schema";
import type { ColumnDef } from "@tanstack/react-table";
import { format, formatDistanceToNow } from "date-fns";
import { ArrowUpCircle, Container, FileSearch, Plug, RefreshCw, Rocket, Trash2, Upload } from "lucide-react";
import Link from "next/link";

/** A job row enriched with joined spec/runner/provider data from getJobs(). */
type JobRow = JobWithMeta;

const JOB_TYPES: Record<
	ProvisionJobType,
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
	DEPLOY_RUNNER: {
		label: "Deploy Runner",
		icon: Container,
		description: "Provision a runner into your cloud account",
	},
	UPDATE_RUNNER: {
		label: "Update Runner",
		icon: ArrowUpCircle,
		description: "Update a runner to a newer version",
	},
	DESTROY_RUNNER: {
		label: "Destroy Runner",
		icon: Trash2,
		description: "Tear down a provisioned runner",
	},
} as Record<string, { label: string; icon: typeof Rocket; description: string }>;

export { JOB_TYPES };

function formatDuration(ms: number) {
	const seconds = Math.floor(ms / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	const remainingSeconds = seconds % 60;
	return `${minutes}m ${remainingSeconds}s`;
}

/** Renders a grayscale job status, with a tooltip surfacing the error on FAILED. */
function JobStatus({ status, errorMessage }: { status: string; errorMessage?: string | null }) {
	const badge = <StatusBadge status={status} />;

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
			const type = row.getValue<ProvisionJobType>("job_type");
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
			return <JobStatus status={status} errorMessage={errorMessage} />;
		},
	},
	{
		accessorKey: "spec_id",
		header: "Spec",
		enableSorting: false,
		cell: ({ row }) => {
			const specId = row.getValue<string | null>("spec_id");
			const specName = row.original.spec_name;
			const zoneId = row.original.spec_zone_id;
			const provider = row.original.cloud_provider;

			const providerIcon = provider ? (
				<ProviderIcon provider={provider} size={14} className="shrink-0" />
			) : null;

			if (!specId) {
				return (
					<div className="flex items-center gap-1.5">
						{providerIcon}
						<span className="text-xs text-muted-foreground">—</span>
					</div>
				);
			}

			const href = zoneId ? `/dashboard/zones/${zoneId}/specs/${specId}` : "#";
			return (
				<div className="flex items-center gap-1.5">
					{providerIcon}
					<Link href={href} onClick={(e) => e.stopPropagation()} className="text-xs font-medium text-foreground hover:underline">
						{specName ?? specId.slice(0, 8)}
					</Link>
				</div>
			);
		},
	},
	{
		accessorKey: "runner_id",
		header: "Runner",
		enableSorting: false,
		cell: ({ row }) => {
			const runnerId = row.getValue<string | null>("runner_id");
			const runnerName = row.original.runner_name;
			if (!runnerId) return <span className="text-xs text-muted-foreground">—</span>;
			return (
				<Link href="/dashboard/runners" onClick={(e) => e.stopPropagation()} className="text-xs font-medium text-foreground hover:underline">
					{runnerName ?? runnerId.slice(0, 8)}
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
					<span className="text-xs text-muted-foreground animate-pulse">
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
