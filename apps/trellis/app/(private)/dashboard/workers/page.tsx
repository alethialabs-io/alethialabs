"use client";

import {
	WorkerCard,
} from "@/components/workers/worker-card";
import { AddWorkerButton } from "@/components/workers/add-worker-button";
import { Skeleton } from "@/components/ui/skeleton";
import { createClient } from "@/lib/supabase/client";
import { useWorkersStore, type ActiveJob } from "@/lib/stores/use-workers-store";
import type { PublicWorkersRow } from "@/lib/validations/db.schemas";
import { Server, Shield } from "lucide-react";
import { useEffect, useMemo } from "react";

export default function WorkersPage() {
	const {
		workers,
		activeJobs,
		isLoading,
		fetchWorkers,
		addOrUpdateWorker,
		removeWorker,
		addOrUpdateJob,
	} = useWorkersStore();

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

	const hasSelfHosted = useMemo(
		() => workers.some((w) => w.mode === "self-hosted"),
		[workers],
	);

	if (isLoading) {
		return (
			<div className="space-y-6">
				<div>
					<h1 className="text-2xl font-semibold tracking-tight text-foreground">
						Workers
					</h1>
					<p className="text-sm text-muted-foreground mt-1">
						Live status of provisioning workers and their active
						jobs.
					</p>
				</div>
				<div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
					{[1, 2, 3].map((i) => (
						<div key={i} className="rounded-lg border border-border/40 p-4 space-y-3">
							<div className="flex items-center gap-2">
								<Skeleton className="h-2.5 w-2.5 rounded-full" />
								<Skeleton className="h-4 w-28" />
							</div>
							<div className="space-y-1.5">
								<Skeleton className="h-3 w-40" />
								<Skeleton className="h-3 w-24" />
							</div>
							<div className="flex gap-2 pt-1">
								<Skeleton className="h-5 w-16 rounded-full" />
								<Skeleton className="h-5 w-20 rounded-full" />
							</div>
						</div>
					))}
				</div>
			</div>
		);
	}

	return (
		<div className="space-y-8">
			<div>
				<h1 className="text-2xl font-semibold tracking-tight text-foreground">
					Workers
				</h1>
				<p className="text-sm text-muted-foreground mt-1">
					Live status of provisioning workers and their active jobs.
				</p>
			</div>

			{workers.length === 0 ? (
				<div className="flex flex-col items-center justify-center py-16 text-center">
					<div className="p-3 bg-muted/50 rounded-full mb-4">
						<Server className="h-8 w-8 text-muted-foreground" />
					</div>
					<h3 className="text-sm font-medium text-foreground mb-1">
						No workers available
					</h3>
					<p className="text-xs text-muted-foreground max-w-sm mb-4">
						Workers execute provisioning jobs for your
						infrastructure. Cloud workers are managed by the
						platform. You can also deploy your own.
					</p>
					<AddWorkerButton />
				</div>
			) : (
				<>
					<div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
						{workers.map((w) => (
							<WorkerCard
								key={w.id}
								worker={w}
								activeJob={jobsByWorker.get(w.id) ?? null}
							/>
						))}
					</div>

					{!hasSelfHosted ? (
						<div className="rounded-lg border border-dashed border-border/60 p-6 flex items-start gap-4">
							<div className="p-2 rounded-md bg-muted/50 shrink-0">
								<Shield className="h-5 w-5 text-muted-foreground" />
							</div>
							<div className="flex-1 space-y-1.5">
								<p className="text-sm font-medium">
									Deploy your own worker
								</p>
								<p className="text-xs text-muted-foreground max-w-lg">
									Run a self-hosted worker in your own
									infrastructure for full control over
									permissions and data locality. Your cloud
									credentials never leave your account.
								</p>
								<div className="pt-1">
									<AddWorkerButton />
								</div>
							</div>
						</div>
					) : (
						<div className="flex justify-end">
							<AddWorkerButton />
						</div>
					)}
				</>
			)}
		</div>
	);
}
