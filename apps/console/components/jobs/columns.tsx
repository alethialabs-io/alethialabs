"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { StatusBadge } from "@repo/ui/status-badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@repo/ui/tooltip";
import { ProviderIcon } from "@repo/ui/provider-icon";
import { cn } from "@repo/ui/utils";
import type { JobWithMeta } from "@/app/server/actions/jobs";
import type { ProvisionJobType } from "@/lib/db/schema";
import { JOB_TYPES, formatDuration } from "@/lib/jobs/format";
import { JobAuthor, type JobAuthorInfo } from "@/components/jobs/job-author";
import type { ColumnDef } from "@tanstack/react-table";
import { formatDistanceToNow } from "date-fns";
import { Layers, Server } from "lucide-react";
import { useEffect, useState } from "react";

export { JOB_TYPES };

/** A job row enriched with joined project/runner/provider/environment data from getJobs(). */
type JobRow = JobWithMeta;

const STAGE_LABEL: Record<string, string> = {
	development: "dev",
	staging: "staging",
	production: "prod",
};

const RUNNING = new Set(["QUEUED", "CLAIMED", "PROCESSING"]);

/** Ticks once a second so an in-flight job's elapsed time stays live. */
function LiveDuration({ createdAt }: { createdAt: Date | string }) {
	const [, setTick] = useState(0);
	useEffect(() => {
		const id = setInterval(() => setTick((t) => t + 1), 1000);
		return () => clearInterval(id);
	}, []);
	return (
		<span className="text-xs tabular-nums text-muted-foreground">
			{formatDuration(Date.now() - new Date(createdAt).getTime())}
		</span>
	);
}

/** Renders a grayscale job status, with a tooltip surfacing the error on FAILED. */
function JobStatus({
	status,
	errorMessage,
}: {
	status: string;
	errorMessage?: string | null;
}) {
	const badge = <StatusBadge status={status} />;
	if (status === "FAILED" && errorMessage) {
		const truncated =
			errorMessage.length > 120 ? `${errorMessage.slice(0, 120)}...` : errorMessage;
		return (
			<Tooltip>
				<TooltipTrigger asChild>{badge}</TooltipTrigger>
				<TooltipContent side="top" className="max-w-xs text-xs">
					{truncated}
				</TooltipContent>
			</Tooltip>
		);
	}
	return badge;
}

/**
 * The jobs table columns. `showProject` is false in a project-scoped context (the project is
 * implied). `authorById` resolves each job's initiator to the org-member identity for the avatar.
 */
export function buildJobColumns({
	showProject = true,
	authorById,
}: {
	showProject?: boolean;
	authorById: Map<string, JobAuthorInfo>;
}): ColumnDef<JobRow>[] {
	const columns: ColumnDef<JobRow>[] = [
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
						<Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
						<div className="min-w-0">
							<span className="text-xs font-medium">{info.label}</span>
							<p className="hidden text-[10px] text-muted-foreground sm:block">
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
				const { status, created_at, completed_at, error_message } = row.original;
				const running = !completed_at && RUNNING.has(status);
				return (
					<div className="flex items-center gap-2">
						<JobStatus status={status} errorMessage={error_message} />
						{created_at && running ? (
							<LiveDuration createdAt={created_at} />
						) : created_at && completed_at ? (
							<span className="text-xs tabular-nums text-muted-foreground">
								{formatDuration(
									new Date(completed_at).getTime() -
										new Date(created_at).getTime(),
								)}
							</span>
						) : null}
					</div>
				);
			},
		},
	];

	if (showProject) {
		columns.push({
			accessorKey: "project_id",
			header: "Project",
			enableSorting: false,
			cell: ({ row }) => {
				const { project_name, cloud_provider } = row.original;
				return (
					<div className="flex items-center gap-1.5">
						{cloud_provider && (
							<ProviderIcon
								provider={cloud_provider}
								size={14}
								className="shrink-0"
							/>
						)}
						<span
							className={cn(
								"text-xs",
								project_name
									? "font-medium text-foreground"
									: "text-muted-foreground",
							)}
						>
							{project_name ?? "—"}
						</span>
					</div>
				);
			},
		});
	}

	columns.push(
		{
			accessorKey: "runner_id",
			header: "Runner",
			enableSorting: false,
			cell: ({ row }) => {
				const { runner_id, runner_name } = row.original;
				if (!runner_id && !runner_name)
					return <span className="text-xs text-muted-foreground">—</span>;
				return (
					<div className="flex items-center gap-1.5">
						<Server className="size-3.5 shrink-0 text-muted-foreground" />
						<span className="text-xs text-foreground">
							{runner_name ?? runner_id?.slice(0, 8)}
						</span>
					</div>
				);
			},
		},
		{
			id: "environment",
			header: "Environment",
			enableSorting: false,
			cell: ({ row }) => {
				const { environment_name, environment_stage } = row.original;
				if (!environment_name)
					return <span className="text-xs text-muted-foreground">—</span>;
				return (
					<div className="flex items-center gap-1.5">
						<Layers className="size-3.5 shrink-0 text-muted-foreground" />
						<span className="text-xs text-foreground">{environment_name}</span>
						{environment_stage && (
							<span className="text-[10px] text-muted-foreground">
								{STAGE_LABEL[environment_stage] ?? environment_stage}
							</span>
						)}
					</div>
				);
			},
		},
		{
			id: "when",
			header: "Initiated",
			enableSorting: true,
			accessorFn: (row) => row.created_at,
			cell: ({ row }) => {
				const { created_at, user_id } = row.original;
				const author = user_id ? (authorById.get(user_id) ?? null) : null;
				return (
					<div className="flex items-center justify-end gap-2">
						{created_at && (
							<span className="whitespace-nowrap text-xs text-muted-foreground">
								{formatDistanceToNow(new Date(created_at), { addSuffix: true })}
							</span>
						)}
						<JobAuthor author={author} />
					</div>
				);
			},
		},
	);

	return columns;
}
