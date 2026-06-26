"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only


import { DataTable } from "@/components/data-table";
import { jobColumns, JOB_TYPES } from "@/components/jobs/columns";
import { Skeleton } from "@repo/ui/skeleton";
import {
	useJobsStore,
	type PublicProvisionJobStatus,
	type PublicProvisionJobType,
} from "@/lib/stores/use-jobs-store";
import type { JobWithMeta } from "@/app/server/actions/jobs";
import { Button } from "@repo/ui/button";
import { Input } from "@repo/ui/input";
import { TooltipProvider } from "@repo/ui/tooltip";
import { ClipboardList, Search } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo } from "react";

const STATUS_FILTERS: (PublicProvisionJobStatus | "All")[] = [
	"All", "QUEUED", "PROCESSING", "SUCCESS", "FAILED",
];

const TYPE_FILTERS: (PublicProvisionJobType | "All")[] = [
	"All", "DEPLOY", "PLAN", "DESTROY", "CONNECTION_TEST", "FETCH_RESOURCES", "DEPLOY_RUNNER", "UPDATE_RUNNER", "DESTROY_RUNNER",
];

export default function JobsPage() {
	const router = useRouter();
	const store = useJobsStore();

	const {
		jobs,
		isLoading,
		statusFilter,
		typeFilter,
		searchQuery,
		currentPage,
		pageSize,
		fetchJobs,
		setStatusFilter,
		setTypeFilter,
		setSearchQuery,
		setCurrentPage,
	} = store;

	useEffect(() => {
		fetchJobs();
	}, [fetchJobs]);

	const filtered = useMemo(() => {
		let result = jobs;
		if (statusFilter !== "All") {
			result = result.filter((j) => j.status === statusFilter);
		}
		if (typeFilter !== "All") {
			result = result.filter((j) => j.job_type === typeFilter);
		}
		if (searchQuery.trim()) {
			const q = searchQuery.toLowerCase();
			result = result.filter(
				(j) =>
					j.id.toLowerCase().includes(q) ||
					(j.runner_id && j.runner_id.toLowerCase().includes(q)) ||
					(j.spec_id && j.spec_id.toLowerCase().includes(q)),
			);
		}
		return result;
	}, [jobs, statusFilter, typeFilter, searchQuery]);

	const handleRowClick = (job: JobWithMeta) => {
		router.push(`/dashboard/jobs/${job.id}`);
	};

	if (isLoading && jobs.length === 0) {
		return (
			<div className="space-y-6">
				<div>
					<h1 className="text-2xl font-semibold tracking-tight text-foreground">Jobs</h1>
					<p className="text-sm text-muted-foreground mt-1">Provision job history and execution logs.</p>
				</div>
				<div className="space-y-4">
					<div className="flex flex-col sm:flex-row gap-3">
						<div className="flex gap-1">
							{[1, 2, 3, 4, 5].map((i) => (
								<Skeleton key={i} className="h-7 w-16 rounded-md" />
							))}
						</div>
						<Skeleton className="h-7 w-48 rounded-md" />
					</div>
					<div className="rounded-lg border border-border/40">
						<div className="flex gap-4 border-b border-border/40 p-3">
							{[1, 2, 3, 4, 5].map((i) => (
								<Skeleton key={i} className="h-3 w-20" />
							))}
						</div>
						{[1, 2, 3, 4, 5].map((i) => (
							<div key={i} className="flex gap-4 border-b border-border/20 p-3">
								<Skeleton className="h-3 w-16" />
								<Skeleton className="h-3 w-20" />
								<Skeleton className="h-3 w-14 rounded-full" />
								<Skeleton className="h-3 w-24" />
								<Skeleton className="h-3 w-28" />
							</div>
						))}
					</div>
				</div>
			</div>
		);
	}

	return (
		<div className="space-y-6">
			<div>
				<h1 className="text-2xl font-semibold tracking-tight text-foreground">Jobs</h1>
				<p className="text-sm text-muted-foreground mt-1">Provision job history and execution logs.</p>
			</div>

			{jobs.length === 0 ? (
				<div className="flex flex-col items-center justify-center py-16 text-center">
					<div className="p-3 bg-muted/50 rounded-full mb-4">
						<ClipboardList className="h-8 w-8 text-muted-foreground" />
					</div>
					<h3 className="text-sm font-medium text-foreground mb-1">No jobs yet</h3>
					<p className="text-xs text-muted-foreground max-w-sm">
						Jobs are created when you provision a spec or connect a cloud account.
					</p>
				</div>
			) : (
				<>
					<div className="flex flex-col sm:flex-row gap-3">
						<div className="flex gap-1 flex-wrap">
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
								placeholder="Search by ID, runner, spec..."
								value={searchQuery}
								onChange={(e) => setSearchQuery(e.target.value)}
								className="h-7 text-xs pl-8 bg-muted/30 border-border/50"
							/>
						</div>

						<div className="flex gap-1 flex-wrap">
							{TYPE_FILTERS.map((t) => (
								<Button
									key={t}
									variant={typeFilter === t ? "secondary" : "ghost"}
									size="sm"
									className="h-7 text-[10px] px-2"
									onClick={() => setTypeFilter(t)}
								>
									{t === "All" ? "All Types" : JOB_TYPES[t]?.label ?? t.replace("_", " ")}
								</Button>
							))}
						</div>
					</div>

					<TooltipProvider delayDuration={300}>
						<DataTable
							columns={jobColumns}
							data={filtered}
							onRowClick={handleRowClick}
							pageSize={pageSize}
							pageIndex={currentPage}
							onPageIndexChange={setCurrentPage}
							scrollHeight="h-[70vh]"
						/>
					</TooltipProvider>
				</>
			)}
		</div>
	);
}
