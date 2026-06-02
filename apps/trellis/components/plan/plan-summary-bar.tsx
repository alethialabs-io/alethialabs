"use client";

import { Badge } from "@/components/ui/badge";
import type { PlanSummary } from "@/lib/plan/parse-plan";
import type { CostSummary } from "@/lib/plan/parse-cost";
import { Plus, Pencil, Trash2, RefreshCw } from "lucide-react";

interface PlanSummaryBarProps {
	plan: PlanSummary;
	cost: CostSummary | null;
}

export function PlanSummaryBar({ plan, cost }: PlanSummaryBarProps) {
	const { counts } = plan;

	return (
		<div className="flex items-center justify-between rounded-lg border bg-muted/30 px-4 py-3">
			<div className="flex items-center gap-3">
				{counts.create > 0 && (
					<Badge
						variant="outline"
						className="border-emerald-500/50 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 gap-1"
					>
						<Plus className="h-3 w-3" />
						{counts.create} to create
					</Badge>
				)}
				{counts.update > 0 && (
					<Badge
						variant="outline"
						className="border-amber-500/50 bg-amber-500/10 text-amber-700 dark:text-amber-400 gap-1"
					>
						<Pencil className="h-3 w-3" />
						{counts.update} to update
					</Badge>
				)}
				{counts.delete > 0 && (
					<Badge
						variant="outline"
						className="border-red-500/50 bg-red-500/10 text-red-700 dark:text-red-400 gap-1"
					>
						<Trash2 className="h-3 w-3" />
						{counts.delete} to destroy
					</Badge>
				)}
				{counts.replace > 0 && (
					<Badge
						variant="outline"
						className="border-orange-500/50 bg-orange-500/10 text-orange-700 dark:text-orange-400 gap-1"
					>
						<RefreshCw className="h-3 w-3" />
						{counts.replace} to replace
					</Badge>
				)}
			</div>
			{cost && cost.totalMonthlyCost !== null && (
				<div className="text-sm font-medium text-muted-foreground">
					Est.{" "}
					<span className="text-foreground font-semibold">
						${cost.totalMonthlyCost.toFixed(2)}
					</span>
					/mo
				</div>
			)}
		</div>
	);
}
