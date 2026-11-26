"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The project's Environments surface. Opens with the page toolbar (one line of description, New
// Environment / Promote; no count, lib/query/README.md → "Counts") — NO page title: the sidebar
// entry and the breadcrumb already name the page (F010). Then what needs a decision (a failed
// environment that may still hold cloud resources, a cluster found deleted), the active-promotion
// panel (when a promotion is in flight), the environments LIST — the filter bar and the table — a
// consistency matrix, and the promotions history. Destructive actions go through the shared ConfirmAction.
//
// DATA (#6120, ADR 0005; LST-3 #7485). Three reads, each prefetched by the route on the server and
// hydrated, so the first paint carries them and nothing is fetched on mount:
//   · `environments.overview` — every environment and the panels' facts (the failure notices, the
//     active promotion, the matrix, the promote dialog), which need EVERY environment whatever the
//     bar selects;
//   · `environments.page` — the TABLE's rows, one keyset page at a time, paged in memory on the
//     server (lib/queries/environments.ts) and joined here to the overview's record of each;
//   · `environments.promotions` — the promotions history, its own SQL keyset read
//     (./promotions-history.tsx).
// All three are live by the change stream: an environment, a promotion, an approval slot or a
// protection rule that changes is an `environments` hint that invalidates `orpc.environments.key()`
// — a prefix of every one of their keys (lib/query/topics.ts); a job that moves a promotion or a
// reconcile badge is a `jobs` hint. Every write goes through `useActionMutation` and invalidates the
// reads that show what it changed.
//
// THE LIST IS ON THE FILTER STANDARD (lib/query/README.md). The bar's selections are a store
// mirrored into the URL; the normalized query is the table read's key, so the SERVER decides which
// environments match and counts the facets over all of them; the previous rows stay, dimmed, while
// the next answer loads. The project is the route's scope and is never a filter.

import { useQuery } from "@tanstack/react-query";
import { Alert, AlertDescription, AlertTitle } from "@repo/ui/alert";
import { Button } from "@repo/ui/button";
import { DisabledReason } from "@repo/ui/disabled-reason";
import { EmptyState } from "@repo/ui/empty";
import { PageToolbar } from "@repo/ui/page-toolbar";
import { cn } from "@repo/ui/utils";
import { ArrowUpFromLine, Layers, Plus, SearchX, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { useCallback, useMemo, useState } from "react";
import { deleteEnvironment } from "@/app/server/actions/projects";
import {
	approvePromotion,
	cancelPromotion,
	rejectPromotion,
} from "@/app/server/actions/promotions";
import type { SwitcherEnv } from "@/app/server/actions/resolve";
import { runInFlight } from "@/components/clusters/cluster-posture";
import { MissingClusterActions } from "@/components/clusters/missing-cluster-actions";
import { ConfirmAction } from "@/components/confirm/confirm-action";
import { DataTable } from "@/components/data-table";
import { ByoAdmissionSheet } from "@/components/environments/byo-admission-sheet";
import { NewEnvironmentDialog } from "@/components/environments/new-environment-dialog";
import { PromoteDialog } from "@/components/environments/promote-dialog";
import { ProtectionRulesDialog } from "@/components/environments/protection-rules-dialog";
import { manageReason } from "@/components/errors/manage-gate";
import { RegionError } from "@repo/ui/region-error";
import { RegionRefusal } from "@/components/errors/region-refusal";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { useFilterUrlSync } from "@/hooks/use-filter-url-sync";
import { useActionMutation } from "@/lib/actions/use-action-mutation";
import { JOB_ACTION } from "@/lib/copy/vocabulary";
import { useAssignmentsForKind } from "@/lib/query/use-classification-query";
import { type KeysetList, useKeysetList } from "@/lib/query/use-keyset-list";
import type { EnvironmentFacetSet, EnvironmentFacts } from "@/lib/queries/environments";
import { envHref } from "@/lib/routing";
import { orpc } from "@/lib/rpc/client";
import type { EnvironmentsOverview, EnvRow } from "@/lib/rpc/procedures/environments";
import { readRefusalOf } from "@/lib/rpc/refusal";
import { useEnvironmentsFilters } from "@/lib/stores/use-environments-filters";
import { ActivePromotionPanel } from "./active-promotion-panel";
import { ConsistencyMatrix } from "./consistency-matrix";
import { type EnvironmentRow, buildEnvironmentColumns } from "./environment-columns";
import { mayHoldResources } from "./environment-status";
import { EnvironmentsFilterBar } from "./environments-filter-bar";
import { DEFAULT_ENVIRONMENT_FILTERS, normalizeEnvironmentsQuery } from "./environments-query";
import { ENVIRONMENTS_REGION, EnvironmentsSkeleton } from "./environments-skeleton";
import { PromotionDetailOverlay } from "./promotion-detail-overlay";
import { PromotionsHistory } from "./promotions-history";

/** The page's one line of supporting copy (the breadcrumb already names the page). */
const DESCRIPTION = "Isolated instances of this project's services.";

/**
 * What the delete confirmation says before anything is sent: the rule the server applies
 * (`deleteEnvironment` refuses a live or in-flight environment), then what the delete does and
 * does not do.
 */
export const DELETE_RULE =
	"An environment that is live or in flight cannot be deleted: destroy it first. Deleting removes the following and destroys nothing in the cloud. This cannot be undone.";

/**
 * What the delete confirmation says for an environment whose last run FAILED. Such an environment
 * is not live, so the delete is allowed — and the run that failed may have created cloud resources
 * before it stopped. The delete would remove the only record of them.
 */
export const DELETE_FAILED_RULE =
	"This environment's last run failed, so it may still have cloud resources that run created. Deleting removes the following and destroys nothing in the cloud: anything left keeps running, and keeps costing, in your cloud account. Destroy the environment first to remove it. This cannot be undone.";

/** What a failed environment's notice says, after its name. */
export const FAILED_NOTICE =
	"may still have cloud resources. Its last run failed, and a run that fails part-way can leave what it had already created. Deleting the environment does not remove them.";

/**
 * The Environments page for the project `project` (its slug) of org `org`. Reads the page's panels
 * through the `environments.overview` query the route prefetched, and renders the states of that
 * read distinctly (RUBRIC B4): pending (the route's own skeleton), refused (forbidden, or a project
 * that is not there), failed (a region error with a retry), and the data. The table's rows are
 * their own keyset read (`environments.page`), keyed by the normalized filter query.
 */
export function EnvironmentsView({ org, project }: { org: string; project: string }) {
	const filters = useEnvironmentsFilters((s) => s.filters);
	const urlRead = useFilterUrlSync(useEnvironmentsFilters, DEFAULT_ENVIRONMENT_FILTERS);
	// Only TYPING waits: a search the link carried lands in the key at once (`urlRead`).
	const debouncedSearch = useDebouncedValue(filters.search, 250, { urlRead });
	const listQuery = useMemo(
		() => normalizeEnvironmentsQuery(project, filters, debouncedSearch),
		[project, filters, debouncedSearch],
	);
	// The table: one keyset page at a time. A filter change is a new key, so the walk restarts at
	// page one; the cursor is the infinite query's page param and never part of `listQuery`.
	const list = useKeysetList(orpc.environments.page, listQuery);
	const input = useMemo(() => ({ project }), [project]);
	const overview = useQuery(orpc.environments.overview.queryOptions({ input }));
	// One array per project, so the rows that carry it are rebuilt when the read changes, not on
	// every render.
	const overviewKey = useMemo(() => orpc.environments.overview.queryKey({ input }), [input]);

	if (overview.data === undefined) {
		if (!overview.isError) return <EnvironmentsSkeleton />;
		const refusal = readRefusalOf(overview.error);
		if (refusal) {
			// An expected refusal, not a failure: retrying will not change it, so there is no button.
			return (
				<RegionRefusal
					refusal={refusal}
					subject="this project's environments"
					className={ENVIRONMENTS_REGION}
				/>
			);
		}
		return (
			<RegionError
				className={ENVIRONMENTS_REGION}
				title="Couldn't load environments"
				description="Something went wrong fetching this project's environments. Check your connection and try again."
				onRetry={() => void overview.refetch()}
			/>
		);
	}

	return (
		<EnvironmentsBody
			org={org}
			project={project}
			data={overview.data}
			overviewKey={overviewKey}
			list={list}
			busy={!urlRead || list.isPlaceholderData || filters.search !== debouncedSearch}
		/>
	);
}

/** The page with its data: the toolbar, the panels, the list, and every write the page offers. */
function EnvironmentsBody({
	org,
	project,
	data,
	overviewKey,
	list,
	busy,
}: {
	org: string;
	project: string;
	data: EnvironmentsOverview;
	/** The key of the read on screen — what an optimistic auto-heal change patches. */
	overviewKey: readonly unknown[];
	/** The table's keyset read: its rows, facets, first-page state and footer state. */
	list: KeysetList<EnvironmentFacts, EnvironmentFacetSet>;
	/** What the list shows may not answer the URL and the bar yet. */
	busy: boolean;
}) {
	const { projectId, envs, consistency, reconcile, activePromotion, protectionByEnv } = data;
	const filters = useEnvironmentsFilters((s) => s.filters);
	const set = useEnvironmentsFilters((s) => s.set);
	const reset = useEnvironmentsFilters((s) => s.reset);
	const [createOpen, setCreateOpen] = useState(false);
	const [duplicateFrom, setDuplicateFrom] = useState<EnvRow | null>(null);
	const [promoteOpen, setPromoteOpen] = useState(false);
	const [protectFor, setProtectFor] = useState<EnvRow | null>(null);
	const [admissionFor, setAdmissionFor] = useState<EnvRow | null>(null);
	const [pendingDelete, setPendingDelete] = useState<EnvRow | null>(null);
	// The server's sentence for a refused delete, shown in the confirmation that is still open.
	const [deleteRefusal, setDeleteRefusal] = useState<string | null>(null);
	const [detailOpen, setDetailOpen] = useState(false);
	const [confirmReject, setConfirmReject] = useState(false);
	const [confirmCancel, setConfirmCancel] = useState(false);

	// Why the viewer cannot change environments (`project:edit`), or promote (`project:deploy`); null
	// when they can. A control they cannot use is disabled with this, never hidden and never left
	// enabled to fail.
	const manageDenied = manageReason({ canManage: data.canManage });
	const promoteDenied = manageReason({ canManage: data.canPromote });

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
		(env: EnvRow) => deleteEnvironment({ projectId, environmentId: env.id }),
		{
			invalidates: environmentReads,
			successMessage: (deleted) => `Deleted ${deleted.name}`,
			// Shown in the dialog, which stays open on a refusal, and so not toasted as well.
			onRefusal: (error) => setDeleteRefusal(error.message),
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
	const envName = useCallback((id: string) => envs.find((e) => e.id === id)?.name ?? "—", [envs]);
	const openDetail = useCallback(() => setDetailOpen(true), []);
	// The route prefetched this batch (#6334). The batch leaves out an environment with no chips, so
	// once it has answered such an environment's chips are KNOWN to be none — `[]`, not `undefined`,
	// which would send each of those rows to read its own chips again on mount.
	const { data: classMap } = useAssignmentsForKind(
		"project_environment",
		envs.map((e) => e.id),
	);

	// The table's rows: the environments the SERVER matched, page by page in its order, each joined
	// to what the overview read about it. A row the overview does not (yet) hold is left out until
	// both reads agree — the stream invalidates them together.
	const rows = useMemo<EnvironmentRow[]>(() => {
		const byId = new Map(envs.map((env) => [env.id, env]));
		const reconcileById = new Map(reconcile.map((r) => [r.environmentId, r]));
		const listed: EnvironmentRow[] = [];
		for (const { id } of list.rows) {
			const env = byId.get(id);
			if (!env) continue;
			listed.push({
				id,
				env,
				reconcile: reconcileById.get(id),
				protection: protectionByEnv[id],
				classAssignments: classMap ? (classMap[id] ?? []) : undefined,
				projectId,
				overviewKey,
			});
		}
		return listed;
	}, [envs, reconcile, list.rows, protectionByEnv, classMap, projectId, overviewKey]);
	// The table renders the joined rows; the paging state (footer, stale notice) is the list's own.
	const table = useMemo(() => ({ ...list, rows }), [list, rows]);
	const firstPageFailed = list.query.isError && list.query.data === undefined;

	// The columns are built once per project and permission, so a cell keeps its identity (an open
	// row menu, a switch in flight) while the read refreshes under it. Every handler only sets state,
	// and a state setter never changes, so the columns depend on nothing a render replaces.
	const columns = useMemo(
		() =>
			buildEnvironmentColumns({
				org,
				project,
				manageDenied,
				onEditRules: (env) => setProtectFor(env),
				onEditAdmission: (env) => setAdmissionFor(env),
				onDuplicate: (env) => {
					setDuplicateFrom(env);
					setCreateOpen(true);
				},
				onDelete: (env) => {
					setDeleteRefusal(null);
					setPendingDelete(env);
				},
			}),
		[org, project, manageDenied],
	);

	// What needs a decision, over EVERY environment — a filter must not hide a warning.
	const failed = envs.filter((env) => mayHoldResources(env.status));
	const missing = reconcile.filter((state) => {
		const env = envs.find((e) => e.id === state.environmentId);
		return state.clusterMissing !== null && env !== undefined && !runInFlight(env.status);
	});
	const deletingFailed = pendingDelete !== null && mayHoldResources(pendingDelete.status);

	return (
		<div className="space-y-8">
			{/* No count: the list standard carries no list sizes (lib/query/README.md → "Counts"). */}
			<PageToolbar
				description={DESCRIPTION}
				actions={
					<>
						<DisabledReason reason={manageDenied}>
							<Button size="sm" onClick={() => setCreateOpen(true)}>
								<Plus className="mr-1.5 size-3.5" aria-hidden />
								New Environment
							</Button>
						</DisabledReason>
						{/* Always rendered: the toolbar keeps one shape whatever the count, so the route
						    skeleton can reserve it exactly (B2). Under two environments it is disabled and
						    says why. */}
						<DisabledReason
							reason={
								promoteDenied ??
								(envs.length < 2 ? "Promoting needs two environments. Create another first." : null)
							}
						>
							<Button size="sm" variant="outline" onClick={() => setPromoteOpen(true)}>
								<ArrowUpFromLine className="mr-1.5 size-3.5" aria-hidden />
								Promote
							</Button>
						</DisabledReason>
					</>
				}
			/>

			{/* A FAILED environment may still hold cloud resources. Nothing lists them, and deleting
			    the environment would remove the record without removing them — so the page says so,
			    and points at the one action that does remove them. */}
			{failed.map((env) => (
				<Alert key={env.id} data-slot="failed-environment-notice">
					<TriangleAlert aria-hidden />
					<AlertTitle>
						<span className="font-mono">{env.name}</span> failed
					</AlertTitle>
					<AlertDescription>
						<p>
							<span className="font-mono">{env.name}</span> {FAILED_NOTICE} To remove them, open the
							environment and run {JOB_ACTION.destroy} from its settings; delete it only after that.
						</p>
						<Button
							className="mt-2"
							variant="outline"
							size="sm"
							nativeButton={false}
							render={<Link href={envHref(org, project, env.id)} />}
						>
							Open {env.name} to {JOB_ACTION.destroy.toLowerCase()} it
						</Button>
					</AlertDescription>
				</Alert>
			))}

			{/* Nothing changes a missing cluster's status by itself: these are the ways out (#6736).
			    Not while a run is in flight — it will write its own outcome. */}
			{missing.map((state) => (
				<Alert key={state.environmentId} data-slot="missing-cluster-notice">
					<TriangleAlert aria-hidden />
					<AlertTitle>
						The cluster of <span className="font-mono">{envName(state.environmentId)}</span> was deleted
						outside Alethia
					</AlertTitle>
					<AlertDescription>
						{manageDenied === null ? (
							<MissingClusterActions
								orgSlug={org}
								projectSlug={project}
								projectId={projectId}
								environmentId={state.environmentId}
								environmentName={envName(state.environmentId)}
							/>
						) : (
							<p>Someone who can edit this project can redeploy it, destroy it, or mark it as destroyed.</p>
						)}
					</AlertDescription>
				</Alert>
			))}

			{/* Active promotion */}
			{activePromotion && (
				<ActivePromotionPanel
					detail={activePromotion}
					canApprove={
						data.canPromote &&
						activePromotion.status === "PENDING_APPROVAL" &&
						activePromotion.approved < activePromotion.required
					}
					canCancel={
						data.canPromote &&
						["PENDING_PLAN", "PENDING_APPROVAL", "DEPLOYING"].includes(activePromotion.status)
					}
					busy={deciding}
					onApprove={() => approve.submit({ promotionId: activePromotion.id })}
					onReject={() => setConfirmReject(true)}
					onCancel={() => setConfirmCancel(true)}
					onOpenDetail={() => setDetailOpen(true)}
				/>
			)}

			{/* The environments list */}
			<section className="space-y-4" aria-label="Environments" aria-busy={busy}>
				{firstPageFailed ? (
					<RegionError
						title="Couldn't load environments"
						description="Something went wrong fetching this project's environments. Check your connection and try again."
						onRetry={() => void list.query.refetch()}
					/>
				) : list.universeEmpty === true ? (
					// No environment at all — never "no match". Its next action is the one that makes one.
					<EmptyState
						level={2}
						className="border border-dashed border-border-strong"
						icon={<Layers />}
						title="No environments"
						description="Create one to deploy this project, then add a second to promote changes up a chain."
						action={
							<DisabledReason reason={manageDenied}>
								<Button variant="outline" size="sm" onClick={() => setCreateOpen(true)}>
									New Environment
								</Button>
							</DisabledReason>
						}
					/>
				) : (
					<>
						<EnvironmentsFilterBar
							filters={filters}
							onFilter={set}
							onReset={reset}
							facets={list.facets ?? undefined}
						/>
						{list.universeEmpty === false && list.rows.length === 0 ? (
							<EmptyState
								level={2}
								icon={<SearchX />}
								title="No environments match these filters"
								description="Every environment is excluded by the current search, stage or status selection."
								action={
									<Button variant="outline" size="sm" onClick={reset}>
										Clear filters
									</Button>
								}
							/>
						) : (
							<div className={cn("transition-opacity", list.isPlaceholderData && "opacity-60")}>
								<DataTable columns={columns} keyset={table} />
							</div>
						)}
						{/* A note under a POPULATED list, so NOT an `EmptyState`: sitting under the one
						    environment it would read as "this list is empty" when it is not. */}
						{envs.length === 1 && (
							<p className="rounded-lg border border-dashed border-border-strong px-4 py-3 text-ui-md text-text-tertiary">
								Only one environment. Create another to compare configuration and promote changes up
								the chain.
							</p>
						)}
					</>
				)}
			</section>

			{consistency.rows.length > 0 && <ConsistencyMatrix consistency={consistency} />}
			<PromotionsHistory
				project={project}
				envName={envName}
				activeId={activePromotion?.id ?? null}
				onView={openDetail}
			/>

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
			{admissionFor && (
				<ByoAdmissionSheet
					open={!!admissionFor}
					onOpenChange={(o) => !o && setAdmissionFor(null)}
					projectId={projectId}
					envId={admissionFor.id}
					envName={admissionFor.name}
					enforce={admissionFor.byo_admission_enforce}
				/>
			)}
			<PromotionDetailOverlay
				detail={detailOpen ? activePromotion : null}
				onClose={() => setDetailOpen(false)}
			/>

			<ConfirmAction
				open={!!pendingDelete}
				onOpenChange={(o) => !o && setPendingDelete(null)}
				title={`Delete ${pendingDelete?.name ?? "environment"}?`}
				confirmLabel="Delete environment"
				description={
					deleteRefusal ? `Not deleted. ${deleteRefusal}` : deletingFailed ? DELETE_FAILED_RULE : DELETE_RULE
				}
				pendingLabel="Deleting…"
				severity={{
					level: "destroy",
					subject: pendingDelete?.name ?? "",
					consequences: ["The environment record", "Its staged configuration"],
				}}
				mutation={remove}
				variables={pendingDelete}
			/>
			<ConfirmAction
				open={confirmReject}
				onOpenChange={setConfirmReject}
				title="Reject this promotion?"
				description="The promotion is cancelled and nothing is deployed. The initiator can start a new one."
				confirmLabel="Reject promotion"
				pendingLabel="Rejecting…"
				severity={{ level: "confirm" }}
				mutation={reject}
				variables={activePromotion ? { promotionId: activePromotion.id } : null}
			/>
			<ConfirmAction
				open={confirmCancel}
				onOpenChange={setConfirmCancel}
				title="Cancel this promotion?"
				description="The in-flight promotion is stopped. Nothing further is deployed."
				confirmLabel="Cancel promotion"
				pendingLabel="Cancelling…"
				severity={{ level: "confirm" }}
				mutation={cancel}
				variables={activePromotion ? { promotionId: activePromotion.id } : null}
			/>
		</div>
	);
}
