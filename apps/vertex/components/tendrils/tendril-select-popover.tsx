"use client";

import { useTendrilsStore } from "@/lib/stores/use-tendrils-store";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/ui/status-badge";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { AlertTriangle, Check, Loader2, Server } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { cn } from "@/lib/utils";

interface TendrilSelectPopoverProps {
	trigger: React.ReactNode;
	onConfirm: (workerId: string | null, rePlan?: boolean) => void;
	disabled?: boolean;
	showRePlan?: boolean;
	variant?: "default" | "destructive";
	confirmLabel?: string;
	description?: string;
	excludeId?: string;
}

/** Popover that shows before Plan/Deploy — lets the user pick a tendril or "Any available". */
export function TendrilSelectPopover({
	trigger,
	onConfirm,
	disabled,
	showRePlan,
	variant = "default",
	confirmLabel,
	description,
	excludeId,
}: TendrilSelectPopoverProps) {
	const { tendrils: allTendrils, isLoading, fetchTendrils } = useTendrilsStore();
	const tendrils = useMemo(
		() => excludeId ? allTendrils.filter((t) => t.id !== excludeId) : allTendrils,
		[allTendrils, excludeId],
	);
	const [open, setOpen] = useState(false);
	const [selected, setSelected] = useState<string | null>(null);
	const [rePlan, setRePlan] = useState(false);

	useEffect(() => {
		if (open) {
			fetchTendrils();
			const defaultWorker = tendrils.find(
				(w) => w.is_default && w.status === "ONLINE",
			);
			setSelected(defaultWorker?.id ?? null);
		}
	}, [open, fetchTendrils, tendrils]);

	const handleConfirm = () => {
		setOpen(false);
		onConfirm(selected, rePlan);
		setRePlan(false);
	};

	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger asChild disabled={disabled}>
				{trigger}
			</PopoverTrigger>
			<PopoverContent align="end" className="w-72 p-0">
				<div className="px-3 pt-3 pb-2 border-b border-border/40">
					<p className="text-sm font-medium">Select tendril</p>
					<p className="text-xs text-muted-foreground">
						Choose which tendril runs this job.
					</p>
					{variant === "destructive" && description && (
						<div className="mt-2 flex gap-1.5 rounded-md bg-destructive/10 px-2 py-1.5 text-[11px] text-destructive">
							<AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-px" />
							<span>{description}</span>
						</div>
					)}
				</div>

				{isLoading && tendrils.length === 0 ? (
					<div className="flex items-center justify-center py-6">
						<Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
					</div>
				) : (
					<div className="max-h-52 overflow-y-auto py-1">
						<button
							type="button"
							className={cn(
								"flex items-center gap-2 w-full px-3 py-2 text-left text-sm hover:bg-accent transition-colors",
								selected === null && "bg-accent/50",
							)}
							onClick={() => setSelected(null)}
						>
							<div className="flex items-center justify-center h-4 w-4 shrink-0">
								{selected === null && (
									<Check className="h-3.5 w-3.5" />
								)}
							</div>
							<Server className="h-3.5 w-3.5 text-muted-foreground" />
							<span>Any available</span>
						</button>

						{tendrils.map((w) => {
							const status = w.status ?? "OFFLINE";
							const isOnline = status === "ONLINE";
							return (
								<button
									key={w.id}
									type="button"
									disabled={!isOnline}
									className={cn(
										"flex items-center gap-2 w-full px-3 py-2 text-left text-sm transition-colors",
										isOnline
											? "hover:bg-accent"
											: "opacity-50 cursor-not-allowed",
										selected === w.id && "bg-accent/50",
									)}
									onClick={() => isOnline && setSelected(w.id)}
								>
									<div className="flex items-center justify-center h-4 w-4 shrink-0">
										{selected === w.id && (
											<Check className="h-3.5 w-3.5" />
										)}
									</div>
									<TooltipProvider delayDuration={300}>
										<Tooltip>
											<TooltipTrigger asChild>
												<StatusBadge status={status} showLabel={false} className="shrink-0" />
											</TooltipTrigger>
											<TooltipContent side="top" className="text-xs">
												{status}
											</TooltipContent>
										</Tooltip>
									</TooltipProvider>
									<span className="truncate flex-1">
										{w.name}
									</span>
									{w.is_default && (
										<span className="text-[10px] text-muted-foreground font-medium uppercase tracking-wide">
											Default
										</span>
									)}
									<span className="text-[10px] text-muted-foreground">
										{w.mode === "self-hosted" ? "self" : "cloud"}
									</span>
								</button>
							);
						})}

						{tendrils.length === 0 && (
							<p className="px-3 py-4 text-xs text-muted-foreground text-center">
								No tendrils registered.
							</p>
						)}
					</div>
				)}

				<div className="border-t border-border/40 px-3 py-2 space-y-2">
					{showRePlan && (
						<label className="flex items-center gap-2 cursor-pointer">
							<input
								type="checkbox"
								checked={rePlan}
								onChange={(e) => setRePlan(e.target.checked)}
								className="h-3.5 w-3.5 rounded border-border accent-primary"
							/>
							<span className="text-xs text-muted-foreground">Re-plan before applying</span>
						</label>
					)}
					<Button
						size="sm"
						variant={variant === "destructive" ? "destructive" : "default"}
						className="w-full h-8 text-xs"
						onClick={handleConfirm}
						disabled={isLoading && tendrils.length === 0}
					>
						{confirmLabel ?? "Confirm"}
					</Button>
				</div>
			</PopoverContent>
		</Popover>
	);
}
