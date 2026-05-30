"use client";

import { provisionVine } from "@/app/server/actions/vines";
import { LogViewer } from "@/components/clusters/log-viewer";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetHeader,
	SheetTitle,
} from "@/components/ui/sheet";
import type { PublicVinesRow } from "@/lib/validations/db.schemas";
import { Loader2, Rocket } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";

interface VineSheetWrapperProps {
	vines: PublicVinesRow[];
}

export function VineSheetWrapper({ vines }: VineSheetWrapperProps) {
	const searchParams = useSearchParams();
	const pathname = usePathname();
	const router = useRouter();

	const [isProvisioning, setIsProvisioning] = useState(false);
	const [activeJobId, setActiveJobId] = useState<string | null>(null);
	const [logViewerOpen, setLogViewerOpen] = useState(false);

	const vineId = searchParams.get("config_id") || searchParams.get("vine_id");
	const open = !!vineId;
	const vine = vines.find((v) => v.id === vineId);

	const handleOpenChange = (newOpen: boolean) => {
		if (!newOpen) {
			const params = new URLSearchParams(searchParams.toString());
			params.delete("config_id");
			params.delete("vine_id");
			router.replace(`${pathname}?${params.toString()}`, { scroll: false });
			setActiveJobId(null);
			setIsProvisioning(false);
		}
	};

	const handleProvision = async () => {
		if (!vine) return;
		setIsProvisioning(true);
		try {
			const { jobId } = await provisionVine(vine.id);
			setActiveJobId(jobId);
			setLogViewerOpen(true);
			toast.success("Provisioning job queued!");
		} catch (err) {
			toast.error(
				err instanceof Error
					? err.message
					: "Failed to queue provisioning job",
			);
		} finally {
			setIsProvisioning(false);
		}
	};

	return (
		<>
			<Sheet open={open} onOpenChange={handleOpenChange}>
				<SheetContent className="w-[95vw] sm:max-w-2xl overflow-hidden p-0 flex flex-col">
					<SheetHeader className="px-6 py-5 border-b border-border/40">
						<div className="flex items-center justify-between">
							<SheetTitle className="text-base">
								{vine?.project_name ?? "Vine Details"}
							</SheetTitle>
							{vine && (
								<Button
									onClick={handleProvision}
									disabled={isProvisioning}
									size="sm"
									className="h-8 text-xs"
								>
									{isProvisioning ? (
										<Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
									) : (
										<Rocket className="mr-1.5 h-3.5 w-3.5" />
									)}
									{isProvisioning ? "Queuing..." : "Provision"}
								</Button>
							)}
						</div>
						<SheetDescription className="text-xs">
							Review your vine configuration and provision infrastructure.
						</SheetDescription>
					</SheetHeader>
					<ScrollArea className="flex-1 px-6 py-5">
						{vine ? (
							<div className="space-y-4">
								<div className="grid grid-cols-3 gap-4">
									<div>
										<p className="text-[11px] text-muted-foreground">Environment</p>
										<Badge variant="outline" className="text-xs mt-1">
											{vine.environment_stage}
										</Badge>
									</div>
									<div>
										<p className="text-[11px] text-muted-foreground">Region</p>
										<p className="text-xs font-mono mt-1">{vine.aws_region}</p>
									</div>
									<div>
										<p className="text-[11px] text-muted-foreground">Status</p>
										<Badge variant="outline" className="text-xs mt-1">
											{vine.status}
										</Badge>
									</div>
								</div>
							</div>
						) : (
							<p className="text-sm text-muted-foreground text-center py-10">
								Vine not found.
							</p>
						)}
					</ScrollArea>
				</SheetContent>
			</Sheet>

			<LogViewer
				jobId={activeJobId}
				clusterName={vine?.project_name || "Provisioning"}
				open={logViewerOpen}
				onOpenChange={setLogViewerOpen}
			/>
		</>
	);
}
