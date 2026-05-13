import { getConfigurations } from "@/app/server/actions/configurations";
import { ConfigurationSheetWrapper } from "@/components/configuration-sheet-wrapper";
import { ThemedInfoPopover } from "@/components/themed-info-popover";
import { VinesTableClient } from "@/components/vines/table-client";

export default async function VinesPage() {
	const { configurations } = await getConfigurations();

	return (
		<div className="space-y-8 w-full">
			<div className="space-y-1.5">
				<div className="flex items-center gap-2">
					<h1 className="text-2xl sm:text-3xl font-semibold tracking-tight text-foreground">
						Vines
					</h1>
					<ThemedInfoPopover type="vine" />
				</div>
				<p className="text-muted-foreground text-sm">
					View, manage, and harvest your infrastructure vines.
				</p>
			</div>

			<VinesTableClient configurations={configurations || []} />

			<ConfigurationSheetWrapper configurations={configurations || []} />
		</div>
	);
}
