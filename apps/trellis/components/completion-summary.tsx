import { Badge } from "@/components/ui/badge";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
export interface CompletionSummaryProps {
	configuration: {
		project_name: string;
		environment_stage: string;
		aws_region?: string | null;
		status?: string | null;
	};
}

export function CompletionSummary({ configuration }: CompletionSummaryProps) {
	const configSummary = {
		projectName: configuration.project_name,
		environment: configuration.environment_stage,
		awsRegion: configuration.aws_region || "N/A",
		status: configuration.status || "DRAFT",
	};

	return (
		<Card className="mb-8 border border-border shadow-sm">
			<CardHeader className="bg-muted/5 border-b border-border/40 pb-4">
				<CardTitle className="text-lg font-semibold tracking-tight">Vine Summary</CardTitle>
				<CardDescription>Review your infrastructure configuration</CardDescription>
			</CardHeader>
			<CardContent className="pt-6">
				<div className="grid md:grid-cols-3 gap-6">
					<div className="space-y-1">
						<h4 className="font-medium text-xs text-muted-foreground">Project</h4>
						<p className="text-sm text-foreground font-medium">{configSummary.projectName}</p>
					</div>
					<div className="space-y-1">
						<h4 className="font-medium text-xs text-muted-foreground">Environment</h4>
						<Badge variant="outline" className="font-normal text-xs bg-muted/30">
							{configSummary.environment}
						</Badge>
					</div>
					<div className="space-y-1">
						<h4 className="font-medium text-xs text-muted-foreground">Region</h4>
						<p className="text-sm text-foreground font-medium">{configSummary.awsRegion}</p>
					</div>
				</div>
			</CardContent>
		</Card>
	);
}
