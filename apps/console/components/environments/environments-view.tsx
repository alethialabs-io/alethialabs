"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The project's Environments surface. Opens with the page toolbar (the environment count, one line
// of description, New Environment / Promote) — NO page title: the sidebar entry and the breadcrumb
// already name the page (F010). Then the active-promotion panel (when a promotion is in flight), the
// environments spine (grouped by stage, each with drift/deploy, classification, the "gates into this
// env" protection summary, and auto-heal/duplicate/delete), a consistency matrix, and the promotions
// history. Destructive/confirm actions go through the shared ConfirmDialog.
//
// DATA (#6120, ADR 0005). Everything here is ONE read, `environments.overview`, which the route
// prefetches on the server and hydrates — so the first paint carries it and nothing is fetched on
// mount. It is live by the change stream: an environment, a promotion, an approval slot or a
// protection rule that changes is an `environments` hint that invalidates this read
// (lib/query/topics.ts); a job that moves a promotion or a reconcile badge is a `jobs` hint. Every
// write goes through `useActionMutation` and invalidates the reads that show what it changed.

import { useQuery } from "@tanstack/react-query";
import { isDefinedError } from "@orpc/client";
import { ArrowUpFromLine, Lock, Plus } from "lucide-react";
import { useState } from "react";
import { deleteEnvironment, setAutoHeal } from "@/app/server/actions/projects";
import {
	approvePromotion,
	cancelPromotion,
	rejectPromotion,
} from "@/app/server/actions/promotions";
import type { SwitcherEnv } from "@/app/server/actions/resolve";
import { ConfirmDialog } from "@/components/alerts/confirm-dialog";
import { RegionError } from "@/components/errors/region-error";
import { NewEnvironmentDialog } from "@/components/environments/new-environment-dialog";
import { ProtectionRulesDialog } from "@/components/environments/protection-rules-dialog";
import { PromoteDialog } from "@/components/environments/promote-dialog";
import { useActionMutation } from "@/lib/actions/use-action-mutation";
import { useAssignmentsForKind } from "@/lib/query/use-classification-query";
import { orpc } from "@/lib/rpc/client";
import type { EnvironmentsOverview, EnvRow } from "@/lib/rpc/procedures/environments";
import { Button } from "@repo/ui/button";
import {
	Empty,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyState,
	EmptyTitle,
} from "@repo/ui/empty";
import { PageToolbar } from "@repo/ui/page-toolbar";
import { ActivePromotionPanel } from "./active-promotion-panel";
import { ConsistencyMatrix } from "./consistency-matrix";
import { EnvironmentCard } from "./environment-card";
import { EnvironmentsSkeleton } from "./environments-skeleton";
import { PromotionDetailOverlay } from "./promotion-detail-overlay";
import { PromotionsHistory } from "./promotions-history";
import { settleThrown } from "./settle-action";

const STAGE_ORDER = ["development", "staging", "production"];
const STAGE_LABEL: Record<string, string> = {
	development: "Development",
	staging: "Staging",
	production: "Production",
};

/** The page's one line of supporting copy (the breadcrumb already names the page). */
const DESCRIPTION = "Isolated instances of this project's services.";

/**
 * The Environments page for the project `project` (its slug) of org `org`. Reads the page's data
 * through the `environments.overview` query the route prefetched, and renders the four states of
 * that read distinctly (RUBRIC B4): pending (the route's own skeleton), refused (forbidden, or a
 * project that is not there), failed (a region error with a retry), and the data.
 */
export function EnvironmentsView({ org, project }: { org: string; project: string }) {
	const overview = useQuery(orpc.environments.overview.queryOptions({ input: { project } }));

	if (overview.data === undefined) {
		if (!overview.isError) return <EnvironmentsSkeleton />;
		const code = isDefinedError(overview.error) ? overview.error.code : null;
		if (code === "FORBIDDEN") {
			return (
				<Empty className="min-h-[60vh]" data-state="forbidden">
					<EmptyHeader>
						<EmptyMedia variant="icon">
							<Lock />
						</EmptyMedia>
						<EmptyTitle>You can&apos;t view this project&apos;s environments</EmptyTitle>
						<EmptyDescription>
							Your role in this organization does not include viewing this project. An admin can
							grant it.
						</EmptyDescription>
					</EmptyHeader>
				</Empty>
			);
		}
		if (code === "NOT_FOUND") {
			return (
				<Empty className="min-h-[60vh]" data-state="not-found">
					<EmptyHeader>
						<EmptyTitle>This project is not here</EmptyTitle>
						<EmptyDescription>
							It may have been deleted, or it belongs to another organization.
						</EmptyDescription>
					</EmptyHeader>
				</Empty>
			);
		}
		return (
			<RegionError
				className="min-h-[60vh]"
				title="Couldn't load environments"
				description="Something went wrong fetching this project's environments. Check your connection and try again."
				onRetry={() => void overview.refetch()}
			/>
		);
	}

	return <EnvironmentsBody org={org} project={project} data={overview.data} />;
}

/** The page with its data: the toolbar, the panels, and every write the page offers. */
function EnvironmentsBody({
	org,
	project,
	data,
}: {
	org: string;
	project: string;
	data: EnvironmentsOverview;
}) {
	const { projectId, envs, consistency, reconcile, promotions, activePromotion, protectionByEnv } =
		data;
	const [createOpen, setCreateOpen] = useState(false);
	const [duplicateFrom, setDuplicateFrom] = useState<EnvRow | null>(null);
	const [promoteOpen, setPromoteOpen] = useState(false);
	const [protectFor, setProtectFor] = useState<EnvRow | null>(null);
	const [pendingDelete, setPendingDelete] = useState<EnvRow | null>(null);
	const [detailOpen, setDetailOpen] = useState(false);
	const [confirmReject, setConfirmReject] = useState(false);
	const [confirmCancel, setConfirmCancel] = useState(false);

	// Every read that shows an environment or a promotion: this page's, and the topbar switcher's.
	const environmentReads = [orpc.environments.key(), orpc.workspace.environments.key()];

	const approve = useActionMutation(approvePromotion, {
		invalidates: [orpc.environments.key()],
		successMessage: "Promotion approved",
	});
	const reject = useActionMutation(rejectPromotion, {
		invalidates: [orpc.environments.key()],
		successMessage: "Promotion rejected",
	});
	const cancel = useActionMutation(cancelPromotion, {
		invalidates: [orpc.environments.key()],
		successMessage: "Promotion cancelled",
	});
	const remove = useActionMutation(
		(env: EnvRow) =>
			settleThrown(async () => {
				await deleteEnvironment(projectId, env.id);
				return env.name;
			}),
		{
			invalidates: environmentReads,
			successMessage: (name) => `Deleted ${name}`,
		},
	);
	const heal = useActionMutation(
		(request: { env: EnvRow; enabled: boolean }) =>
			settleThrown(async () => {
				await setAutoHeal(projectId, request.env.id, request.enabled);
				return request;
			}),
		{
			invalidates: [orpc.environments.key()],
			successMessage: (r) => `Auto-heal ${r.enabled ? "on" : "off"} for ${r.env.name}`,
		},
	);
	const deciding = approve.isPending || reject.isPending || cancel.isPending;

	const switcherEnvs: SwitcherEnv[] = envs.map((e) => ({
		id: e.id,
		project_id: projectId,
		name: e.name,
		stage: e.stage,
		is_default: e.is_default,
	}));
	const reconcileById = new Map(reconcile.map((r) => [r.environmentId, r]));
	const envName = (id: string) => envs.find((e) => e.id === id)?.name ?? "—";
	const { data: classMap = {} } = useAssignmentsForKind(
		"project_environment",
		envs.map((e) => e.id),
	);

	/** Group environments by stage in dev → staging → prod order. */
	const groups = STAGE_ORDER.map((stage) => ({
		stage,
		label: STAGE_LABEL[stage] ?? stage,
		envs: envs.filter((e) => e.stage === stage),
	})).filter((g) => g.envs.length > 0);

	return (
		<div className="space-y-8">
			{/* The count rides the toolbar's pill — the console's one place for a result count. */}
			<PageToolbar
				count={envs.length}
				description={DESCRIPTION}
				actions={
					<>
						<Button size="sm" onClick={() => setCreateOpen(true)}>
							<Plus className="mr-1.5 size-3.5" />
							New Environment
						</Button>
						{envs.length > 1 && (
							<Button size="sm" variant="outline" onClick={() => setPromoteOpen(true)}>
								<ArrowUpFromLine className="mr-1.5 size-3.5" />
								Promote
							</Button>
						)}
					</>
				}
			/>

			{/* Active promotion */}
			{activePromotion && (
				<ActivePromotionPanel
					detail={activePromotion}
					canApprove={
						activePromotion.status === "PENDING_APPROVAL" &&
						activePromotion.approved < activePromotion.required
					}
					canCancel={["PENDING_PLAN", "PENDING_APPROVAL", "DEPLOYING"].includes(
						activePromotion.status,
					)}
					busy={deciding}
					onApprove={() => {
						if (!deciding) approve.mutate({ promotionId: activePromotion.id });
					}}
					onReject={() => setConfirmReject(true)}
					onCancel={() => setConfirmCancel(true)}
					onOpenDetail={() => setDetailOpen(true)}
				/>
			)}

			{/* Environments spine */}
			<section className="space-y-4" aria-label="Environments">
				{groups.map((g) => (
					<div key={g.stage} className="space-y-2.5">
						<div className="font-mono text-ui-2xs uppercase tracking-[0.16em] text-text-tertiary">
							{g.label}
						</div>
						{g.envs.map((env) => (
							<EnvironmentCard
								key={env.id}
								env={env}
								org={org}
								project={project}
								reconcile={reconcileById.get(env.id)}
								protection={protectionByEnv[env.id]}
								classAssignments={classMap[env.id]}
								canEdit
								onEditRules={() => setProtectFor(env)}
								onToggleHeal={(enabled) => {
									if (!heal.isPending) heal.mutate({ env, enabled });
								}}
								onDuplicate={() => {
									setDuplicateFrom(env);
									setCreateOpen(true);
								}}
								onDelete={() => setPendingDelete(env)}
							/>
						))}
					</div>
				))}

				{/* Two states, not one. The predicate here used to be `<= 1`, which folded the
				    empty list into the one-environment hint and asserted "Only one environment"
				    over nothing at all. */}
				{envs.length === 0 && (
					<EmptyState
						level={3}
						className="border border-dashed border-border-strong"
						title="No environments"
						description="Create one to deploy this project, then add a second to promote changes up a chain."
					/>
				)}

				{/* A note under a POPULATED list, so NOT an `EmptyState`: that is a centred panel at
				    `p-6 md:p-12` with an 18px headline, and sitting under the one environment card
				    it reads as "this list is empty" when it is not. */}
				{envs.length === 1 && (
					<p className="rounded-lg border border-dashed border-border-strong px-4 py-3 text-ui-md text-text-tertiary">
						Only one environment. Create another to compare configuration and promote
						changes up the chain.
					</p>
				)}
			</section>

			{consistency.rows.length > 0 && <ConsistencyMatrix consistency={consistency} />}
			{promotions.length > 0 && (
				<PromotionsHistory
					promotions={promotions}
					envName={envName}
					onView={() => setDetailOpen(true)}
				/>
			)}

			{/* Overlays */}
			<NewEnvironmentDialog
				open={createOpen}
				onOpenChange={(o) => {
					setCreateOpen(o);
					if (!o) setDuplicateFrom(null);
				}}
				projectId={projectId}
				envs={switcherEnvs}
				defaultBaseId={duplicateFrom?.id}
				// The dialog invalidates this page's read and the switcher's itself.
				onCreated={() => {}}
			/>
			<PromoteDialog
				open={promoteOpen}
				onOpenChange={setPromoteOpen}
				projectId={projectId}
				envs={envs.map((e) => ({ id: e.id, name: e.name, stage: e.stage }))}
				// The promote mutation invalidates this page's read itself.
				onPromoted={() => {}}
			/>
			{protectFor && (
				<ProtectionRulesDialog
					open={!!protectFor}
					onOpenChange={(o) => !o && setProtectFor(null)}
					projectId={projectId}
					envId={protectFor.id}
					envName={protectFor.name}
				/>
			)}
			<PromotionDetailOverlay
				detail={detailOpen ? activePromotion : null}
				onClose={() => setDetailOpen(false)}
			/>

			<ConfirmDialog
				open={!!pendingDelete}
				onOpenChange={(o) => !o && setPendingDelete(null)}
				title={`Delete ${pendingDelete?.name ?? "environment"}?`}
				description="This permanently deletes the environment and its staged configuration. Provisioned infrastructure is not destroyed. This cannot be undone."
				confirmLabel="Delete environment"
				onConfirm={() => {
					if (pendingDelete && !remove.isPending) remove.mutate(pendingDelete);
				}}
			/>
			<ConfirmDialog
				open={confirmReject}
				onOpenChange={setConfirmReject}
				title="Reject this promotion?"
				description="The promotion is cancelled and nothing is deployed. The initiator can start a new one."
				confirmLabel="Reject promotion"
				onConfirm={() => {
					if (activePromotion && !deciding) reject.mutate({ promotionId: activePromotion.id });
				}}
			/>
			<ConfirmDialog
				open={confirmCancel}
				onOpenChange={setConfirmCancel}
				title="Cancel this promotion?"
				description="The in-flight promotion is stopped. Nothing further is deployed."
				confirmLabel="Cancel promotion"
				onConfirm={() => {
					if (activePromotion && !deciding) cancel.mutate({ promotionId: activePromotion.id });
				}}
			/>
		</div>
	);
}
