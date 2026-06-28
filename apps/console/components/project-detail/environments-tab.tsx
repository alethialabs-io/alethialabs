"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// M1: a project owns N environments, each independently provisionable. This tab lists
// them (name · stage · status · region), provisions each (Plan/Apply target the
// chosen environment), and adds / removes non-default environments.

import { FileText, Loader2, Plus, Rocket, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import {
	addEnvironment,
	deleteEnvironment,
	getProjectEnvironments,
	planProject,
	provisionProject,
} from "@/app/server/actions/projects";
import { RunnerSelectPopover } from "@/components/runners/runner-select-popover";
import { Badge } from "@repo/ui/badge";
import { Button } from "@repo/ui/button";
import { Card, CardContent } from "@repo/ui/card";
import {
	Dialog,
	DialogContent,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@repo/ui/dialog";
import { Input } from "@repo/ui/input";
import { Label } from "@repo/ui/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@repo/ui/select";
import { StatusBadge } from "@repo/ui/status-badge";

type EnvStage = "development" | "staging" | "production";

interface ProjectEnv {
	id: string;
	name: string;
	stage: string;
	status: string;
	region: string | null;
	is_default: boolean;
}

interface EnvironmentsTabProps {
	projectId: string;
	environments: ProjectEnv[];
}

export function EnvironmentsTab({
	projectId,
	environments: initial,
}: EnvironmentsTabProps) {
	const router = useRouter();
	const [environments, setEnvironments] = useState<ProjectEnv[]>(initial);
	const [addOpen, setAddOpen] = useState(false);
	const [busyId, setBusyId] = useState<string | null>(null);

	/** Re-pulls the project's environments after a mutation. */
	async function refresh() {
		try {
			const { environments: rows } = await getProjectEnvironments(projectId);
			setEnvironments(rows as ProjectEnv[]);
		} catch {
			// non-fatal — the list just keeps its last good state.
		}
	}

	/** Queues a PLAN or DEPLOY job for one environment, then opens its job page. */
	async function provision(
		kind: "plan" | "apply",
		envId: string,
		runnerId: string | null,
	) {
		setBusyId(envId);
		try {
			const { jobId } =
				kind === "plan"
					? await planProject(projectId, runnerId, envId)
					: await provisionProject(projectId, undefined, runnerId, envId);
			toast.success(kind === "plan" ? "Plan queued" : "Deploy queued");
			await refresh();
			router.push(`/dashboard/jobs/${jobId}`);
		} catch (err) {
			toast.error(err instanceof Error ? err.message : "Failed to queue job");
		} finally {
			setBusyId(null);
		}
	}

	async function remove(env: ProjectEnv) {
		if (!confirm(`Delete the "${env.name}" environment?`)) return;
		setBusyId(env.id);
		try {
			await deleteEnvironment(projectId, env.id);
			toast.success("Environment deleted");
			await refresh();
		} catch (err) {
			toast.error(err instanceof Error ? err.message : "Failed to delete");
		} finally {
			setBusyId(null);
		}
	}

	return (
		<div className="space-y-4">
			<div className="flex items-center justify-between">
				<p className="text-xs text-muted-foreground">
					Each environment deploys independently into its own infrastructure state.
				</p>
				<Button size="sm" variant="outline" className="h-8 text-xs" onClick={() => setAddOpen(true)}>
					<Plus className="h-3.5 w-3.5 mr-1.5" />
					Add environment
				</Button>
			</div>

			<Card>
				<CardContent className="p-0">
					<div className="divide-y divide-border">
						{environments.map((env) => (
							<div
								key={env.id}
								className="flex flex-wrap items-center justify-between gap-3 p-4"
							>
								<div className="flex items-center gap-3">
									<div>
										<div className="flex items-center gap-2">
											<span className="text-sm font-medium">{env.name}</span>
											<Badge variant="outline" className="text-[10px] py-0">
												{env.stage}
											</Badge>
											{env.is_default && (
												<Badge variant="secondary" className="text-[10px] py-0">
													Default
												</Badge>
											)}
										</div>
										<p className="mt-0.5 text-xs text-muted-foreground">
											<StatusBadge status={env.status} />
											{env.region ? ` · ${env.region}` : ""}
										</p>
									</div>
								</div>

								<div className="flex items-center gap-2">
									<RunnerSelectPopover
										trigger={
											<Button
												variant="outline"
												size="sm"
												className="h-8 text-xs"
												disabled={busyId === env.id}
											>
												{busyId === env.id ? (
													<Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
												) : (
													<FileText className="h-3.5 w-3.5 mr-1.5" />
												)}
												Plan
											</Button>
										}
										onConfirm={(runnerId) => provision("plan", env.id, runnerId)}
										disabled={busyId === env.id}
									/>
									<RunnerSelectPopover
										trigger={
											<Button
												size="sm"
												className="h-8 text-xs"
												disabled={busyId === env.id}
											>
												<Rocket className="h-3.5 w-3.5 mr-1.5" />
												Apply
											</Button>
										}
										onConfirm={(runnerId) => provision("apply", env.id, runnerId)}
										disabled={busyId === env.id}
									/>
									{!env.is_default && (
										<Button
											variant="ghost"
											size="icon"
											className="h-8 w-8 text-destructive"
											disabled={busyId === env.id}
											onClick={() => remove(env)}
										>
											<Trash2 className="h-4 w-4" />
										</Button>
									)}
								</div>
							</div>
						))}
					</div>
				</CardContent>
			</Card>

			<AddEnvironmentDialog
				open={addOpen}
				onOpenChange={setAddOpen}
				projectId={projectId}
				onAdded={refresh}
			/>
		</div>
	);
}

function AddEnvironmentDialog({
	open,
	onOpenChange,
	projectId,
	onAdded,
}: {
	open: boolean;
	onOpenChange: (v: boolean) => void;
	projectId: string;
	onAdded: () => void | Promise<void>;
}) {
	const [name, setName] = useState("");
	const [stage, setStage] = useState<EnvStage>("staging");
	const [submitting, setSubmitting] = useState(false);

	async function submit() {
		if (!name.trim()) {
			toast.error("Environment name is required");
			return;
		}
		setSubmitting(true);
		try {
			await addEnvironment(projectId, { name, stage });
			toast.success("Environment added");
			setName("");
			setStage("staging");
			onOpenChange(false);
			await onAdded();
		} catch (err) {
			toast.error(err instanceof Error ? err.message : "Failed to add");
		} finally {
			setSubmitting(false);
		}
	}

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>Add environment</DialogTitle>
				</DialogHeader>
				<div className="space-y-4">
					<div className="space-y-1.5">
						<Label className="text-xs">Name</Label>
						<Input
							value={name}
							onChange={(e) => setName(e.target.value)}
							placeholder="staging"
							className="h-9 text-sm"
						/>
						<p className="text-[11px] text-muted-foreground">
							Lowercased + slugified; feeds the infrastructure state path.
						</p>
					</div>
					<div className="space-y-1.5">
						<Label className="text-xs">Stage</Label>
						<Select value={stage} onValueChange={(v) => setStage(v as EnvStage)}>
							<SelectTrigger className="h-9 text-sm">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="development">Development</SelectItem>
								<SelectItem value="staging">Staging</SelectItem>
								<SelectItem value="production">Production</SelectItem>
							</SelectContent>
						</Select>
					</div>
				</div>
				<DialogFooter>
					<Button
						variant="outline"
						onClick={() => onOpenChange(false)}
						disabled={submitting}
					>
						Cancel
					</Button>
					<Button onClick={submit} disabled={submitting}>
						{submitting ? "Adding…" : "Add environment"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
