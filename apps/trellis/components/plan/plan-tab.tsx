"use client";

import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { PlanSummaryBar } from "./plan-summary-bar";
import { ResourceCard } from "./resource-card";
import { groupByCategory } from "@/lib/plan/parse-plan";
import type { UsePlanReturn } from "./use-plan";
import {
	AlertCircle,
	ChevronDown,
	Loader2,
	RefreshCw,
	Rocket,
} from "lucide-react";

interface PlanTabProps {
	plan: UsePlanReturn;
	onApplied: (deployJobId: string) => void;
}

function GeneratingState({ logs }: { logs: UsePlanReturn["logs"] }) {
	return (
		<div className="space-y-4">
			<div className="flex items-center gap-2 text-sm text-muted-foreground">
				<Loader2 className="h-4 w-4 animate-spin" />
				Generating infrastructure plan...
			</div>

			{logs.length > 0 && (
				<div className="rounded-md border bg-muted/20 font-mono text-xs max-h-[300px] overflow-y-auto p-3">
					{logs.map((log, i) => (
						<div
							key={log.id || i}
							className="flex gap-3 px-2 py-0.5 hover:bg-muted/40 rounded transition-colors"
						>
							<span className="text-muted-foreground/40 select-none shrink-0 w-6 text-right">
								{i + 1}
							</span>
							<span className="text-muted-foreground/60 select-none shrink-0 w-[75px]">
								{new Date(log.created_at || Date.now()).toLocaleTimeString([], { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" })}
							</span>
							<span className={log.stream_type === "STDERR" ? "text-destructive break-all leading-relaxed" : "text-foreground/80 break-all leading-relaxed"}>
								{log.log_chunk}
							</span>
						</div>
					))}
				</div>
			)}

			{logs.length === 0 && (
				<div className="space-y-2">
					<Skeleton className="h-10 w-full" />
					<Skeleton className="h-8 w-3/4" />
					<Skeleton className="h-8 w-1/2" />
					<Skeleton className="h-8 w-2/3" />
				</div>
			)}
		</div>
	);
}

function CategoryGroup({
	category,
	resources,
	costMap,
}: {
	category: string;
	resources: ReturnType<typeof groupByCategory> extends Map<
		string,
		infer V
	>
		? V
		: never;
	costMap: Map<string, number>;
}) {
	return (
		<Collapsible defaultOpen>
			<CollapsibleTrigger className="flex w-full items-center justify-between rounded-md px-2 py-1.5 text-sm font-medium hover:bg-accent/50 transition-colors">
				<span>
					{category}{" "}
					<span className="text-muted-foreground font-normal">
						({resources.length})
					</span>
				</span>
				<ChevronDown className="h-4 w-4 text-muted-foreground transition-transform [[data-state=closed]_&]:rotate-[-90deg]" />
			</CollapsibleTrigger>
			<CollapsibleContent>
				<div className="space-y-1 pl-1 pt-1">
					{resources.map((resource) => (
						<ResourceCard
							key={resource.address}
							resource={resource}
							cost={costMap.get(resource.address)}
						/>
					))}
				</div>
			</CollapsibleContent>
		</Collapsible>
	);
}

export function PlanTab({ plan, onApplied }: PlanTabProps) {
	const {
		phase,
		planResult,
		costResult,
		logs,
		error,
		generatePlan,
		applyPlan,
	} = plan;

	const handleApply = async () => {
		await applyPlan();
		if (plan.deployJobId) {
			onApplied(plan.deployJobId);
		}
	};

	if (phase === "idle") {
		return (
			<p className="text-sm text-muted-foreground py-4">
				No plan generated yet. Use the Plan button above to preview infrastructure changes and costs.
			</p>
		);
	}

	if (phase === "generating") {
		return <GeneratingState logs={logs} />;
	}

	if (phase === "failed") {
		return (
			<div className="space-y-4">
				<Alert variant="destructive">
					<AlertCircle className="h-4 w-4" />
					<AlertDescription>{error}</AlertDescription>
				</Alert>
				{logs.length > 0 && (
					<div className="rounded-md border bg-muted/20 font-mono text-xs max-h-[200px] overflow-y-auto p-3">
						{logs.map((log, i) => (
							<div
								key={log.id || i}
								className="flex gap-3 px-2 py-0.5 hover:bg-muted/40 rounded transition-colors"
							>
								<span className="text-muted-foreground/40 select-none shrink-0 w-6 text-right">
									{i + 1}
								</span>
								<span className={log.stream_type === "STDERR" ? "text-destructive break-all" : "text-foreground/80 break-all"}>
									{log.log_chunk}
								</span>
							</div>
						))}
					</div>
				)}
				<Button
					onClick={generatePlan}
					variant="outline"
					size="sm"
					className="gap-1.5"
				>
					<RefreshCw className="h-3.5 w-3.5" />
					Retry Plan
				</Button>
			</div>
		);
	}

	if (phase === "applying") {
		return (
			<div className="flex flex-col items-center justify-center py-16 gap-3">
				<Loader2 className="h-6 w-6 animate-spin" />
				<p className="text-sm text-muted-foreground">
					Queuing deployment...
				</p>
			</div>
		);
	}

	if (phase === "applied") {
		const appliedGroups = planResult ? groupByCategory(planResult.resources) : new Map();
		const appliedCostMap = new Map<string, number>();
		if (costResult) {
			for (const cr of costResult.resources) {
				if (cr.monthlyCost !== null) {
					appliedCostMap.set(cr.name, cr.monthlyCost);
				}
			}
		}

		return (
			<div className="space-y-4">
				<Alert>
					<Rocket className="h-4 w-4" />
					<AlertDescription>
						Plan applied. Deployment job has been queued.
					</AlertDescription>
				</Alert>

				{planResult && (
					<>
						<PlanSummaryBar plan={planResult} cost={costResult} />

						{planResult.resources.length > 0 && (
							<div className="space-y-3">
								{Array.from(appliedGroups.entries()).map(
									([category, resources]) => (
										<CategoryGroup
											key={category}
											category={category}
											resources={resources}
											costMap={appliedCostMap}
										/>
									),
								)}
							</div>
						)}

						{costResult && costResult.resources.length > 0 && (
							<>
								<Separator />
								<div className="space-y-2">
									<h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
										Cost Breakdown
									</h4>
									<div className="rounded-md border">
										<div className="divide-y">
											{costResult.resources.map((cr) => (
												<div
													key={cr.name}
													className="flex items-center justify-between px-3 py-2 text-xs"
												>
													<span className="font-mono text-muted-foreground truncate max-w-[70%]">
														{cr.name}
													</span>
													<span className="font-medium">
														${cr.monthlyCost?.toFixed(2) ?? "—"}/mo
													</span>
												</div>
											))}
										</div>
										{costResult.totalMonthlyCost !== null && (
											<div className="flex items-center justify-between border-t bg-muted/30 px-3 py-2 text-sm font-medium">
												<span>Total</span>
												<span>${costResult.totalMonthlyCost.toFixed(2)}/mo</span>
											</div>
										)}
									</div>
								</div>
							</>
						)}
					</>
				)}
			</div>
		);
	}

	// phase === "ready"
	if (!planResult) return null;

	const groups = groupByCategory(planResult.resources);
	const costMap = new Map<string, number>();
	if (costResult) {
		for (const cr of costResult.resources) {
			if (cr.monthlyCost !== null) {
				costMap.set(cr.name, cr.monthlyCost);
			}
		}
	}

	const totalResources = planResult.resources.length;

	return (
		<div className="space-y-4">
			<PlanSummaryBar plan={planResult} cost={costResult} />

			{totalResources === 0 ? (
				<div className="text-center py-8">
					<p className="text-sm text-muted-foreground">
						No infrastructure changes detected.
					</p>
				</div>
			) : (
				<div className="space-y-3">
					{Array.from(groups.entries()).map(
						([category, resources]) => (
							<CategoryGroup
								key={category}
								category={category}
								resources={resources}
								costMap={costMap}
							/>
						),
					)}
				</div>
			)}

			{costResult && costResult.resources.length > 0 && (
				<>
					<Separator />
					<div className="space-y-2">
						<h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
							Cost Breakdown
						</h4>
						<div className="rounded-md border">
							<div className="divide-y">
								{costResult.resources.map((cr) => (
									<div
										key={cr.name}
										className="flex items-center justify-between px-3 py-2 text-xs"
									>
										<span className="font-mono text-muted-foreground truncate max-w-[70%]">
											{cr.name}
										</span>
										<span className="font-medium">
											$
											{cr.monthlyCost?.toFixed(2) ??
												"—"}
											/mo
										</span>
									</div>
								))}
							</div>
							{costResult.totalMonthlyCost !== null && (
								<div className="flex items-center justify-between border-t bg-muted/30 px-3 py-2 text-sm font-medium">
									<span>Total</span>
									<span>
										$
										{costResult.totalMonthlyCost.toFixed(2)}
										/mo
									</span>
								</div>
							)}
						</div>
					</div>
				</>
			)}

			<Separator />

			<div className="flex items-center justify-between">
				<Button
					onClick={generatePlan}
					variant="outline"
					size="sm"
					className="gap-1.5"
				>
					<RefreshCw className="h-3.5 w-3.5" />
					Regenerate
				</Button>
				<Button onClick={handleApply} size="sm" className="gap-1.5">
					<Rocket className="h-3.5 w-3.5" />
					Apply Infrastructure
				</Button>
			</div>
		</div>
	);
}
