"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only


import { Alert, AlertTitle } from "@/components/ui/alert";
import { Card } from "@/components/ui/card";
import { DataTable } from "@/components/data-table";
import { jobColumns } from "@/components/jobs/columns";
import { runnerColumns, type RunnerRow } from "@/components/runners/columns";
import { AddRunnerButton } from "@/components/runners/add-runner-button";
import { PoolCard, PoolCardSkeleton, PoolsEmpty } from "@/components/runners/pool-card";
import { FleetPoolDialog } from "@/components/runners/fleet-pool-dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useRunnersStore, type ActiveJob } from "@/lib/stores/use-runners-store";
import { useJobsStore } from "@/lib/stores/use-jobs-store";
import { useFleetStore } from "@/lib/stores/use-fleet-store";
import type {
	FleetPool,
	ProvisionJobType as PublicProvisionJobType,
	RunnerStatus as PublicRunnerStatus,
} from "@/lib/db/schema";
import type { JobWithMeta as PublicProvisionJobsRow } from "@/app/server/actions/jobs";
import type { RunnerMetadata } from "@/types/database-custom.types";
import { cn } from "@/lib/utils";
import { ArrowUpCircle, Loader2, Plus, Search, Server } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

const STATUS_FILTERS: (PublicRunnerStatus | "All")[] = [
	"All", "ONLINE", "OFFLINE", "DRAINING",
];

const OPERATOR_FILTERS = ["All", "Managed", "Self"] as const;
type OperatorFilter = (typeof OPERATOR_FILTERS)[number];

/** A KPI tile in the fleet stats row (label + big value + caption). */
function StatTile({ label, value, sub, muted }: { label: string; value: number; sub: string; muted?: boolean }) {
	return (
		<Card className="gap-1 p-4">
			<div className="font-mono text-[9px] uppercase tracking-[0.12em] text-muted-foreground">{label}</div>
			<div className="flex items-baseline gap-2">
				<span className={cn("text-2xl font-semibold tracking-tight tabular-nums", muted ? "text-muted-foreground" : "text-foreground")}>
					{value}
				</span>
				<span className="text-xs text-muted-foreground">{sub}</span>
			</div>
		</Card>
	);
}

export default function RunnersPage() {
	const router = useRouter();
	const {
		runners,
		latestRelease,
		isLoading,
		fetchRunners,
		updateAllOutdated,
	} = useRunnersStore();

	const allJobs = useJobsStore((s) => s.jobs);
	const activeJobs: ActiveJob[] = useMemo(() =>
		allJobs
			.filter((j) => j.status === "QUEUED" || j.status === "CLAIMED" || j.status === "PROCESSING")
			.map((j) => {
				const specName = j.spec_name;
				return {
					id: j.id,
					job_type: j.job_type,
					status: j.status,
					config_snapshot: j.config_snapshot,
					runner_id: j.runner_id,
					spec_id: j.spec_id,
					specs: specName ? { project_name: specName } : null,
				};
			}),
		[allJobs],
	);

	const [statusFilter, setStatusFilter] = useState<PublicRunnerStatus | "All">("All");
	const [operatorFilter, setOperatorFilter] = useState<OperatorFilter>("All");
	const [searchQuery, setSearchQuery] = useState("");
	const [isUpdatingAll, setIsUpdatingAll] = useState(false);

	// Configured warm pools joined with observed reality (right sidebar). Refreshed on the
	// same cadence as the runner list, via the fleet store (which also drives pool CRUD).
	const {
		pools: poolViews,
		configs: poolConfigs,
		economics,
		fleetProviderActive,
		canManageFleet,
		loaded: fleetLoaded,
		fetch: fetchFleet,
		setEnabled: setPoolEnabled,
		deletePool,
	} = useFleetStore();

	// Per-provider economics for the pool-card footers (manager-only; empty otherwise).
	const econByProvider = useMemo(
		() => new Map((economics?.pools ?? []).map((p) => [p.provider, p])),
		[economics],
	);

	// Pool editor dialog: null pool = create, a row = edit.
	const [poolDialogOpen, setPoolDialogOpen] = useState(false);
	const [editingPool, setEditingPool] = useState<FleetPool | null>(null);

	useEffect(() => {
		const loadFleet = () => fetchFleet().catch(() => {});
		fetchRunners(true);
		loadFleet();
		// Poll for runner status (heartbeat-driven ONLINE/OFFLINE changes server-side).
		const interval = setInterval(() => {
			fetchRunners(true);
			loadFleet();
		}, 10_000);
		return () => clearInterval(interval);
	}, [fetchRunners, fetchFleet]);

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
			await setPoolEnabled(id, !enabled);
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

	const RUNNER_JOB_TYPES = useMemo(
		() => new Set<PublicProvisionJobType>(["DEPLOY_RUNNER", "UPDATE_RUNNER", "DESTROY_RUNNER"]),
		[],
	);

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
	}, [activeJobs, RUNNER_JOB_TYPES]);

	const runnerRows: RunnerRow[] = useMemo(
		() => runners.map((w) => ({
			...w,
			activeJob: jobsByRunner.get(w.id) ?? null,
		})),
		[runners, jobsByRunner],
	);

	const filtered = useMemo(() => {
		let result = runnerRows;
		if (statusFilter !== "All") {
			result = result.filter((w) => (w.status ?? "OFFLINE") === statusFilter);
		}
		if (operatorFilter !== "All") {
			const op = operatorFilter === "Managed" ? "managed" : "self";
			result = result.filter((w) => w.operator === op);
		}
		if (searchQuery.trim()) {
			const q = searchQuery.toLowerCase();
			result = result.filter((w) => w.name.toLowerCase().includes(q));
		}
		return result;
	}, [runnerRows, statusFilter, operatorFilter, searchQuery]);

	const outdatedRunners = useMemo(() => {
		if (!latestRelease) return [];
		return runners.filter(
			(w) => w.version && w.version !== latestRelease.version,
		);
	}, [runners, latestRelease]);

	const updatableRunners = useMemo(() => {
		return outdatedRunners.filter((w) => {
			const metadata = w.metadata as RunnerMetadata | null;
			return w.cloud_identity_id && metadata?.deploy_config?.runner_token;
		});
	}, [outdatedRunners]);

	// Fleet-wide aggregates for the health chip + stats row.
	const totals = useMemo(() => {
		const online = poolViews.reduce((a, p) => a + p.online, 0);
		const target = poolViews.reduce((a, p) => a + p.target, 0);
		const busy = poolViews.reduce((a, p) => a + p.busy, 0);
		const draining = poolViews.reduce((a, p) => a + p.draining, 0);
		const degraded = poolViews.filter((p) => p.degraded).length;
		return { online, target, busy, draining, degraded };
	}, [poolViews]);

	const handleUpdateAll = async () => {
		setIsUpdatingAll(true);
		try {
			const { queued, failed } = await updateAllOutdated(
				updatableRunners.map((w) => w.id),
			);
			if (failed === 0) {
				toast.success(`${queued} update${queued !== 1 ? "s" : ""} queued`);
			} else {
				toast.warning(`${queued} queued, ${failed} failed`);
			}
		} catch {
			toast.error("Failed to queue updates");
		} finally {
			setIsUpdatingAll(false);
		}
	};

	const handleJobClick = (job: PublicProvisionJobsRow) => {
		router.push(`/dashboard/jobs/${job.id}`);
	};

	const hasPools = poolViews.length > 0;

	return (
		<div className="w-full space-y-6">
			{/* header */}
			<div className="flex flex-wrap items-start justify-between gap-3">
				<div className="space-y-1">
					<span className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">Operate</span>
					<h1 className="text-2xl font-semibold tracking-tight text-foreground">Fleet</h1>
					<p className="max-w-2xl text-sm text-muted-foreground">
						Warm pools of cloud runners that execute provisioning jobs. The controller keeps each pool sized to demand, self-heals dead runners, and rolls out new versions with zero downtime.
					</p>
				</div>
				<div className="flex items-center gap-3">
					{hasPools && (
						<div className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.1em] text-muted-foreground">
							<span className={cn("size-2 rounded-full", totals.degraded > 0 ? "bg-foreground ring-2 ring-inset ring-background" : "bg-foreground")} />
							{poolViews.length} pools · {totals.online} online
							{totals.degraded > 0 && ` · ${totals.degraded} degraded`}
						</div>
					)}
					<AddRunnerButton />
				</div>
			</div>

			{/* updates available */}
			{outdatedRunners.length > 0 && latestRelease && (
				<Alert className="border-border bg-muted text-foreground">
					<ArrowUpCircle className="h-4 w-4" />
					<AlertTitle className="flex items-center justify-between">
						<span>
							<strong>{outdatedRunners.length} runner{outdatedRunners.length !== 1 ? "s" : ""}</strong>{" "}
							{outdatedRunners.length !== 1 ? "have" : "has"} updates available
							<span className="ml-1 font-normal">— v{latestRelease.version} is out</span>
							{outdatedRunners.length > updatableRunners.length && (
								<span className="ml-1 font-normal text-muted-foreground">
									({outdatedRunners.length - updatableRunners.length} require re-deploy)
								</span>
							)}
						</span>
						{updatableRunners.length > 0 && (
							<Button
								size="sm"
								variant="outline"
								className="h-7 border-border text-xs text-foreground hover:bg-muted"
								disabled={isUpdatingAll}
								onClick={handleUpdateAll}
							>
								{isUpdatingAll ? (
									<>
										<Loader2 className="mr-1.5 h-3 w-3 animate-spin" />
										Updating...
									</>
								) : (
									<>Update All ({updatableRunners.length})</>
								)}
							</Button>
						)}
					</AlertTitle>
				</Alert>
			)}

			{/* stats */}
			{hasPools && (
				<div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
					<StatTile label="Pools" value={poolViews.length} sub={totals.degraded > 0 ? `${totals.degraded} degraded` : "all healthy"} muted={totals.degraded > 0} />
					<StatTile label="Runners online" value={totals.online} sub={`of ${totals.target} target`} />
					<StatTile label="Busy now" value={totals.busy} sub="running jobs" />
					<StatTile label="Transitioning" value={totals.draining} sub="draining" />
				</div>
			)}

			{/* economics (manager-only; month-to-date COGS + utilization) */}
			{canManageFleet && economics && hasPools && (
				<div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
					<StatTile label="Provisioned" value={Math.round(economics.totals.provisionedHours)} sub="runner-hours (MTD)" />
					<StatTile label="Est. cost" value={Math.round(economics.totals.estCostEur)} sub={`€ · ${economics.serverType}`} muted />
					<StatTile
						label="Utilization"
						value={Math.round(
							economics.totals.provisionedHours > 0
								? Math.min(100, (economics.totals.jobMinutes / (economics.totals.provisionedHours * 60)) * 100)
								: 0,
						)}
						sub="% busy vs warm"
					/>
					<StatTile label="Job-minutes" value={Math.round(economics.totals.jobMinutes)} sub="billable (MTD)" />
				</div>
			)}

			{/* table (left) + pools (right) */}
			<div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
				<div className="min-w-0 space-y-8">
					{isLoading ? (
						<div className="space-y-3">
							<div className="flex gap-1">
								{[1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-7 w-16" />)}
							</div>
							<div className="rounded-lg border border-border/40">
								{[1, 2, 3].map((i) => (
									<div key={i} className="flex gap-4 border-b border-border/20 p-3">
										<Skeleton className="h-3 w-24" />
										<Skeleton className="h-3 w-16" />
										<Skeleton className="h-3 w-20" />
										<Skeleton className="h-3 w-28" />
										<Skeleton className="h-3 w-20" />
									</div>
								))}
							</div>
						</div>
					) : runners.length === 0 ? (
						<div className="flex flex-col items-center justify-center py-16 text-center">
							<div className="mb-4 rounded-full bg-muted/50 p-3">
								<Server className="h-8 w-8 text-muted-foreground" />
							</div>
							<h3 className="mb-1 text-sm font-medium text-foreground">No runners available</h3>
							<p className="mb-4 max-w-sm text-xs text-muted-foreground">
								Runners execute provisioning jobs for your infrastructure. Managed runners are operated and billed by Alethia. You can also provision your own (Deploy) or register an existing one (Register).
							</p>
							<AddRunnerButton />
						</div>
					) : (
						<>
							<section>
								<div className="mb-3 flex flex-col gap-3 sm:flex-row">
									<div className="flex gap-1">
										{STATUS_FILTERS.map((s) => (
											<Button
												key={s}
												variant={statusFilter === s ? "secondary" : "ghost"}
												size="sm"
												className="h-7 px-2.5 text-xs"
												onClick={() => setStatusFilter(s)}
											>
												{s === "All" ? "All" : s.charAt(0) + s.slice(1).toLowerCase()}
											</Button>
										))}
									</div>
									<div className="flex gap-1">
										{OPERATOR_FILTERS.map((o) => (
											<Button
												key={o}
												variant={operatorFilter === o ? "secondary" : "ghost"}
												size="sm"
												className="h-7 px-2.5 text-xs"
												onClick={() => setOperatorFilter(o)}
											>
												{o}
											</Button>
										))}
									</div>
									<div className="relative max-w-xs flex-1">
										<Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
										<Input
											placeholder="Search by name..."
											value={searchQuery}
											onChange={(e) => setSearchQuery(e.target.value)}
											className="h-7 border-border/50 bg-muted/30 pl-8 text-xs"
										/>
									</div>
								</div>
								<DataTable
									columns={runnerColumns}
									data={filtered}
									pageSize={20}
									scrollHeight="h-[50vh]"
								/>
							</section>

							{activeJobs.length > 0 && (
								<section>
									<h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
										Active Jobs
									</h2>
									<DataTable
										columns={jobColumns}
										data={activeJobs as unknown as PublicProvisionJobsRow[]}
										onRowClick={handleJobClick}
										pageSize={10}
									/>
								</section>
							)}
						</>
					)}
				</div>

				{/* pools sidebar */}
				<aside className="space-y-4 xl:sticky xl:top-4 xl:self-start">
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
							No cloud provider wired — pools are advisory. Set <span className="text-foreground">FLEET_PROVIDER=hcloud</span> to provision real runners.
						</p>
					)}
					{!fleetLoaded ? (
						<>
							<PoolCardSkeleton />
							<PoolCardSkeleton />
						</>
					) : hasPools ? (
						poolViews.map((pool) => (
							<PoolCard
								key={pool.id}
								pool={pool}
								economics={econByProvider.get(pool.provider)}
								canManage={canManageFleet}
								onEdit={canManageFleet ? () => openEditPool(pool.id) : undefined}
								onToggle={canManageFleet ? () => handleTogglePool(pool.id, pool.enabled) : undefined}
								onDelete={canManageFleet ? () => handleDeletePool(pool.id) : undefined}
							/>
						))
					) : (
						<PoolsEmpty />
					)}
				</aside>
			</div>

			{canManageFleet && (
				<FleetPoolDialog
					open={poolDialogOpen}
					onOpenChange={setPoolDialogOpen}
					pool={editingPool}
					usedProviders={poolConfigs.map((c) => c.provider)}
				/>
			)}
		</div>
	);
}
