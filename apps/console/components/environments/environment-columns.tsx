"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The Environments table's columns: identity (name, default tag, what needs attention, its
// classification), stage, lifecycle status, drift, the gates into the environment, auto-heal, when
// it last changed, and the row's actions. Presentational — every write is the page's
// (`environments-view.tsx`), reached through the handlers.

import type { QueryKey } from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import { formatMonthlyRate } from "@repo/format";
import { Badge } from "@repo/ui/badge";
import { Button } from "@repo/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@repo/ui/dropdown-menu";
import { StatusBadge } from "@repo/ui/status-badge";
import { Check, MoreHorizontal, TriangleAlert } from "lucide-react";
import Link from "next/link";
import type { ProtectionSummary } from "@/app/server/actions/protection";
import type { EnvReconcileState } from "@/app/server/actions/reconcile";
import { ClassificationControl } from "@/components/classification/classification-control";
import { ARCHITECTURE } from "@/lib/copy/vocabulary";
import type { AssignedValue } from "@/lib/queries/classification";
import { envHref } from "@/lib/routing";
import type { EnvRow } from "@/lib/rpc/procedures/environments";
import { AutoHealSwitch } from "./auto-heal-switch";
import { RelativeStamp } from "./env-ui";
import { envLifecycleBadge, stageLabel } from "./environment-status";

/** One table row: the environment and everything the page read about it. */
export interface EnvironmentRow {
	id: string;
	env: EnvRow;
	reconcile: EnvReconcileState | undefined;
	protection: ProtectionSummary | undefined;
	/** Its classification chips; undefined until the batched read has answered. */
	classAssignments: AssignedValue[] | undefined;
	/** The project the environment belongs to — what its auto-heal write names. */
	projectId: string;
	/** The key of the read the page is showing, which an optimistic auto-heal change patches. */
	overviewKey: QueryKey;
}

/** The number of columns the table has — the skeleton draws the same count. */
export const ENVIRONMENT_COLUMN_COUNT = 8;

/** Why the default environment has no delete. */
export const DEFAULT_ENV_DELETE_REASON =
	"The default environment can't be deleted: it is the project's anchor.";

/** The gates a classification value tagged on this environment forces onto promotions into it. */
function inheritedGates(assignments: AssignedValue[] | undefined): string[] {
	const out: string[] = [];
	for (const a of assignments ?? []) {
		const e = a.enforcement;
		if (!e) continue;
		if (e.require_approval) {
			out.push(`${e.min_approvals > 1 ? `Approval ×${e.min_approvals}` : "Approval"} · ${a.value_label}`);
		}
		if (e.require_verify_pass) out.push(`Verify · ${a.value_label}`);
	}
	return out;
}

/** The protection rules that are ENFORCED, as short labels. */
function enforcedGates(p: ProtectionSummary | undefined): string[] {
	if (!p) return [];
	const out: string[] = [];
	if (p.require_predecessor) out.push("Predecessor");
	if (p.require_verify_pass) out.push("Verify");
	if (p.require_approval) out.push(p.min_count ? `Approval ×${p.min_count}` : "Approval");
	if (p.soak_minutes != null) out.push(`Soak ${p.soak_minutes}m`);
	if (p.cost_delta_threshold != null) out.push(`Cost ${formatMonthlyRate(p.cost_delta_threshold, "exact")}`);
	return out;
}

/** A gate, as a chip. */
const GATE_CHIP =
	"inline-flex items-center rounded-sm border border-border-strong bg-surface-muted px-1.5 py-0.5 font-mono text-ui-2xs text-text-primary";

/** What the columns need from the page. */
export interface EnvironmentColumnsOptions {
	org: string;
	project: string;
	/** Why the viewer cannot change environments, or null when they can (`manageReason`). */
	manageDenied: string | null;
	onEditRules: (env: EnvRow) => void;
	onEditAdmission: (env: EnvRow) => void;
	onDuplicate: (env: EnvRow) => void;
	onDelete: (env: EnvRow) => void;
}

/**
 * The columns. A control the viewer may not use is rendered disabled WITH its reason
 * (`manageDenied`), never hidden: the auto-heal switch through `DisabledReason` (`AutoHealSwitch`),
 * the row's menu items through their own `disabledReason`.
 */
export function buildEnvironmentColumns({
	org,
	project,
	manageDenied,
	onEditRules,
	onEditAdmission,
	onDuplicate,
	onDelete,
}: EnvironmentColumnsOptions): ColumnDef<EnvironmentRow>[] {
	return [
		{
			id: "environment",
			header: "Environment",
			accessorFn: (row) => row.env.name,
			cell: ({ row }) => {
				const { env, reconcile, classAssignments } = row.original;
				const clusterMissing = reconcile?.clusterMissing ?? null;
				const drifted = reconcile?.driftInSync === false;
				return (
					<div className="flex min-w-0 flex-col gap-1.5">
						<div className="flex flex-wrap items-center gap-2">
							<Link
								href={envHref(org, project, env.id)}
								className="font-mono text-ui-md font-medium text-text-primary hover:underline"
							>
								{env.name}
							</Link>
							{env.is_default && (
								<span className="shrink-0 rounded-full border px-1.5 py-px font-mono text-ui-3xs uppercase tracking-wide text-text-tertiary">
									Default
								</span>
							)}
							{reconcile?.deployPending && (
								<Badge variant="secondary" className="text-ui-2xs">
									Undeployed changes
								</Badge>
							)}
							{clusterMissing && (
								<Badge variant="destructive" className="gap-1.5 text-ui-2xs">
									<TriangleAlert className="size-3" aria-hidden />
									Cluster missing
								</Badge>
							)}
							{drifted && !clusterMissing && (
								<Badge variant="secondary" className="gap-1.5 text-ui-2xs">
									<TriangleAlert className="size-3" aria-hidden />
									Drifted
								</Badge>
							)}
						</div>
						<ClassificationControl
							kind="project_environment"
							id={env.id}
							canEdit={manageDenied === null}
							initialAssignments={classAssignments}
							label={env.name}
							compact
						/>
					</div>
				);
			},
		},
		{
			id: "stage",
			header: "Stage",
			accessorFn: (row) => row.env.stage,
			cell: ({ row }) => stageLabel(row.original.env.stage),
		},
		{
			id: "status",
			header: "Status",
			accessorFn: (row) => envLifecycleBadge(row.env.status).label,
			cell: ({ row }) => {
				const lifecycle = envLifecycleBadge(row.original.env.status);
				return <StatusBadge status={row.original.env.status} tier={lifecycle.tier} label={lifecycle.label} />;
			},
		},
		{
			id: "drift",
			header: "Drift",
			enableSorting: false,
			cell: ({ row }) => {
				const { reconcile } = row.original;
				if (reconcile?.clusterMissing) {
					return <span className="text-text-secondary">Cluster deleted outside Alethia</span>;
				}
				if (reconcile?.driftInSync === false) {
					return <span className="text-text-secondary">Diverged from deployed state</span>;
				}
				// Never scanned is not "in sync": nothing has compared the cloud with the state.
				if (reconcile?.driftInSync !== true) return <span className="text-text-tertiary">Not scanned</span>;
				return (
					<span className="inline-flex items-center gap-1.5">
						<Check className="size-3" aria-hidden />
						In sync
					</span>
				);
			},
		},
		{
			id: "gates",
			header: "Gates into it",
			enableSorting: false,
			cell: ({ row }) => {
				const own = enforcedGates(row.original.protection);
				const inherited = inheritedGates(row.original.classAssignments);
				if (own.length === 0 && inherited.length === 0) {
					return <span className="text-text-tertiary">None — any editor can promote in</span>;
				}
				return (
					<div className="flex max-w-xs flex-wrap gap-1">
						{own.map((gate) => (
							<span key={gate} className={GATE_CHIP}>
								{gate}
							</span>
						))}
						{inherited.map((gate) => (
							<span
								key={`inherited-${gate}`}
								className={`${GATE_CHIP} border-dashed`}
								title="Required by a classification on this environment"
							>
								{gate}
							</span>
						))}
					</div>
				);
			},
		},
		{
			id: "autoHeal",
			header: "Auto-heal",
			enableSorting: false,
			cell: ({ row }) => {
				const { env, reconcile, projectId, overviewKey } = row.original;
				return (
					<AutoHealSwitch
						projectId={projectId}
						environmentId={env.id}
						environmentName={env.name}
						enabled={reconcile?.autoHeal ?? false}
						overviewKey={overviewKey}
						deniedReason={manageDenied}
					/>
				);
			},
		},
		{
			id: "updated",
			header: "Updated",
			accessorFn: (row) => row.env.updated_at,
			cell: ({ row }) => <RelativeStamp at={row.original.env.updated_at} />,
		},
		{
			id: "actions",
			header: () => <span className="sr-only">Actions</span>,
			enableSorting: false,
			cell: ({ row }) => {
				const { env } = row.original;
				return (
					<div className="text-right">
						<DropdownMenu>
							<DropdownMenuTrigger
								render={
									<Button
										variant="ghost"
										size="icon"
										className="size-7"
										aria-label={`Environment actions for ${env.name}`}
									>
										<MoreHorizontal size={16} aria-hidden />
									</Button>
								}
							/>
							<DropdownMenuContent align="end" className="w-64">
								<DropdownMenuItem render={<Link href={envHref(org, project, env.id)} />}>
									Open in {ARCHITECTURE}
								</DropdownMenuItem>
								<DropdownMenuSeparator />
								<DropdownMenuItem disabledReason={manageDenied} onClick={() => onEditRules(env)}>
									Edit rules
								</DropdownMenuItem>
								{env.byo_admission_has_charts && (
									<DropdownMenuItem disabledReason={manageDenied} onClick={() => onEditAdmission(env)}>
										Change BYO admission
									</DropdownMenuItem>
								)}
								<DropdownMenuItem disabledReason={manageDenied} onClick={() => onDuplicate(env)}>
									Duplicate
								</DropdownMenuItem>
								<DropdownMenuItem
									className="text-destructive focus:text-destructive"
									disabledReason={manageDenied ?? (env.is_default ? DEFAULT_ENV_DELETE_REASON : null)}
									onClick={() => onDelete(env)}
								>
									Delete
								</DropdownMenuItem>
							</DropdownMenuContent>
						</DropdownMenu>
					</div>
				);
			},
		},
	];
}
