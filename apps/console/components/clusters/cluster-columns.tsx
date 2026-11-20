"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The clusters table's columns. A row LEADS WITH THE ENVIRONMENT: a project with three
// environments has three clusters, and titled by the project they were three rows with one name.

import type { ColumnDef } from "@tanstack/react-table";
import { ProviderIcon } from "@repo/ui/provider-icon";
import { StatusBadge } from "@repo/ui/status-badge";
import { Server } from "lucide-react";
import Link from "next/link";
import { cloudLabel, lastRunHref } from "@/components/clusters/cloud-label";
import { type Posture, clusterPosture } from "@/components/clusters/cluster-posture";
import { RelativeStamp } from "@/components/environments/env-ui";
import { projectHref } from "@/lib/routing";
import type { ClusterListItem } from "@/lib/rpc/procedures/clusters";

/** One table row: the cluster, its posture derived once, and the CLUSTER's id as the row's identity
 *  (`ClusterListItem.id` is its project's, which several rows share). */
export interface ClusterRow {
	id: string;
	cluster: ClusterListItem;
	posture: Posture;
}

/** The table rows for a page of clusters. */
export function clusterRows(clusters: readonly ClusterListItem[]): ClusterRow[] {
	return clusters.map((cluster) => ({
		id: cluster.project_cluster.id,
		cluster,
		posture: clusterPosture(cluster),
	}));
}

/** A link inside a clickable row: the click is the link's, not the row's. */
const LINK = "underline underline-offset-2 hover:text-text-primary";

/** The number of columns the table has for a route — the skeleton draws the same count. */
export function clusterColumnCount(showProject: boolean): number {
	return showProject ? 7 : 6;
}

/**
 * The columns. `showProject` is false on a project's own Clusters page, whose rows are all one
 * project's. `onOpen` opens a row's drawer; the environment cell is the row's real control, so the
 * drawer is reachable by Tab and named for assistive tech, not only by a click on the row.
 */
export function buildClusterColumns({
	showProject,
	orgSlug,
	onOpen,
}: {
	showProject: boolean;
	orgSlug: string;
	onOpen: (row: ClusterRow) => void;
}): ColumnDef<ClusterRow>[] {
	const columns: ColumnDef<ClusterRow>[] = [
		{
			id: "environment",
			header: "Environment",
			accessorFn: (row) => row.cluster.environment_stage,
			cell: ({ row }) => {
				const { cluster } = row.original;
				return (
					<div className="flex min-w-0 flex-col">
						<button
							type="button"
							className="w-fit max-w-full truncate text-left font-mono text-ui-md font-medium text-text-primary hover:underline"
							aria-label={`Open ${cluster.environment_stage} in ${cluster.project_name}`}
							onClick={(event) => {
								event.stopPropagation();
								onOpen(row.original);
							}}
						>
							{cluster.environment_stage}
						</button>
						{cluster.project_cluster.cluster_name && (
							<span className="truncate font-mono text-ui-2xs text-text-tertiary">
								{cluster.project_cluster.cluster_name}
							</span>
						)}
					</div>
				);
			},
		},
	];

	if (showProject) {
		columns.push({
			id: "project",
			header: "Project",
			accessorFn: (row) => row.cluster.project_name,
			cell: ({ row }) => {
				const { cluster } = row.original;
				if (!cluster.project_slug) return <span>{cluster.project_name}</span>;
				return (
					<Link
						href={projectHref(orgSlug, cluster.project_slug)}
						className={LINK}
						onClick={(event) => event.stopPropagation()}
					>
						{cluster.project_name}
					</Link>
				);
			},
		});
	}

	columns.push(
		{
			id: "status",
			header: "Status",
			accessorFn: (row) => row.posture.name,
			cell: ({ row }) => {
				const { cluster, posture } = row.original;
				const lastRunFailed = posture.rollupTier === "failed" && posture.rollup !== posture.name;
				return (
					<div className="flex flex-col gap-0.5">
						<StatusBadge status={posture.tier} tier={posture.tier} label={posture.name} />
						{lastRunFailed &&
							(cluster.last_job_id ? (
								<Link
									href={lastRunHref(orgSlug, cluster.last_job_id)}
									className={`text-ui-xs text-text-secondary ${LINK}`}
									onClick={(event) => event.stopPropagation()}
								>
									{posture.rollup}
								</Link>
							) : (
								<span className="text-ui-xs text-text-secondary">{posture.rollup}</span>
							))}
					</div>
				);
			},
		},
		{
			id: "cloud",
			header: "Cloud",
			accessorFn: (row) => `${cloudLabel(row.cluster) ?? ""} ${row.cluster.region}`,
			cell: ({ row }) => {
				const { cluster } = row.original;
				const provider = cluster.cloud_identities?.provider;
				return (
					<span className="flex items-center gap-2">
						{provider ? (
							<ProviderIcon provider={provider} size={16} decorative />
						) : (
							<Server className="size-4 text-text-tertiary" aria-hidden />
						)}
						<span>
							{cloudLabel(cluster) ?? "Unknown"}
							<span className="text-text-tertiary"> · {cluster.region}</span>
						</span>
					</span>
				);
			},
		},
		{
			id: "kubernetes",
			header: "Kubernetes",
			enableSorting: false,
			cell: ({ row }) => (
				<span className="font-mono text-ui-sm">{row.original.cluster.project_cluster.k8s_version ?? "—"}</span>
			),
		},
		{
			id: "components",
			header: "Components",
			enableSorting: false,
			cell: ({ row }) => (
				<span className="font-mono text-ui-sm tabular-nums">{row.original.posture.detail}</span>
			),
		},
		{
			id: "observed",
			header: "Last observed",
			enableSorting: false,
			cell: ({ row }) => {
				const at = row.original.cluster.project_cluster.observation.observedAt;
				return at ? <RelativeStamp at={at} /> : <span className="text-text-tertiary">Never</span>;
			},
		},
	);
	return columns;
}
