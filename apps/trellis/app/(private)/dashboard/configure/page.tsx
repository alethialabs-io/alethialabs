"use client";
import { ConfigurationForm } from "@/components/configuration-form";
import { ThemedInfoPopover } from "@/components/themed-info-popover";
import { Badge } from "@/components/ui/badge";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";

export default function ConfigurePage() {
	return (
		<div className="w-full space-y-8">
			<div className="space-y-4">
				<div className="flex items-center gap-3">
					<div>
						<div className="flex items-center gap-2">
							<h1 className="text-2xl sm:text-3xl font-semibold tracking-tight text-foreground">
								Plant a Vine
							</h1>
							<ThemedInfoPopover type="vine" />
						</div>
						<p className="text-muted-foreground text-sm">
							Plant and nurture your AWS and Kubernetes
							environment
						</p>
					</div>
				</div>
				<Badge
					variant="secondary"
					className="bg-muted text-muted-foreground border-transparent font-medium"
				>
					Step 1 of 2: Vine Preparation
				</Badge>
			</div>

			<Card className="shadow-sm border border-border">
				<CardHeader className="bg-muted/5 border-b border-border/40 pb-5">
					<CardTitle className="text-xl font-semibold">
						Vine Configuration
					</CardTitle>
					<CardDescription>
						Configure your infrastructure vine with AWS resources,
						Kubernetes settings, and harvest pipelines.
					</CardDescription>
				</CardHeader>
				<CardContent className="pt-8">
					<ConfigurationForm />
				</CardContent>
			</Card>
		</div>
	);
}
