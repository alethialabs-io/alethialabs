"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { formatDistanceToNow, parseISO } from "date-fns";
import { ArrowUpFromLine, Layers, Plus, ShieldCheck, Trash2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import {
	deleteEnvironment,
	type EnvConsistency,
	setAutoHeal,
} from "@/app/server/actions/projects";
import {
	approvePromotion,
	rejectPromotion,
} from "@/app/server/actions/promotions";
import type { EnvReconcileState } from "@/app/server/actions/reconcile";
import type { SwitcherEnv } from "@/app/server/actions/resolve";
import { ConfirmDialog } from "@/components/alerts/confirm-dialog";
import { ClassificationControl } from "@/components/classification/classification-control";
import { useAssignmentsForKind } from "@/lib/query/use-classification-query";
import { NewEnvironmentDialog } from "@/components/environments/new-environment-dialog";
import { ProtectionRulesDialog } from "@/components/environments/protection-rules-dialog";
import { PromoteDialog } from "@/components/environments/promote-dialog";
import { envHref } from "@/lib/routing";
import { Badge } from "@repo/ui/badge";
import { Button } from "@repo/ui/button";
import { Switch } from "@repo/ui/switch";

/** Docs entry for the header "Read the docs" link. */
const ENV_DOCS_HREF = "/docs/concepts/environments";

/** One environment row (serialized from the DB — `updated_at` is an ISO string). */
export interface EnvRow {
	id: string;
	name: string;
	stage: string;
	is_default: boolean;
	updated_at: string;
}

/** A promotion row projected for the client. */
export interface PromotionRowView {
	id: string;
	source_environment_id: string;
	target_environment_id: string;
	status: string;
	error_message: string | null;
	created_at: string;
}

/**
 * The project's Environments view: lists environments with day-2 stability badges (drift, deploy
 * pending) + an auto-heal toggle, hosts create/duplicate/delete, promotion (with a diff preview),
 * per-env protection rules, a cross-environment consistency matrix, and recent promotions.
 */
export function EnvironmentsView({
	org,
	project,
	projectId,
	envs,
	consistency,
	reconcile,
	promotions,
}: {
	org: string;
	project: string;
	projectId: string;
	envs: EnvRow[];
	consistency: EnvConsistency;
	reconcile: EnvReconcileState[];
	promotions: PromotionRowView[];
}) {
	const router = useRouter();
	const [createOpen, setCreateOpen] = useState(false);
	const [promoteOpen, setPromoteOpen] = useState(false);
	const [protectFor, setProtectFor] = useState<EnvRow | null>(null);
	const [pendingDelete, setPendingDelete] = useState<EnvRow | null>(null);

	const switcherEnvs: SwitcherEnv[] = envs.map((e) => ({
		id: e.id,
		project_id: projectId,
		name: e.name,
		stage: e.stage,
		is_default: e.is_default,
	}));
	const reconcileById = new Map(reconcile.map((r) => [r.environmentId, r]));
	const envName = (id: string) => envs.find((e) => e.id === id)?.name ?? "—";
	// One batched query hydrates every environment row's classification chips.
	const { data: classMap = {} } = useAssignmentsForKind(
		"project_environment",
		envs.map((e) => e.id),
	);

	/** Delete a non-default environment, then re-fetch. */
	const handleDelete = async (env: EnvRow) => {
		try {
			await deleteEnvironment(projectId, env.id);
			toast.success(`Deleted ${env.name}`);
			router.refresh();
		} catch (e) {
			toast.error(e instanceof Error ? e.message : "Failed to delete environment");
		}
	};

	/** Toggle auto-heal for an environment. */
	const handleAutoHeal = async (env: EnvRow, enabled: boolean) => {
		try {
			await setAutoHeal(projectId, env.id, enabled);
			toast.success(`Auto-heal ${enabled ? "on" : "off"} for ${env.name}`);
			router.refresh();
		} catch (e) {
			toast.error(e instanceof Error ? e.message : "Failed to update auto-heal");
		}
	};

	return (
		<div className="mx-auto max-w-3xl space-y-10">
			<header className="space-y-1">
				<h1 className="text-lg font-semibold">Environments</h1>
				<p className="text-sm text-muted-foreground">
					Each environment gives you an isolated instance of every service.{" "}
					<Link
						href={ENV_DOCS_HREF}
						className="font-medium text-foreground underline underline-offset-2"
					>
						Read the docs
					</Link>
				</p>
			</header>

			<section className="space-y-3">
				<div className="divide-y divide-border rounded-lg border border-border">
					{envs.map((env) => {
						const r = reconcileById.get(env.id);
						return (
							<div key={env.id} className="flex items-center gap-3 px-4 py-3">
								<Layers className="h-4 w-4 shrink-0 text-muted-foreground" />
								<div className="min-w-0 flex-1">
									<div className="flex flex-wrap items-center gap-2">
										<Link
											href={envHref(org, project, env.id)}
											className="truncate font-mono text-sm hover:underline"
										>
											{env.name}
										</Link>
										{env.is_default && <StaticTag>Default</StaticTag>}
										{r?.driftInSync === false && (
											<Badge variant="outline" className="text-[10px]">Drift</Badge>
										)}
										{r?.deployPending && (
											<Badge variant="outline" className="text-[10px]">Deploy pending</Badge>
										)}
									</div>
									<p className="mt-0.5 text-xs text-muted-foreground">
										Updated{" "}
										{formatDistanceToNow(parseISO(env.updated_at), { addSuffix: true })}
									</p>
									{/* Classification (Workstream B) — chips + a "Classify" picker for org editors. */}
									<ClassificationControl
										kind="project_environment"
										id={env.id}
										canEdit
										initialAssignments={classMap[env.id]}
										className="mt-1.5"
									/>
								</div>

								{/* Auto-heal toggle (dev/staging re-apply on drift; prod stays gated). */}
								<label className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
									Auto-heal
									<Switch
										checked={r?.autoHeal ?? false}
										onCheckedChange={(v) => handleAutoHeal(env, v)}
										aria-label={`Toggle auto-heal for ${env.name}`}
									/>
								</label>

								<Button
									type="button"
									variant="ghost"
									size="icon"
									className="h-8 w-8 text-muted-foreground hover:text-foreground"
									onClick={() => setProtectFor(env)}
									aria-label={`Protection rules for ${env.name}`}
								>
									<ShieldCheck className="h-4 w-4" />
								</Button>
								{!env.is_default && (
									<Button
										type="button"
										variant="ghost"
										size="icon"
										className="h-8 w-8 text-muted-foreground hover:text-destructive"
										onClick={() => setPendingDelete(env)}
										aria-label={`Delete ${env.name}`}
									>
										<Trash2 className="h-4 w-4" />
									</Button>
								)}
							</div>
						);
					})}
				</div>
				<div className="flex gap-2">
					<Button type="button" size="sm" onClick={() => setCreateOpen(true)}>
						<Plus className="mr-1.5 h-3.5 w-3.5" />
						New Environment
					</Button>
					{envs.length > 1 && (
						<Button
							type="button"
							size="sm"
							variant="outline"
							onClick={() => setPromoteOpen(true)}
						>
							<ArrowUpFromLine className="mr-1.5 h-3.5 w-3.5" />
							Promote
						</Button>
					)}
				</div>
			</section>

			{/* Consistency matrix — where the environments' designs diverge. */}
			{consistency.rows.length > 0 && (
				<section className="space-y-3 border-t border-border pt-8">
					<div>
						<h2 className="text-sm font-medium">Consistency</h2>
						<p className="mt-1 text-xs text-muted-foreground">
							Which services each environment defines, and where they diverge.
						</p>
					</div>
					<div className="overflow-x-auto rounded-lg border border-border">
						<table className="w-full text-xs">
							<thead>
								<tr className="border-b border-border bg-muted/30">
									<th className="px-3 py-2 text-left font-medium">Component</th>
									{consistency.envs.map((e) => (
										<th key={e.id} className="px-3 py-2 text-center font-mono font-normal">
											{e.name}
										</th>
									))}
								</tr>
							</thead>
							<tbody>
								{consistency.rows.map((row) => (
									<tr key={`${row.component_type}-${row.key}`} className="border-b border-border last:border-0">
										<td className="px-3 py-1.5">
											<span className="text-muted-foreground">{row.component_type}</span>{" "}
											<span className="font-mono">{row.key}</span>
										</td>
										{consistency.envs.map((e) => (
											<td key={e.id} className="px-3 py-1.5 text-center">
												<ConsistencyCell state={row.perEnv[e.id]} />
											</td>
										))}
									</tr>
								))}
							</tbody>
						</table>
					</div>
				</section>
			)}

			{/* Recent promotions. */}
			{promotions.length > 0 && (
				<section className="space-y-3 border-t border-border pt-8">
					<h2 className="text-sm font-medium">Promotions</h2>
					<div className="divide-y divide-border rounded-lg border border-border">
						{promotions.slice(0, 8).map((p) => (
							<div key={p.id} className="flex items-center gap-3 px-4 py-2.5">
								<div className="min-w-0 flex-1 text-xs">
									<span className="font-mono">{envName(p.source_environment_id)}</span>
									{" → "}
									<span className="font-mono">{envName(p.target_environment_id)}</span>
									<span className="ml-2 text-muted-foreground">
										{formatDistanceToNow(parseISO(p.created_at), { addSuffix: true })}
									</span>
									{p.error_message && (
										<span className="block text-[11px] text-muted-foreground">
											{p.error_message}
										</span>
									)}
								</div>
								<PromotionStatusBadge status={p.status} />
								{p.status === "PENDING_APPROVAL" && (
									<div className="flex gap-1.5">
										<ApprovalButtons promotionId={p.id} onDone={() => router.refresh()} />
									</div>
								)}
							</div>
						))}
					</div>
				</section>
			)}

			<NewEnvironmentDialog
				open={createOpen}
				onOpenChange={setCreateOpen}
				projectId={projectId}
				envs={switcherEnvs}
				onCreated={() => router.refresh()}
			/>
			<PromoteDialog
				open={promoteOpen}
				onOpenChange={setPromoteOpen}
				projectId={projectId}
				envs={envs.map((e) => ({ id: e.id, name: e.name, stage: e.stage }))}
				onPromoted={() => router.refresh()}
			/>
			{protectFor && (
				<ProtectionRulesDialog
					open={!!protectFor}
					onOpenChange={(o) => {
						if (!o) setProtectFor(null);
					}}
					projectId={projectId}
					envId={protectFor.id}
					envName={protectFor.name}
				/>
			)}
			<ConfirmDialog
				open={!!pendingDelete}
				onOpenChange={(o) => {
					if (!o) setPendingDelete(null);
				}}
				title={`Delete ${pendingDelete?.name ?? "environment"}?`}
				description="This permanently deletes the environment and its staged configuration. Provisioned infrastructure is not destroyed. This cannot be undone."
				confirmLabel="Delete environment"
				onConfirm={() => {
					if (pendingDelete) void handleDelete(pendingDelete);
				}}
			/>
		</div>
	);
}

/** A muted, bordered mono tag (e.g. the Default marker). */
function StaticTag({ children }: { children: React.ReactNode }) {
	return (
		<span className="shrink-0 rounded border px-1.5 py-px font-mono text-[9px] uppercase tracking-wide text-muted-foreground">
			{children}
		</span>
	);
}

/** A single consistency-matrix cell: present · differs ! absent –. */
function ConsistencyCell({ state }: { state: "present" | "differs" | "absent" }) {
	if (state === "present") return <span className="text-foreground">●</span>;
	if (state === "differs")
		return <span className="font-semibold text-foreground" title="Differs across environments">≠</span>;
	return <span className="text-muted-foreground/40">–</span>;
}

/** Approve / Reject buttons for a pending promotion. */
function ApprovalButtons({
	promotionId,
	onDone,
}: {
	promotionId: string;
	onDone: () => void;
}) {
	const [busy, setBusy] = useState(false);
	const act = async (fn: () => Promise<void>, ok: string) => {
		setBusy(true);
		try {
			await fn();
			toast.success(ok);
			onDone();
		} catch (e) {
			toast.error(e instanceof Error ? e.message : "Action failed");
		} finally {
			setBusy(false);
		}
	};
	return (
		<>
			<Button
				type="button"
				size="sm"
				variant="outline"
				className="h-7 px-2 text-xs"
				disabled={busy}
				onClick={() => act(() => rejectPromotion(promotionId), "Promotion rejected")}
			>
				Reject
			</Button>
			<Button
				type="button"
				size="sm"
				className="h-7 px-2 text-xs"
				disabled={busy}
				onClick={() => act(() => approvePromotion(promotionId), "Promotion approved")}
			>
				Approve
			</Button>
		</>
	);
}

/** A status badge for a promotion. */
function PromotionStatusBadge({ status }: { status: string }) {
	const label = status.replace(/_/g, " ").toLowerCase();
	return (
		<Badge variant="outline" className="shrink-0 text-[10px] uppercase tracking-wide">
			{label}
		</Badge>
	);
}
