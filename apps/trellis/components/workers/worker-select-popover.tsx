"use client";

import { useWorkersStore } from "@/lib/stores/use-workers-store";
import { Button } from "@/components/ui/button";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";
import { Check, Circle, Loader2, Server } from "lucide-react";
import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

interface WorkerSelectPopoverProps {
	trigger: React.ReactNode;
	onConfirm: (workerId: string | null) => void;
	disabled?: boolean;
}

const STATUS_DOT: Record<string, string> = {
	ONLINE: "bg-emerald-500",
	OFFLINE: "bg-zinc-400",
	DRAINING: "bg-amber-500",
};

/** Popover that shows before Plan/Deploy — lets the user pick a worker or "Any available". */
export function WorkerSelectPopover({
	trigger,
	onConfirm,
	disabled,
}: WorkerSelectPopoverProps) {
	const { workers, isLoading, fetchWorkers } = useWorkersStore();
	const [open, setOpen] = useState(false);
	const [selected, setSelected] = useState<string | null>(null);

	useEffect(() => {
		if (open) {
			fetchWorkers();
			const defaultWorker = workers.find((w) => (w as any).is_default);
			setSelected(defaultWorker?.id ?? null);
		}
	}, [open, fetchWorkers, workers]);

	const handleConfirm = () => {
		setOpen(false);
		onConfirm(selected);
	};

	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger asChild disabled={disabled}>
				{trigger}
			</PopoverTrigger>
			<PopoverContent align="end" className="w-72 p-0">
				<div className="px-3 pt-3 pb-2 border-b border-border/40">
					<p className="text-sm font-medium">Select worker</p>
					<p className="text-xs text-muted-foreground">
						Choose which worker runs this job.
					</p>
				</div>

				{isLoading && workers.length === 0 ? (
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

						{workers.map((w) => {
							const status = (w.status as string) ?? "OFFLINE";
							const isDefault = (w as any).is_default;
							return (
								<button
									key={w.id}
									type="button"
									className={cn(
										"flex items-center gap-2 w-full px-3 py-2 text-left text-sm hover:bg-accent transition-colors",
										selected === w.id && "bg-accent/50",
									)}
									onClick={() => setSelected(w.id)}
								>
									<div className="flex items-center justify-center h-4 w-4 shrink-0">
										{selected === w.id && (
											<Check className="h-3.5 w-3.5" />
										)}
									</div>
									<Circle
										className={cn(
											"h-2 w-2 fill-current shrink-0",
											STATUS_DOT[status] ?? STATUS_DOT.OFFLINE,
										)}
									/>
									<span className="truncate flex-1">
										{w.name}
									</span>
									{isDefault && (
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

						{workers.length === 0 && (
							<p className="px-3 py-4 text-xs text-muted-foreground text-center">
								No workers registered.
							</p>
						)}
					</div>
				)}

				<div className="border-t border-border/40 px-3 py-2">
					<Button
						size="sm"
						className="w-full h-8 text-xs"
						onClick={handleConfirm}
						disabled={isLoading && workers.length === 0}
					>
						Confirm
					</Button>
				</div>
			</PopoverContent>
		</Popover>
	);
}
