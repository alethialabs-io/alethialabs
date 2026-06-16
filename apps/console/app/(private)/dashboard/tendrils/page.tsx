"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only


import { Alert, AlertTitle } from "@/components/ui/alert";
import { DataTable } from "@/components/data-table";
import { jobColumns } from "@/components/jobs/columns";
import { tendrilColumns, type TendrilRow } from "@/components/tendrils/columns";
import { AddTendrilButton } from "@/components/tendrils/add-tendril-button";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { createClient } from "@/lib/supabase/client";
import { useTendrilsStore, type ActiveJob } from "@/lib/stores/use-tendrils-store";
import { useJobsStore } from "@/lib/stores/use-jobs-store";
import type { PublicProvisionJobType, PublicWorkerStatus, PublicWorkersRow, PublicProvisionJobsRow } from "@/lib/validations/db.schemas";
import type { WorkerMetadata } from "@/types/database-custom.types";
import { ArrowUpCircle, Loader2, Search, Server } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

const STATUS_FILTERS: (PublicWorkerStatus | "All")[] = [
	"All", "ONLINE", "OFFLINE", "DRAINING",
];

export default function TendrilsPage() {
	const router = useRouter();
	const {
		tendrils,
		latestRelease,
		isLoading,
		fetchTendrils,
		addOrUpdateTendril,
		removeTendril,
		updateAllOutdated,
	} = useTendrilsStore();

	const allJobs = useJobsStore((s) => s.jobs);
	const activeJobs: ActiveJob[] = useMemo(() =>
		allJobs
			.filter((j) => j.status === "QUEUED" || j.status === "CLAIMED" || j.status === "PROCESSING")
			.map((j) => {
				const vineName = (j as Record<string, unknown>).vine_name as string | null;
				return {
					id: j.id,
					job_type: j.job_type,
					status: j.status,
					config_snapshot: j.config_snapshot as Record<string, unknown>,
					worker_id: j.worker_id,
					vine_id: j.vine_id,
					vines: vineName ? { project_name: vineName } : null,
				};
			}),
		[allJobs],
	);

	const [statusFilter, setStatusFilter] = useState<PublicWorkerStatus | "All">("All");
	const [searchQuery, setSearchQuery] = useState("");
	const [isUpdatingAll, setIsUpdatingAll] = useState(false);

	useEffect(() => {
		fetchTendrils(true);
	}, [fetchTendrils]);

	useEffect(() => {
		const supabase = createClient();

		const channel = supabase
			.channel("workers-live")
			.on(
				"postgres_changes",
				{ event: "*", schema: "public", table: "workers" },
				(payload) => {
					if (payload.eventType === "DELETE") {
						removeTendril((payload.old as { id: string }).id);
						return;
					}
					addOrUpdateTendril({ ...(payload.new as PublicWorkersRow), worker_releases: null });
				},
			)
			.subscribe();

		return () => {
			supabase.removeChannel(channel);
		};
	}, [addOrUpdateTendril, removeTendril]);

	const TENDRIL_JOB_TYPES = useMemo(
		() => new Set<PublicProvisionJobType>(["DEPLOY_WORKER", "UPDATE_WORKER", "DESTROY_WORKER"]),
		[],
	);

	const jobsByTendril = useMemo(() => {
		const map = new Map<string, ActiveJob>();
		for (const job of activeJobs) {
			if (TENDRIL_JOB_TYPES.has(job.job_type)) {
				const targetId = job.config_snapshot.worker_id;
				if (typeof targetId === "string") map.set(targetId, job);
			} else if (job.worker_id) {
				map.set(job.worker_id, job);
			}
		}
		return map;
	}, [activeJobs, TENDRIL_JOB_TYPES]);

	const tendrilRows: TendrilRow[] = useMemo(
		() => tendrils.map((w) => ({
			...w,
			activeJob: jobsByTendril.get(w.id) ?? null,
		})),
		[tendrils, jobsByTendril],
	);

	const filtered = useMemo(() => {
		let result = tendrilRows;
		if (statusFilter !== "All") {
			result = result.filter((w) => (w.status ?? "OFFLINE") === statusFilter);
		}
		if (searchQuery.trim()) {
			const q = searchQuery.toLowerCase();
			result = result.filter((w) => w.name.toLowerCase().includes(q));
		}
		return result;
	}, [tendrilRows, statusFilter, searchQuery]);

	const outdatedTendrils = useMemo(() => {
		if (!latestRelease) return [];
		return tendrils.filter(
			(w) => w.version && w.version !== latestRelease.version,
		);
	}, [tendrils, latestRelease]);

	const updatableTendrils = useMemo(() => {
		return outdatedTendrils.filter((w) => {
			const metadata = w.metadata as WorkerMetadata | null;
			return w.cloud_identity_id && metadata?.deploy_config?.worker_token;
		});
	}, [outdatedTendrils]);

	const handleUpdateAll = async () => {
		setIsUpdatingAll(true);
		try {
			const { queued, failed } = await updateAllOutdated(
				updatableTendrils.map((w) => w.id),
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

	if (isLoading) {
		return (
			<div className="space-y-6">
				<div>
					<h1 className="text-2xl font-semibold tracking-tight text-foreground">Runners</h1>
					<p className="text-sm text-muted-foreground mt-1">Live status of provisioning runners and their active jobs.</p>
				</div>
				<div className="space-y-3">
					<div className="flex gap-1">
						{[1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-7 w-16 rounded-md" />)}
					</div>
					<div className="rounded-lg border border-border/40">
						{[1, 2, 3].map((i) => (
							<div key={i} className="flex gap-4 border-b border-border/20 p-3">
								<Skeleton className="h-3 w-24" />
								<Skeleton className="h-3 w-16 rounded-full" />
								<Skeleton className="h-3 w-20 rounded-full" />
								<Skeleton className="h-3 w-28" />
								<Skeleton className="h-3 w-20" />
							</div>
						))}
					</div>
				</div>
			</div>
		);
	}

	return (
		<div className="space-y-8">
			<div className="flex items-center justify-between">
				<div>
					<h1 className="text-2xl font-semibold tracking-tight text-foreground">Runners</h1>
					<p className="text-sm text-muted-foreground mt-1">Live status of provisioning runners and their active jobs.</p>
				</div>
				<AddTendrilButton />
			</div>

			{outdatedTendrils.length > 0 && latestRelease && (
				<Alert className="text-foreground border-border bg-muted">
					<ArrowUpCircle className="h-4 w-4" />
					<AlertTitle className="flex items-center justify-between">
						<span>
							<strong>{outdatedTendrils.length} runner{outdatedTendrils.length !== 1 ? "s" : ""}</strong>{" "}
							{outdatedTendrils.length !== 1 ? "have" : "has"} updates available
							<span className="font-normal ml-1">— v{latestRelease.version} is out</span>
							{outdatedTendrils.length > updatableTendrils.length && (
								<span className="font-normal text-muted-foreground ml-1">
									({outdatedTendrils.length - updatableTendrils.length} require re-deploy)
								</span>
							)}
						</span>
						{updatableTendrils.length > 0 && (
							<Button
								size="sm"
								variant="outline"
								className="h-7 text-xs border-border text-foreground hover:bg-muted"
								disabled={isUpdatingAll}
								onClick={handleUpdateAll}
							>
								{isUpdatingAll ? (
									<>
										<Loader2 className="mr-1.5 h-3 w-3 animate-spin" />
										Updating...
									</>
								) : (
									<>Update All ({updatableTendrils.length})</>
								)}
							</Button>
						)}
					</AlertTitle>
				</Alert>
			)}

			{tendrils.length === 0 ? (
				<div className="flex flex-col items-center justify-center py-16 text-center">
					<div className="p-3 bg-muted/50 rounded-full mb-4">
						<Server className="h-8 w-8 text-muted-foreground" />
					</div>
					<h3 className="text-sm font-medium text-foreground mb-1">No runners available</h3>
					<p className="text-xs text-muted-foreground max-w-sm mb-4">
						Runners execute provisioning jobs for your infrastructure. Cloud runners are managed by the platform. You can also deploy your own.
					</p>
					<AddTendrilButton />
				</div>
			) : (
				<>
					<section>
						<div className="flex flex-col sm:flex-row gap-3 mb-3">
							<div className="flex gap-1">
								{STATUS_FILTERS.map((s) => (
									<Button
										key={s}
										variant={statusFilter === s ? "secondary" : "ghost"}
										size="sm"
										className="h-7 text-xs px-2.5"
										onClick={() => setStatusFilter(s)}
									>
										{s === "All" ? "All" : s.charAt(0) + s.slice(1).toLowerCase()}
									</Button>
								))}
							</div>
							<div className="relative flex-1 max-w-xs">
								<Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
								<Input
									placeholder="Search by name..."
									value={searchQuery}
									onChange={(e) => setSearchQuery(e.target.value)}
									className="h-7 text-xs pl-8 bg-muted/30 border-border/50"
								/>
							</div>
						</div>
						<DataTable
							columns={tendrilColumns}
							data={filtered}
							pageSize={20}
							scrollHeight="h-[50vh]"
						/>
					</section>

					{activeJobs.length > 0 && (
						<section>
							<h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">
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
	);
}
