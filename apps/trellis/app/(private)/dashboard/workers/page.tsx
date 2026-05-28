import { Badge } from "@/components/ui/badge";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import { RegisterWorkerButton } from "@/components/workers/register-worker-button";
import { createClient } from "@/lib/supabase/server";
import {
	Activity,
	CheckCircle2,
	Clock,
	Server,
	XCircle,
} from "lucide-react";

function statusBadge(status: string | null) {
	switch (status) {
		case "ONLINE":
			return (
				<Badge variant="default" className="bg-emerald-600 text-white">
					<Activity className="mr-1 h-3 w-3" />
					Online
				</Badge>
			);
		case "DRAINING":
			return (
				<Badge variant="secondary">
					<Clock className="mr-1 h-3 w-3" />
					Draining
				</Badge>
			);
		default:
			return (
				<Badge variant="outline" className="text-muted-foreground">
					Offline
				</Badge>
			);
	}
}

function jobStatusBadge(status: string) {
	switch (status) {
		case "SUCCESS":
			return (
				<Badge variant="default" className="bg-emerald-600 text-white">
					<CheckCircle2 className="mr-1 h-3 w-3" />
					Success
				</Badge>
			);
		case "FAILED":
			return (
				<Badge variant="destructive">
					<XCircle className="mr-1 h-3 w-3" />
					Failed
				</Badge>
			);
		case "PROCESSING":
			return (
				<Badge variant="secondary">
					<Activity className="mr-1 h-3 w-3 animate-pulse" />
					Processing
				</Badge>
			);
		case "CLAIMED":
			return (
				<Badge variant="secondary">
					<Clock className="mr-1 h-3 w-3" />
					Claimed
				</Badge>
			);
		case "QUEUED":
			return (
				<Badge variant="outline">
					<Clock className="mr-1 h-3 w-3" />
					Queued
				</Badge>
			);
		default:
			return <Badge variant="outline">{status}</Badge>;
	}
}

function timeAgo(dateStr: string | null) {
	if (!dateStr) return "Never";
	const diff = Date.now() - new Date(dateStr).getTime();
	const mins = Math.floor(diff / 60000);
	if (mins < 1) return "Just now";
	if (mins < 60) return `${mins}m ago`;
	const hours = Math.floor(mins / 60);
	if (hours < 24) return `${hours}h ago`;
	return `${Math.floor(hours / 24)}d ago`;
}

export default async function WorkersPage() {
	const supabase = await createClient();
	const {
		data: { user },
	} = await supabase.auth.getUser();

	const { data: workers } = await supabase
		.from("workers")
		.select("*")
		.eq("user_id", user!.id)
		.order("created_at", { ascending: false });

	const { data: recentJobs } = await supabase
		.from("provision_jobs")
		.select("*")
		.eq("user_id", user!.id)
		.order("created_at", { ascending: false })
		.limit(20);

	return (
		<div className="space-y-8 w-full">
			<div className="flex flex-col md:flex-row md:items-end justify-between gap-4">
				<div className="space-y-1.5">
					<h1 className="text-2xl sm:text-3xl font-semibold tracking-tight text-foreground">
						Workers & Jobs
					</h1>
					<p className="text-muted-foreground text-sm">
						Manage provisioning workers and monitor job execution.
					</p>
				</div>
				<RegisterWorkerButton />
			</div>

			<Card>
				<CardHeader>
					<CardTitle className="text-lg">
						Registered Workers
					</CardTitle>
					<CardDescription>
						Workers poll for queued jobs and execute provisioning
						tasks.
					</CardDescription>
				</CardHeader>
				<CardContent>
					{!workers || workers.length === 0 ? (
						<div className="text-center py-12 text-muted-foreground">
							<Server className="mx-auto h-10 w-10 mb-3 opacity-30" />
							<p className="text-sm">No workers registered yet.</p>
							<p className="text-xs mt-1">
								Click Register Worker above, or use{" "}
								<code className="bg-muted px-1 py-0.5 rounded text-[11px]">
									grape worker register
								</code>{" "}
								from the CLI.
							</p>
						</div>
					) : (
						<Table>
							<TableHeader>
								<TableRow>
									<TableHead>Name</TableHead>
									<TableHead>Mode</TableHead>
									<TableHead>Status</TableHead>
									<TableHead>Last Heartbeat</TableHead>
									<TableHead>Created</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{workers.map((w) => (
									<TableRow key={w.id}>
										<TableCell className="font-medium">
											{w.name}
										</TableCell>
										<TableCell>
											<Badge variant="outline">
												{w.mode}
											</Badge>
										</TableCell>
										<TableCell>
											{statusBadge(w.status)}
										</TableCell>
										<TableCell className="text-muted-foreground text-sm">
											{timeAgo(w.last_heartbeat)}
										</TableCell>
										<TableCell className="text-muted-foreground text-sm">
											{new Date(
												w.created_at!,
											).toLocaleDateString()}
										</TableCell>
									</TableRow>
								))}
							</TableBody>
						</Table>
					)}
				</CardContent>
			</Card>

			<Card>
				<CardHeader>
					<CardTitle className="text-lg">Recent Jobs</CardTitle>
					<CardDescription>
						Provisioning jobs queued through the CLI or Trellis.
					</CardDescription>
				</CardHeader>
				<CardContent>
					{!recentJobs || recentJobs.length === 0 ? (
						<div className="text-center py-12 text-muted-foreground">
							<Activity className="mx-auto h-10 w-10 mb-3 opacity-30" />
							<p className="text-sm">No jobs yet.</p>
							<p className="text-xs mt-1">
								Jobs appear here when you create a configuration
								or run{" "}
								<code className="bg-muted px-1 py-0.5 rounded text-[11px]">
									grape harvest
								</code>
								.
							</p>
						</div>
					) : (
						<Table>
							<TableHeader>
								<TableRow>
									<TableHead>Type</TableHead>
									<TableHead>Status</TableHead>
									<TableHead>Worker</TableHead>
									<TableHead>Created</TableHead>
									<TableHead>Completed</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{recentJobs.map((job) => (
									<TableRow key={job.id}>
										<TableCell>
											<Badge variant="outline">
												{job.job_type}
											</Badge>
										</TableCell>
										<TableCell>
											{jobStatusBadge(job.status)}
										</TableCell>
										<TableCell className="text-muted-foreground text-sm font-mono">
											{job.worker_id
												? job.worker_id.slice(0, 8)
												: "-"}
										</TableCell>
										<TableCell className="text-muted-foreground text-sm">
											{timeAgo(job.created_at)}
										</TableCell>
										<TableCell className="text-muted-foreground text-sm">
											{job.completed_at
												? timeAgo(job.completed_at)
												: "-"}
										</TableCell>
									</TableRow>
								))}
							</TableBody>
						</Table>
					)}
				</CardContent>
			</Card>
		</div>
	);
}
