"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// One environment card — identity + drift/deploy badges, classification chips, the "gates into this
// env" protection summary, and a right rail (auto-heal + BYO admission + duplicate + delete). Presentational; the
// mutations are handled by the orchestrator — except a missing cluster's actions (#6736), which are
// the shared `MissingClusterActions` the cluster card renders too, so both offer the same three.

import { formatMonthlyRate } from "@repo/format";
import { Badge } from "@repo/ui/badge";
import { Button } from "@repo/ui/button";
import { Switch } from "@repo/ui/switch";
import { Check, Copy, Trash2, TriangleAlert } from "lucide-react";
import Link from "next/link";
import type { ProtectionSummary } from "@/app/server/actions/protection";
import type { EnvReconcileState } from "@/app/server/actions/reconcile";
import { ClassificationControl } from "@/components/classification/classification-control";
import { runInFlight } from "@/components/clusters/cluster-card-shape";
import { MissingClusterActions } from "@/components/clusters/missing-cluster-actions";
import type { AssignedValue } from "@/lib/queries/classification";
import { envHref } from "@/lib/routing";
import type { EnvRow } from "@/lib/rpc/procedures/environments";
import { RelativeStamp, StatusDot, type StatusTier } from "./env-ui";

/**
 * Gates a classification value tagged on this env forces onto promotions into it (the label drives
 * policy) — flattened to `{ label, source }` chips shown alongside the env's own rules.
 */
function inheritedGateChips(assignments: AssignedValue[] | undefined) {
	const out: { label: string; source: string }[] = [];
	for (const a of assignments ?? []) {
		const e = a.enforcement;
		if (!e) continue;
		if (e.require_approval)
			out.push({
				label: e.min_approvals > 1 ? `Approval ×${e.min_approvals}` : "Approval",
				source: a.value_label,
			});
		if (e.require_verify_pass) out.push({ label: "Verify", source: a.value_label });
	}
	return out;
}

/**
 * The environment's lifecycle badge, from its OWN status (#6736). It used to read `deployPending` —
 * "the design moved ahead of what was deployed" — and call that "Deploying", so an environment with
 * an unsaved edit and no job at all read as deploying for as long as the edit stayed undeployed.
 * Undeployed changes are now their own chip; this says what the lifecycle says.
 */
export function envLifecycleBadge(status: string): { tier: StatusTier; label: string } {
	switch (status) {
		case "QUEUED":
			return { tier: "pending", label: "Queued" };
		case "PROVISIONING":
			return { tier: "live", label: "Deploying" };
		case "DESTROYING":
			return { tier: "live", label: "Tearing down" };
		case "FAILED":
			return { tier: "failed", label: "Failed" };
		case "DRAFT":
			return { tier: "idle", label: "Draft" };
		case "DESTROYED":
			return { tier: "disabled", label: "Destroyed" };
		default:
			return { tier: "active", label: "Live" };
	}
}

/** The protection rules → gate chips (on = enforced, off = not required). */
function gateChips(p: ProtectionSummary | undefined) {
	if (!p) return [];
	return [
		{ label: "Predecessor", on: p.require_predecessor },
		{ label: "Verify", on: p.require_verify_pass },
		{
			label: p.require_approval && p.min_count ? `Approval ×${p.min_count}` : "Approval",
			on: p.require_approval,
		},
		{ label: p.soak_minutes != null ? `Soak ${p.soak_minutes}m` : "Soak", on: p.soak_minutes != null },
		{
			label:
				p.cost_delta_threshold != null
					? `Cost ${formatMonthlyRate(p.cost_delta_threshold, "exact")}`
					: "Cost",
			on: p.cost_delta_threshold != null,
		},
	];
}

export function EnvironmentCard({
	env,
	org,
	project,
	projectId,
	reconcile,
	protection,
	classAssignments,
	canEdit,
	onEditRules,
	onToggleHeal,
	onEditAdmission,
	onDuplicate,
	onDelete,
}: {
	env: EnvRow;
	org: string;
	project: string;
	/** The project's id — what a missing cluster's "Mark as destroyed" names. */
	projectId: string;
	reconcile: EnvReconcileState | undefined;
	protection: ProtectionSummary | undefined;
	classAssignments: AssignedValue[] | undefined;
	canEdit: boolean;
	onEditRules: () => void;
	onToggleHeal: (enabled: boolean) => void;
	/** Opens the BYO admission drawer (#6541). */
	onEditAdmission: () => void;
	onDuplicate: () => void;
	onDelete: () => void;
}) {
	const drifted = reconcile?.driftInSync === false;
	const deployPending = Boolean(reconcile?.deployPending);
	const clusterMissing = reconcile?.clusterMissing ?? null;
	const lifecycle = envLifecycleBadge(env.status);
	const isProd = env.stage === "production";
	const chips = gateChips(protection);
	const hasRules = chips.some((c) => c.on);
	const inherited = inheritedGateChips(classAssignments);

	return (
		<div className="grid grid-cols-1 gap-4 rounded-lg border bg-surface p-4 shadow-sm sm:grid-cols-[1fr_auto]">
			<div className="min-w-0">
				{/* identity */}
				<div className="flex flex-wrap items-center gap-2.5">
					<Link
						href={envHref(org, project, env.id)}
						className="font-mono text-ui-lg text-text-primary hover:underline"
					>
						{env.name}
					</Link>
					<StatusDot tier={lifecycle.tier} label={lifecycle.label} className="text-ui-xs" />
					{env.is_default && (
						<span className="shrink-0 rounded-full border px-1.5 py-px font-mono text-ui-3xs uppercase tracking-wide text-text-tertiary">
							Default
						</span>
					)}
					{deployPending && (
						<Badge variant="secondary" className="text-ui-2xs">
							Undeployed changes
						</Badge>
					)}
					{clusterMissing && (
						<Badge variant="destructive" className="gap-1.5 text-ui-2xs">
							<TriangleAlert className="size-3" />
							Cluster missing
						</Badge>
					)}
					{drifted && !clusterMissing && (
						<Badge variant="secondary" className="gap-1.5 text-ui-2xs">
							<TriangleAlert className="size-3" />
							Drifted
						</Badge>
					)}
				</div>

				{/* meta */}
				<div className="mt-1.5 flex items-center gap-2 text-ui-sm text-text-tertiary">
					{clusterMissing ? (
						clusterMissing.source === "drift" ? (
							<span>
								Drift scan <RelativeStamp at={clusterMissing.observedAt} /> reports deleted:{" "}
								<span className="font-mono">{clusterMissing.deleted.join(", ")}</span>
							</span>
						) : (
							<span>
								Probe <RelativeStamp at={clusterMissing.observedAt} /> found the cluster deleted
							</span>
						)
					) : drifted ? (
						<span>Diverged from provisioned state</span>
					) : reconcile?.driftInSync !== true ? (
						// Never scanned is not "in sync": nothing has compared the cloud with the state.
						<span>Not scanned for drift</span>
					) : (
						<span className="inline-flex items-center gap-1.5">
							<Check className="size-3" />
							In sync
						</span>
					)}
					{/* Inherits the row's tertiary ink at full strength — an alpha here composited to
					    a grey below 4.5:1 that no token could rescue (#4197). */}
					<span aria-hidden="true">·</span>
					<span>
						Updated <RelativeStamp at={env.updated_at} />
					</span>
				</div>

				{/* Nothing changes a missing cluster's status by itself: these are the ways out (#6736).
				    Not while a run is in flight — it will write its own outcome. */}
				{clusterMissing && canEdit && !runInFlight(env.status) && (
					<MissingClusterActions
						className="mt-2.5"
						orgSlug={org}
						projectSlug={project}
						projectId={projectId}
						environmentId={env.id}
						environmentName={env.name}
					/>
				)}

				{/* classification chips + picker */}
				<ClassificationControl
					kind="project_environment"
					id={env.id}
					canEdit={canEdit}
					initialAssignments={classAssignments}
					className="mt-2.5"
				/>

				{/* protection summary */}
				<div className="mt-3 border-t border-border-faint pt-3">
					<div className="mb-2 flex items-center gap-2">
						<span className="font-mono text-ui-2xs uppercase tracking-[0.14em] text-text-tertiary">
							Gates into this env
						</span>
						{canEdit && (
							<button
								type="button"
								onClick={onEditRules}
								className="ml-auto text-ui-sm text-text-secondary underline underline-offset-2 hover:text-text-primary"
							>
								Edit rules
							</button>
						)}
					</div>
					{hasRules && (
						<div className="flex flex-wrap gap-1.5">
							{chips.map((c) =>
								c.on ? (
									<span
										key={c.label}
										className="inline-flex items-center gap-1.5 rounded-[5px] border border-border-strong bg-surface-muted px-2 py-0.5 font-mono text-ui-xs text-text-primary"
									>
										<span className="size-[5px] rounded-full bg-[var(--signal-strong)]" />
										{c.label}
									</span>
								) : (
									<span
										key={c.label}
										className="rounded-[5px] border border-dashed border-border px-2 py-0.5 font-mono text-ui-xs text-text-disabled"
									>
										{c.label}
									</span>
								),
							)}
						</div>
					)}

					{/* Gates inherited from a classification value tagged on this env (label drives policy). */}
					{inherited.length > 0 && (
						<div className={hasRules ? "mt-2" : undefined}>
							<div className="mb-1.5 text-ui-2xs text-text-tertiary">
								Inherited from classification
							</div>
							<div className="flex flex-wrap gap-1.5">
								{inherited.map((c) => (
									<span
										key={`${c.label}-${c.source}`}
										className="inline-flex items-center gap-1.5 rounded-[5px] border border-dashed border-border-strong bg-surface-muted px-2 py-0.5 font-mono text-ui-xs text-text-primary"
										title={`Required because this env is classified ${c.source}`}
									>
										<span className="size-[5px] rounded-full bg-[var(--signal-strong)]" />
										{c.label}
										<span className="text-text-tertiary">· {c.source}</span>
									</span>
								))}
							</div>
						</div>
					)}

					{!hasRules && inherited.length === 0 && (
						<span className="text-ui-sm italic text-text-tertiary">
							No protection — any editor can promote in.
						</span>
					)}
				</div>
			</div>

			{/* right rail */}
			<div className="flex min-w-[148px] flex-col items-end justify-between gap-3 border-t border-border-faint pt-3 sm:border-l sm:border-t-0 sm:pl-4 sm:pt-0">
				<div className="w-full">
					<div className="mb-1.5 font-mono text-ui-2xs uppercase tracking-[0.12em] text-text-tertiary">
						Auto-heal
					</div>
					{canEdit ? (
						<Switch
							checked={reconcile?.autoHeal ?? false}
							onCheckedChange={onToggleHeal}
							aria-label={`Toggle auto-heal for ${env.name}`}
						/>
					) : (
						<span className="font-mono text-ui-sm text-text-secondary">
							{reconcile?.autoHeal ? "On" : "Off"}
						</span>
					)}
					{isProd && (
						<div className="mt-1.5 text-ui-2xs leading-tight text-text-tertiary">
							Gated for production
						</div>
					)}
				</div>
				{env.byo_admission_has_charts && (
					<div className="w-full">
						<div className="mb-1.5 font-mono text-ui-2xs uppercase tracking-[0.12em] text-text-tertiary">
							BYO admission
						</div>
						<div className="flex items-center gap-2">
							<span className="font-mono text-ui-sm text-text-secondary">
								{env.byo_admission_enforce ? "Refuse" : "Report"}
							</span>
							{canEdit && (
								<button
									type="button"
									onClick={onEditAdmission}
									aria-label={`Change BYO admission for ${env.name}`}
									className="text-ui-sm text-text-secondary underline underline-offset-2 hover:text-text-primary"
								>
									Change
								</button>
							)}
						</div>
						{env.byo_admission_pending && (
							<div className="mt-1.5 text-ui-2xs leading-tight text-text-tertiary">
								Redeploy to apply
							</div>
						)}
					</div>
				)}
				{canEdit && (
					<div className="flex gap-1">
						<Button
							type="button"
							variant="ghost"
							size="icon"
							className="size-8 text-text-tertiary hover:text-text-primary"
							title="Duplicate"
							onClick={onDuplicate}
						>
							<Copy className="size-4" />
						</Button>
						{!env.is_default && (
							<Button
								type="button"
								variant="ghost"
								size="icon"
								className="size-8 text-text-tertiary hover:text-destructive"
								title="Delete"
								onClick={onDelete}
							>
								<Trash2 className="size-4" />
							</Button>
						)}
					</div>
				)}
			</div>
		</div>
	);
}
