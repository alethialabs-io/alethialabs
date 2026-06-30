"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The Fleet / Runners page. A two-column layout (mirrors the org overview): the left column
// stacks the warm Pools and the Versions changelog; the right column is the filterable,
// paginated grid of runner cards. No eyebrow/title/KPI chrome — pools and runners show first.

import { Button } from "@repo/ui/button";
import { AddRunnerButton } from "@/components/runners/add-runner-button";
import { PoolCard, PoolCardSkeleton, PoolsEmpty } from "@/components/runners/pool-card";
import { FleetPoolWizard } from "@/components/runners/fleet-pool-wizard";
import { RunnerCard, RunnerCardSkeleton } from "@/components/runners/runner-card";
import { type RunnerRow } from "@/components/runners/runner-actions";
import {
	RunnersToolbar,
	EMPTY_RUNNER_FILTERS,
	matchesRunnerFilters,
	type RunnerFilters,
} from "@/components/runners/runners-toolbar";
import { RunnersPager } from "@/components/runners/runners-pager";
import { VersionsPanel } from "@/components/runners/versions-panel";
import { useRunnersQuery, type ActiveJob } from "@/lib/query/use-runners-query";
import { useJobsQuery } from "@/lib/query/use-jobs-query";
import {
	useFleetQuery,
	useSetPoolEnabled,
	useDeletePool,
} from "@/lib/query/use-fleet-query";
import { useIsHosted } from "@/lib/stores/use-workspace-store";
import { useEntitlement } from "@/components/settings/enterprise-gate";
import { FeatureUpsell } from "@/components/settings/upgrade/feature-upsell";
import type { FleetPool, ProvisionJobType as PublicProvisionJobType } from "@/lib/db/schema";
import { Plus, Server } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

const PAGE_SIZE = 9;
const RUNNER_JOB_TYPES = new Set<PublicProvisionJobType>([
	"DEPLOY_RUNNER",
	"UPDATE_RUNNER",
	"DESTROY_RUNNER",
]);

export function RunnersClient() {
	const { data: runnersData, isPending: isLoading } = useRunnersQuery();
	const runners = runnersData?.runners ?? [];
	// Deployment-mode + entitlement gating. Self-managed operators see everything; hosted tenants
	// need the byoRunners entitlement (Pro+) for the runner surface, and never see managed pools.
	const isHosted = useIsHosted();
	const canByoRunners = useEntitlement("byoRunners");

	const { data: allJobs = [] } = useJobsQuery();
	const activeJobs: ActiveJob[] = useMemo(
		() =>
			allJobs
				.filter((j) => j.status === "QUEUED" || j.status === "CLAIMED" || j.status === "PROCESSING")
				.map((j) => ({
					id: j.id,
					job_type: j.job_type,
					status: j.status,
					config_snapshot: j.config_snapshot,
					runner_id: j.runner_id,
					project_id: j.project_id,
					projects: j.project_name ? { project_name: j.project_name } : null,
				})),
		[allJobs],
	);

	// Configured warm pools joined with observed reality (left column). Polled on the same
	// cadence as the runner list by the fleet query.
	const { data: fleet, isSuccess: fleetLoaded } = useFleetQuery();
	const poolViews = fleet?.pools ?? [];
	const poolConfigs = fleet?.configs ?? [];
	const economics = fleet?.economics ?? null;
	const fleetProviderActive = fleet?.fleetProviderActive ?? false;
	const canManageFleet = fleet?.canManageFleet ?? false;
	const { mutateAsync: setPoolEnabled } = useSetPoolEnabled();
	const { mutateAsync: deletePool } = useDeletePool();

	const econByProvider = useMemo(
		() => new Map((economics?.pools ?? []).map((p) => [p.provider, p])),
		[economics],
	);

	const [filters, setFilters] = useState<RunnerFilters>(EMPTY_RUNNER_FILTERS);
	const [query, setQuery] = useState("");
	const [page, setPage] = useState(1);

	// Pool editor dialog: null pool = create, a row = edit.
	const [poolDialogOpen, setPoolDialogOpen] = useState(false);
	const [editingPool, setEditingPool] = useState<FleetPool | null>(null);

	// Reset to the first page whenever the result set changes shape.
	useEffect(() => {
		setPage(1);
	}, [query, filters]);

	const openCreatePool = () => {
		setEditingPool(null);
		setPoolDialogOpen(true);
	};
	const openEditPool = (id: string) => {
		setEditingPool(poolConfigs.find((c) => c.id === id) ?? null);
		setPoolDialogOpen(true);
	};
	const handleTogglePool = async (id: string, enabled: boolean) => {
		try {
			await setPoolEnabled({ id, enabled: !enabled });
		} catch (err) {
			toast.error(err instanceof Error ? err.message : "Failed to update pool");
		}
	};
	const handleDeletePool = async (id: string) => {
		try {
			await deletePool(id);
			toast.success("Pool deleted");
		} catch (err) {
			toast.error(err instanceof Error ? err.message : "Failed to delete pool");
		}
	};

	// Join each runner to its in-flight lifecycle job (deploy/update/destroy target it by id
	// in the config snapshot; everything else by runner_id).
	const jobsByRunner = useMemo(() => {
		const map = new Map<string, ActiveJob>();
		for (const job of activeJobs) {
			if (RUNNER_JOB_TYPES.has(job.job_type)) {
				const targetId = job.config_snapshot.runner_id;
				if (typeof targetId === "string") map.set(targetId, job);
			} else if (job.runner_id) {
				map.set(job.runner_id, job);
			}
		}
		return map;
	}, [activeJobs]);

	const runnerRows: RunnerRow[] = useMemo(
		() => runners.map((w) => ({ ...w, activeJob: jobsByRunner.get(w.id) ?? null })),
		[runners, jobsByRunner],
	);

	// Filter facets derived from the loaded runners.
	const facets = useMemo(() => {
		const clouds = new Set<string>();
		const regions = new Set<string>();
		const versions = new Set<string>();
		for (const r of runnerRows) {
			if (!r.supported_providers || r.supported_providers.length === 0) clouds.add("any");
			else for (const p of r.supported_providers) clouds.add(p);
			if (r.location) regions.add(r.location);
			const v = r.runner_releases?.version ?? r.version;
			if (v) versions.add(v);
		}
		return {
			clouds: Array.from(clouds).sort(),
			regions: Array.from(regions).sort(),
			versions: Array.from(versions).sort((a, b) => b.localeCompare(a)),
		};
	}, [runnerRows]);

	const filtered = useMemo(() => {
		const q = query.trim().toLowerCase();
		return runnerRows.filter((r) => {
			if (q && !r.name.toLowerCase().includes(q)) return false;
			return matchesRunnerFilters(r, filters);
		});
	}, [runnerRows, query, filters]);

	const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
	const safePage = Math.min(page, pageCount);
	const pageItems = useMemo(
		() => filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE),
		[filtered, safePage],
	);

	const hasPools = poolViews.length > 0;

	// Hosted tenants without the BYO-runners entitlement get the upsell in place of the page.
	// (Self-managed operators are never gated here.)
	if (isHosted && !canByoRunners) {
		return (
			<div className="mx-auto w-full max-w-[1360px]">
				<FeatureUpsell feature="byoRunners" />
			</div>
		);
	}

	return (
		<div className="mx-auto w-full max-w-[1360px]">
			<div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-[minmax(320px,0.36fr)_minmax(0,0.64fr)]">
				{/* Left column — pools (self-managed only), then versions. */}
				<div className="flex flex-col gap-6">
					{!isHosted && (
					<section className="space-y-3">
						<div className="flex items-center justify-between gap-2">
							<div className="flex items-baseline gap-2">
								<span className="text-sm font-semibold tracking-tight text-foreground">Pools</span>
								{hasPools && (
									<span className="font-mono text-[10px] uppercase tracking-[0.08em] text-muted-foreground">
										{poolViews.length} configured
									</span>
								)}
							</div>
							{canManageFleet && (
								<Button size="sm" variant="outline" className="h-7 px-2.5 text-xs" onClick={openCreatePool}>
									<Plus className="mr-1 h-3.5 w-3.5" /> Add pool
								</Button>
							)}
						</div>

						{canManageFleet && hasPools && !fleetProviderActive && (
							<p className="border border-dashed border-border px-3 py-2 font-mono text-[10px] leading-relaxed text-muted-foreground">
								No cloud provider wired — pools are advisory. Set{" "}
								<span className="text-foreground">FLEET_PROVIDER=hcloud</span> to provision real runners.
							</p>
						)}

						{!fleetLoaded ? (
							<div className="space-y-4">
								<PoolCardSkeleton />
								<PoolCardSkeleton />
							</div>
						) : hasPools ? (
							<div className="space-y-4">
								{poolViews.map((pool) => (
									<PoolCard
										key={pool.id}
										pool={pool}
										economics={econByProvider.get(pool.provider)}
										canManage={canManageFleet}
										onEdit={canManageFleet ? () => openEditPool(pool.id) : undefined}
										onToggle={canManageFleet ? () => handleTogglePool(pool.id, pool.enabled) : undefined}
										onDelete={canManageFleet ? () => handleDeletePool(pool.id) : undefined}
									/>
								))}
							</div>
						) : (
							<PoolsEmpty />
						)}
					</section>
					)}

					<VersionsPanel />
				</div>

				{/* Right column — runners. */}
				<div className="min-w-0 space-y-4">
					<div className="flex items-center justify-between gap-3">
						<div className="flex items-baseline gap-2">
							<span className="font-display text-[15px] font-semibold tracking-tight">Runners</span>
							<span className="rounded-full border px-2 py-0.5 font-mono text-[10.5px] text-muted-foreground">
								{runnerRows.length}
							</span>
						</div>
						<AddRunnerButton />
					</div>

					<RunnersToolbar
						query={query}
						onQueryChange={setQuery}
						filters={filters}
						onFiltersChange={setFilters}
						availableClouds={facets.clouds}
						availableRegions={facets.regions}
						availableVersions={facets.versions}
					/>

					{isLoading && runners.length === 0 ? (
						<div className="grid gap-4 [grid-template-columns:repeat(auto-fill,minmax(340px,1fr))]">
							{[1, 2, 3, 4].map((i) => (
								<RunnerCardSkeleton key={i} />
							))}
						</div>
					) : runnerRows.length === 0 ? (
						<EmptyRunners />
					) : filtered.length === 0 ? (
						<p className="py-12 text-center text-sm text-muted-foreground">
							No runners match your filters.
						</p>
					) : (
						<>
							<div className="grid gap-4 [grid-template-columns:repeat(auto-fill,minmax(340px,1fr))]">
								{pageItems.map((runner) => (
									<RunnerCard key={runner.id} runner={runner} />
								))}
							</div>
							<RunnersPager
								page={safePage}
								pageCount={pageCount}
								total={filtered.length}
								onPageChange={setPage}
							/>
						</>
					)}
				</div>
			</div>

			{canManageFleet && (
				<FleetPoolWizard
					open={poolDialogOpen}
					onOpenChange={setPoolDialogOpen}
					pool={editingPool}
					usedProviders={poolConfigs.map((c) => c.provider)}
				/>
			)}
		</div>
	);
}

/** First-run state when no runners exist at all. */
function EmptyRunners() {
	return (
		<div className="flex flex-col items-center justify-center rounded-lg border border-dashed py-16 text-center">
			<div className="mb-4 rounded-full bg-muted/50 p-3">
				<Server className="h-7 w-7 text-muted-foreground" />
			</div>
			<h3 className="mb-1 text-sm font-medium text-foreground">No runners yet</h3>
			<p className="mb-4 max-w-sm text-xs text-muted-foreground">
				Runners execute provisioning jobs. Managed runners are operated and billed by Alethia; you
				can also deploy your own into a cloud account or register an existing one.
			</p>
			<AddRunnerButton />
		</div>
	);
}
