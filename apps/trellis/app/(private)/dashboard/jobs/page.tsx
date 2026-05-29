import { createClient } from "@/lib/supabase/server";
import { Badge } from "@/components/ui/badge";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import { ClipboardList } from "lucide-react";

const STATUS_STYLES: Record<string, string> = {
	SUCCESS:
		"text-emerald-600 border-emerald-200 bg-emerald-50 dark:text-emerald-400 dark:border-emerald-800 dark:bg-emerald-950",
	FAILED:
		"text-destructive border-destructive/30 bg-destructive/10",
	PROCESSING:
		"text-blue-600 border-blue-200 bg-blue-50 dark:text-blue-400 dark:border-blue-800 dark:bg-blue-950",
	CLAIMED:
		"text-amber-600 border-amber-200 bg-amber-50 dark:text-amber-400 dark:border-amber-800 dark:bg-amber-950",
	QUEUED:
		"text-muted-foreground border-border bg-muted/50",
};

export default async function JobsPage() {
	const supabase = await createClient();

	const { data: jobs } = await supabase
		.from("provision_jobs")
		.select("id, job_type, status, created_at, completed_at, worker_id, error_message")
		.order("created_at", { ascending: false })
		.limit(50);

	return (
		<div className="space-y-8">
			<div>
				<h1 className="text-2xl font-semibold tracking-tight text-foreground">
					Jobs
				</h1>
				<p className="text-sm text-muted-foreground mt-1">
					Provision job history and execution logs.
				</p>
			</div>

			{!jobs || jobs.length === 0 ? (
				<div className="flex flex-col items-center justify-center py-16 text-center">
					<div className="p-3 bg-muted/50 rounded-full mb-4">
						<ClipboardList className="h-8 w-8 text-muted-foreground" />
					</div>
					<h3 className="text-sm font-medium text-foreground mb-1">
						No jobs yet
					</h3>
					<p className="text-xs text-muted-foreground max-w-sm">
						Jobs are created when you provision a vine. Plant a
						vine and trigger provisioning to see jobs here.
					</p>
				</div>
			) : (
				<div className="border border-border/50 rounded-lg overflow-hidden">
					<Table>
						<TableHeader>
							<TableRow className="hover:bg-transparent">
								<TableHead className="text-xs">Type</TableHead>
								<TableHead className="text-xs">Status</TableHead>
								<TableHead className="text-xs">Worker</TableHead>
								<TableHead className="text-xs">Created</TableHead>
								<TableHead className="text-xs">Completed</TableHead>
								<TableHead className="text-xs">Error</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{jobs.map((job) => (
								<TableRow key={job.id}>
									<TableCell className="text-xs font-mono">
										{job.job_type}
									</TableCell>
									<TableCell>
										<Badge
											variant="outline"
											className={`text-[10px] py-0 ${STATUS_STYLES[job.status ?? ""] ?? ""}`}
										>
											{job.status}
										</Badge>
									</TableCell>
									<TableCell className="text-xs text-muted-foreground font-mono truncate max-w-[120px]">
										{job.worker_id
											? job.worker_id.slice(0, 8)
											: "—"}
									</TableCell>
									<TableCell className="text-xs text-muted-foreground">
										{job.created_at
											? new Date(
													job.created_at,
												).toLocaleString()
											: "—"}
									</TableCell>
									<TableCell className="text-xs text-muted-foreground">
										{job.completed_at
											? new Date(
													job.completed_at,
												).toLocaleString()
											: "—"}
									</TableCell>
									<TableCell className="text-xs text-destructive truncate max-w-[200px]">
										{job.error_message || "—"}
									</TableCell>
								</TableRow>
							))}
						</TableBody>
					</Table>
				</div>
			)}
		</div>
	);
}
