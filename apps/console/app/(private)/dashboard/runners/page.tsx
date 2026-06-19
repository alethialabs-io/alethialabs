"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only


import { Alert, AlertTitle } from "@/components/ui/alert";
import { DataTable } from "@/components/data-table";
import { jobColumns } from "@/components/jobs/columns";
import { runnerColumns, type RunnerRow } from "@/components/runners/columns";
import { AddRunnerButton } from "@/components/runners/add-runner-button";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useRunnersStore, type ActiveJob } from "@/lib/stores/use-runners-store";
import { useJobsStore } from "@/lib/stores/use-jobs-store";
import type {
	ProvisionJobType as PublicProvisionJobType,
	RunnerStatus as PublicRunnerStatus,
} from "@/lib/db/schema";
import type { JobWithMeta as PublicProvisionJobsRow } from "@/app/server/actions/jobs";
import type { RunnerMetadata } from "@/types/database-custom.types";
import { ArrowUpCircle, Loader2, Search, Server } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

const STATUS_FILTERS: (PublicRunnerStatus | "All")[] = [
	"All", "ONLINE", "OFFLINE", "DRAINING",
];

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
	const [searchQuery, setSearchQuery] = useState("");
	const [isUpdatingAll, setIsUpdatingAll] = useState(false);

	useEffect(() => {
		fetchRunners(true);
		// Poll for runner status (heartbeat-driven ONLINE/OFFLINE changes server-side).
		const interval = setInterval(() => fetchRunners(true), 10_000);
		return () => clearInterval(interval);
	}, [fetchRunners]);

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
		if (searchQuery.trim()) {
			const q = searchQuery.toLowerCase();
			result = result.filter((w) => w.name.toLowerCase().includes(q));
		}
		return result;
	}, [runnerRows, statusFilter, searchQuery]);

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
				<AddRunnerButton />
			</div>

			{outdatedRunners.length > 0 && latestRelease && (
				<Alert className="text-foreground border-border bg-muted">
					<ArrowUpCircle className="h-4 w-4" />
					<AlertTitle className="flex items-center justify-between">
						<span>
							<strong>{outdatedRunners.length} runner{outdatedRunners.length !== 1 ? "s" : ""}</strong>{" "}
							{outdatedRunners.length !== 1 ? "have" : "has"} updates available
							<span className="font-normal ml-1">— v{latestRelease.version} is out</span>
							{outdatedRunners.length > updatableRunners.length && (
								<span className="font-normal text-muted-foreground ml-1">
									({outdatedRunners.length - updatableRunners.length} require re-deploy)
								</span>
							)}
						</span>
						{updatableRunners.length > 0 && (
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
									<>Update All ({updatableRunners.length})</>
								)}
							</Button>
						)}
					</AlertTitle>
				</Alert>
			)}

			{runners.length === 0 ? (
				<div className="flex flex-col items-center justify-center py-16 text-center">
					<div className="p-3 bg-muted/50 rounded-full mb-4">
						<Server className="h-8 w-8 text-muted-foreground" />
					</div>
					<h3 className="text-sm font-medium text-foreground mb-1">No runners available</h3>
					<p className="text-xs text-muted-foreground max-w-sm mb-4">
						Runners execute provisioning jobs for your infrastructure. Cloud runners are managed by the platform. You can also deploy your own.
					</p>
					<AddRunnerButton />
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
							columns={runnerColumns}
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
