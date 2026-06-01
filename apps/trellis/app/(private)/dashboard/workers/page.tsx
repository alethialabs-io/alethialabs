"use client";

import { DataTable } from "@/components/data-table";
import { jobColumns } from "@/components/jobs/columns";
import { workerColumns, type WorkerRow } from "@/components/workers/columns";
import { AddWorkerButton } from "@/components/workers/add-worker-button";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { createClient } from "@/lib/supabase/client";
import { useWorkersStore, type ActiveJob } from "@/lib/stores/use-workers-store";
import type { PublicWorkerStatus, PublicWorkersRow, PublicProvisionJobsRow } from "@/lib/validations/db.schemas";
import { Search, Server } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

const STATUS_FILTERS: (PublicWorkerStatus | "All")[] = [
	"All", "ONLINE", "OFFLINE", "DRAINING",
];

export default function WorkersPage() {
	const router = useRouter();
	const {
		workers,
		activeJobs,
		isLoading,
		fetchWorkers,
		addOrUpdateWorker,
		removeWorker,
		addOrUpdateJob,
	} = useWorkersStore();

	const [statusFilter, setStatusFilter] = useState<PublicWorkerStatus | "All">("All");
	const [searchQuery, setSearchQuery] = useState("");

	useEffect(() => {
		fetchWorkers(true);
	}, [fetchWorkers]);

	useEffect(() => {
		const supabase = createClient();

		const channel = supabase
			.channel("workers-live")
			.on(
				"postgres_changes",
				{ event: "*", schema: "public", table: "workers" },
				(payload) => {
					if (payload.eventType === "DELETE") {
						removeWorker((payload.old as { id: string }).id);
						return;
					}
					addOrUpdateWorker(payload.new as PublicWorkersRow);
				},
			)
			.on(
				"postgres_changes",
				{ event: "*", schema: "public", table: "provision_jobs" },
				(payload) => {
					const job = payload.new as ActiveJob;
					if (job) addOrUpdateJob(job);
				},
			)
			.subscribe();

		return () => {
			supabase.removeChannel(channel);
		};
	}, [addOrUpdateWorker, removeWorker, addOrUpdateJob]);

	const jobsByWorker = useMemo(() => {
		const map = new Map<string, ActiveJob>();
		for (const job of activeJobs) {
			if (job.worker_id) map.set(job.worker_id, job);
		}
		return map;
	}, [activeJobs]);

	const workerRows: WorkerRow[] = useMemo(
		() => workers.map((w) => ({ ...w, activeJob: jobsByWorker.get(w.id) ?? null })),
		[workers, jobsByWorker],
	);

	const filtered = useMemo(() => {
		let result = workerRows;
		if (statusFilter !== "All") {
			result = result.filter((w) => (w.status ?? "OFFLINE") === statusFilter);
		}
		if (searchQuery.trim()) {
			const q = searchQuery.toLowerCase();
			result = result.filter((w) => w.name.toLowerCase().includes(q));
		}
		return result;
	}, [workerRows, statusFilter, searchQuery]);

	const handleJobClick = (job: PublicProvisionJobsRow) => {
		router.push(`/dashboard/jobs/${job.id}`);
	};

	if (isLoading) {
		return (
			<div className="space-y-6">
				<div>
					<h1 className="text-2xl font-semibold tracking-tight text-foreground">Workers</h1>
					<p className="text-sm text-muted-foreground mt-1">Live status of provisioning workers and their active jobs.</p>
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
					<h1 className="text-2xl font-semibold tracking-tight text-foreground">Workers</h1>
					<p className="text-sm text-muted-foreground mt-1">Live status of provisioning workers and their active jobs.</p>
				</div>
				<AddWorkerButton />
			</div>

			{workers.length === 0 ? (
				<div className="flex flex-col items-center justify-center py-16 text-center">
					<div className="p-3 bg-muted/50 rounded-full mb-4">
						<Server className="h-8 w-8 text-muted-foreground" />
					</div>
					<h3 className="text-sm font-medium text-foreground mb-1">No workers available</h3>
					<p className="text-xs text-muted-foreground max-w-sm mb-4">
						Workers execute provisioning jobs for your infrastructure. Cloud workers are managed by the platform. You can also deploy your own.
					</p>
					<AddWorkerButton />
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
							columns={workerColumns}
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
