"use client";

import { getJobs } from "@/app/server/actions/jobs";
import { DataTable } from "@/components/data-table";
import { jobColumns } from "@/components/jobs/columns";
import type { PublicProvisionJobsRow } from "@/lib/validations/db.schemas";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ClipboardList, Search } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";

const STATUS_FILTERS = ["All", "QUEUED", "PROCESSING", "SUCCESS", "FAILED"] as const;
const TYPE_FILTERS = ["All", "DEPLOY", "PLAN", "BOOTSTRAP", "DESTROY", "CONNECTION_TEST", "FETCH_RESOURCES"] as const;

export default function JobsPage() {
	const router = useRouter();
	const pathname = usePathname();
	const searchParams = useSearchParams();

	const [jobs, setJobs] = useState<PublicProvisionJobsRow[]>([]);
	const [loading, setLoading] = useState(true);

	const statusFilter = searchParams.get("status") || "All";
	const typeFilter = searchParams.get("type") || "All";
	const search = searchParams.get("search") || "";
	/** Updates URL search params without full navigation. */
	const updateParams = useCallback(
		(updates: Record<string, string | null>) => {
			const params = new URLSearchParams(searchParams.toString());
			for (const [key, value] of Object.entries(updates)) {
				if (value === null || value === "" || value === "All") {
					params.delete(key);
				} else {
					params.set(key, value);
				}
			}
			router.replace(`${pathname}?${params.toString()}`, { scroll: false });
		},
		[searchParams, pathname, router],
	);

	const fetchJobs = useCallback(async () => {
		try {
			const data = await getJobs();
			setJobs(data as PublicProvisionJobsRow[]);
		} catch (err) {
			console.error("Failed to fetch jobs:", err);
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		fetchJobs();
	}, [fetchJobs]);

	// Realtime: refresh job list on INSERT/UPDATE
	useEffect(() => {
		const supabase = createClient();
		let userId: string | null = null;

		supabase.auth.getUser().then(({ data: { user } }) => {
			if (!user) return;
			userId = user.id;

			const channel = supabase
				.channel("jobs-page-realtime")
				.on(
					"postgres_changes",
					{
						event: "*",
						schema: "public",
						table: "provision_jobs",
						filter: `user_id=eq.${userId}`,
					},
					() => fetchJobs(),
				)
				.subscribe();

			return () => {
				supabase.removeChannel(channel);
			};
		});
	}, [fetchJobs]);

	const filtered = useMemo(() => {
		let result = jobs;
		if (statusFilter !== "All") {
			result = result.filter((j) => j.status === statusFilter);
		}
		if (typeFilter !== "All") {
			result = result.filter((j) => j.job_type === typeFilter);
		}
		if (search.trim()) {
			const q = search.toLowerCase();
			result = result.filter(
				(j) =>
					j.id.toLowerCase().includes(q) ||
					(j.worker_id && j.worker_id.toLowerCase().includes(q)) ||
					(j.vine_id && j.vine_id.toLowerCase().includes(q)),
			);
		}
		return result;
	}, [jobs, statusFilter, typeFilter, search]);

	const handleRowClick = (job: PublicProvisionJobsRow) => {
		router.push(`/dashboard/jobs/${job.id}`);
	};

	if (loading) {
		return (
			<div className="space-y-6">
				<div>
					<h1 className="text-2xl font-semibold tracking-tight text-foreground">
						Jobs
					</h1>
					<p className="text-sm text-muted-foreground mt-1">
						Provision job history and execution logs.
					</p>
				</div>
				<div className="animate-pulse space-y-3">
					<div className="h-9 bg-muted rounded w-full" />
					<div className="h-64 bg-muted rounded" />
				</div>
			</div>
		);
	}

	return (
		<div className="space-y-6">
			<div>
				<h1 className="text-2xl font-semibold tracking-tight text-foreground">
					Jobs
				</h1>
				<p className="text-sm text-muted-foreground mt-1">
					Provision job history and execution logs.
				</p>
			</div>

			{jobs.length === 0 ? (
				<div className="flex flex-col items-center justify-center py-16 text-center">
					<div className="p-3 bg-muted/50 rounded-full mb-4">
						<ClipboardList className="h-8 w-8 text-muted-foreground" />
					</div>
					<h3 className="text-sm font-medium text-foreground mb-1">
						No jobs yet
					</h3>
					<p className="text-xs text-muted-foreground max-w-sm">
						Jobs are created when you provision a vine or connect
						a cloud account.
					</p>
				</div>
			) : (
				<>
					{/* Filters */}
					<div className="flex flex-col sm:flex-row gap-3">
						<div className="flex gap-1 flex-wrap">
							{STATUS_FILTERS.map((s) => (
								<Button
									key={s}
									variant={statusFilter === s ? "secondary" : "ghost"}
									size="sm"
									className="h-7 text-xs px-2.5"
									onClick={() => updateParams({ status: s })}
								>
									{s === "All" ? "All" : s.charAt(0) + s.slice(1).toLowerCase()}
								</Button>
							))}
						</div>

						<div className="relative flex-1 max-w-xs">
							<Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
							<Input
								placeholder="Search by ID, worker, vine..."
								value={search}
								onChange={(e) => updateParams({ search: e.target.value })}
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
									onClick={() => updateParams({ type: t })}
								>
									{t === "All" ? "All Types" : t.replace("_", " ")}
								</Button>
							))}
						</div>
					</div>

					<DataTable
						columns={jobColumns}
						data={filtered}
						onRowClick={handleRowClick}
						pageSize={15}
					/>
				</>
			)}
		</div>
	);
}
