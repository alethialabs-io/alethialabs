"use client";

import { CompletionSummary } from "@/components/completion-summary";
import { DownloadOptions } from "@/components/download-options";
import { InstallationPreview } from "@/components/installation-preview";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetHeader,
	SheetTitle,
} from "@/components/ui/sheet";
import { PublicConfigurationsRow } from "@/lib/validations/db.schemas";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

import { ThemedInfoPopover } from "@/components/themed-info-popover";

interface ConfigurationSheetWrapperProps {
	configurations: PublicConfigurationsRow[];
}

export function ConfigurationSheetWrapper({
	configurations,
}: ConfigurationSheetWrapperProps) {
	const searchParams = useSearchParams();
	const pathname = usePathname();
	const router = useRouter();

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
		}
	};

	return (
		<Sheet open={open} onOpenChange={handleOpenChange}>
			<SheetContent className="w-[95vw] sm:max-w-6xl overflow-hidden p-0 flex flex-col">
				<SheetHeader className="px-6 py-6 border-b border-border/40 bg-muted/5">
					<div className="flex items-center gap-2">
						<SheetTitle className="font-serif text-2xl">
							Vine Details
						</SheetTitle>
						<ThemedInfoPopover type="vine" />
					</div>
					<SheetDescription>
						Review your vine setup, download harvest files, and follow
						the installation guide.
					</SheetDescription>
				</SheetHeader>
				<ScrollArea className="h-[90vh] lex-1 px-6 ">
					{configuration ? (
						<div className="space-y-8 pb-2">
							<CompletionSummary configuration={configuration} />
							<DownloadOptions
								configurationData={configuration}
							/>
							<InstallationPreview />
						</div>
					) : (
						<div className="text-sm text-muted-foreground text-center py-10">
							Configuration not found.
						</div>
					)}
				</ScrollArea>
			</SheetContent>
		</Sheet>
	);
}
