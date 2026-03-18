"use client";
import { ConfigurationForm } from "@/components/configuration-form";
import { Badge } from "@/components/ui/badge";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { Settings } from "lucide-react";

export default function ConfigurePage() {
	return (
		<div className="w-full space-y-8 overflow-y-hidden">
			<div className="space-y-4">
				<div className="flex items-center gap-3">
					<div className="p-2 border border-border bg-muted/30 rounded-lg">
						<Settings className="w-5 h-5 text-foreground" />
					</div>
					<div>
						<h1 className="text-2xl sm:text-3xl font-semibold tracking-tight text-foreground">
							Platform Configuration
						</h1>
						<p className="text-muted-foreground text-sm">
							Configure your AWS and Kubernetes environment
						</p>
					</div>
				</div>
				<Badge
					variant="secondary"
					className="bg-muted text-muted-foreground border-transparent font-medium"
				>
					Step 1 of 2: Environment Setup
				</Badge>
			</div>

			<Card className="shadow-sm border border-border">
				<CardHeader className="bg-muted/5 border-b border-border/40 pb-5">
					<CardTitle className="text-xl font-semibold">
						Environment Configuration
					</CardTitle>
					<CardDescription>
						Set up your development platform with AWS
						infrastructure, Kubernetes clusters, and deployment
						pipelines.
					</CardDescription>
				</CardHeader>
				<CardContent className="pt-8">
					<ConfigurationForm />
				</CardContent>
			</Card>
		</div>
	);
}
