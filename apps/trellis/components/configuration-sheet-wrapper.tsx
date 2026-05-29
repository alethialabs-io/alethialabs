"use client";

import { provisionVine } from "@/app/server/actions/vines";
import { CompletionSummary } from "@/components/completion-summary";
import { LogViewer } from "@/components/clusters/log-viewer";
import { DownloadOptions } from "@/components/download-options";
import { InstallationPreview } from "@/components/installation-preview";
import { ThemedInfoPopover } from "@/components/themed-info-popover";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetHeader,
	SheetTitle,
} from "@/components/ui/sheet";
import { PublicConfigurationsRow } from "@/lib/validations/db.schemas";
import { Loader2, Rocket } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";

interface ConfigurationSheetWrapperProps {
	configurations: PublicConfigurationsRow[];
	awsConnected: boolean;
}

export function ConfigurationSheetWrapper({
	configurations,
	awsConnected,
}: ConfigurationSheetWrapperProps) {
	const searchParams = useSearchParams();
	const pathname = usePathname();
	const router = useRouter();

	const [isProvisioning, setIsProvisioning] = useState(false);
	const [activeJobId, setActiveJobId] = useState<string | null>(null);
	const [logViewerOpen, setLogViewerOpen] = useState(false);

	const configId = searchParams.get("config_id");
	const open = !!configId;

	const configuration = configurations.find((c) => c.id === configId);

	const handleOpenChange = (newOpen: boolean) => {
		if (!newOpen) {
			const newSearchParams = new URLSearchParams(
				searchParams.toString(),
			);
			newSearchParams.delete("config_id");
			router.replace(`${pathname}?${newSearchParams.toString()}`, {
				scroll: false,
			});
			setActiveJobId(null);
			setIsProvisioning(false);
		}
	};

	const handleProvision = async () => {
		if (!configuration) return;
		setIsProvisioning(true);
		try {
			const { jobId } = await provisionVine(configuration.id);
			setActiveJobId(jobId);
			setLogViewerOpen(true);
			toast.success("Provisioning job queued!");
		} catch (error: any) {
			toast.error(error.message || "Failed to queue provisioning job");
		} finally {
			setIsProvisioning(false);
		}
	};

	return (
		<>
			<Sheet open={open} onOpenChange={handleOpenChange}>
				<SheetContent className="w-[95vw] sm:max-w-6xl overflow-hidden p-0 flex flex-col">
					<SheetHeader className="px-6 py-6 border-b border-border/40 bg-muted/5">
						<div className="flex items-center justify-between">
							<div className="flex items-center gap-2">
								<SheetTitle className="font-serif text-2xl">
									Vine Details
								</SheetTitle>
								<ThemedInfoPopover type="vine" />
							</div>
							{configuration && (
								<Button
									onClick={handleProvision}
									disabled={isProvisioning || !awsConnected}
									size="sm"
									className="h-9 text-xs font-medium"
									title={
										!awsConnected
											? "Connect your AWS account in Integrations first"
											: undefined
									}
								>
									{isProvisioning ? (
										<Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
									) : (
										<Rocket className="mr-2 h-3.5 w-3.5" />
									)}
									{isProvisioning ? "Queuing..." : "Provision"}
								</Button>
							)}
						</div>
						<SheetDescription>
							Review your vine setup, download harvest files, and
							provision infrastructure.
						</SheetDescription>
					</SheetHeader>
					<ScrollArea className="h-[90vh] flex-1 px-6">
						{configuration ? (
							<div className="space-y-8 pb-2">
								<CompletionSummary
									configuration={configuration}
								/>
								<DownloadOptions
									configurationData={configuration}
								/>
								<InstallationPreview />
							</div>
						) : (
							<div className="text-sm text-muted-foreground text-center py-10">
								Vine not found.
							</div>
						)}
					</ScrollArea>
				</SheetContent>
			</Sheet>

			<LogViewer
				jobId={activeJobId}
				clusterName={configuration?.project_name || "Provisioning"}
				open={logViewerOpen}
				onOpenChange={setLogViewerOpen}
			/>
		</>
	);
}
