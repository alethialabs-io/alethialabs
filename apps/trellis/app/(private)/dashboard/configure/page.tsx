"use client";

import { NewConfigurationForm } from "@/components/configuration/configuration-form";
import { ThemedInfoPopover } from "@/components/themed-info-popover";

export default function ConfigurePage() {
	return (
		<div className="w-full space-y-8">
			<div className="space-y-1.5">
				<div className="flex items-center gap-2">
					<h1 className="text-2xl sm:text-3xl font-semibold tracking-tight text-foreground">
						Plant a Vine
					</h1>
					<ThemedInfoPopover type="vine" />
				</div>
				<p className="text-muted-foreground text-sm">
					Configure your AWS and Kubernetes infrastructure.
				</p>
			</div>

			<NewConfigurationForm />
		</div>
	);
}
