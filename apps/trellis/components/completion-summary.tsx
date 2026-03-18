import { Badge } from "@/components/ui/badge";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { PublicConfigurationsRow } from "@/lib/validations/db.schemas";
import {
	Cloud,
	Database,
	GitBranch,
	Settings,
	Shield,
	Zap,
} from "lucide-react";

export interface CompletionSummaryProps {
	configuration: PublicConfigurationsRow;
}

export function CompletionSummary({ configuration }: CompletionSummaryProps) {
	const configSummary = {
		projectName: configuration.project_name,
		environment: configuration.environment_stage,
		awsRegion: configuration.aws_region || "N/A",
		containerPlatform: configuration.container_platform,
		features: [
			{
				name: "VPC Creation",
				enabled: !!configuration.create_vpc,
				icon: <Cloud className="w-4 h-4" />,
			},
			{
				name: "GitOps Integration",
				enabled: !!configuration.enable_gitops_destination,
				icon: <GitBranch className="w-4 h-4" />,
			},
			{
				name: "Database Auto-scaling",
				enabled: !!configuration.create_rds,
				icon: <Database className="w-4 h-4" />,
			},
			{
				name: "CloudFront WAF",
				enabled: !!configuration.enable_cloudfront_waf,
				icon: <Shield className="w-4 h-4" />,
			},
			{
				name: "Elastic Redis",
				enabled: !!configuration.enable_redis,
				icon: <Settings className="w-4 h-4" />,
			},
			{
				name: "Karpenter Auto-scaling",
				enabled: !!configuration.enable_karpenter,
				icon: <Zap className="w-4 h-4" />,
			},
		],
	};

	return (
	  <Card className="mb-8 border border-border shadow-sm">
	    <CardHeader className="bg-muted/5 border-b border-border/40 pb-4">
	      <CardTitle className="text-lg font-semibold tracking-tight">Configuration Summary</CardTitle>
	      <CardDescription>Review your platform configuration details</CardDescription>
	    </CardHeader>
	    <CardContent className="pt-6">
	      <div className="grid md:grid-cols-2 gap-6 mb-6">
	        <div className="space-y-4">
	          <div>
	            <h4 className="font-medium text-xs text-muted-foreground mb-1">Project Name</h4>
	            <p className="text-sm text-foreground font-medium">{configSummary.projectName}</p>
	          </div>
	          <div>
	            <h4 className="font-medium text-xs text-muted-foreground mb-1">Environment</h4>
	            <Badge variant="outline" className="font-normal text-xs bg-muted/30">
	              {configSummary.environment}
	            </Badge>
	          </div>
	        </div>
	        <div className="space-y-4">
	          <div>
	            <h4 className="font-medium text-xs text-muted-foreground mb-1">AWS Region</h4>
	            <p className="text-sm text-foreground font-medium">{configSummary.awsRegion}</p>
	          </div>
	          <div>
	            <h4 className="font-medium text-xs text-muted-foreground mb-1">Container Platform</h4>
	            <Badge variant="outline" className="font-normal text-xs bg-muted/30">
	              {configSummary.containerPlatform}
	            </Badge>
	          </div>
	        </div>
	      </div>

	      <div className="pt-4 border-t border-border/40">
	        <h4 className="font-medium text-xs text-muted-foreground mb-3">Features & Services</h4>
	        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
	          {configSummary.features.map((feature, index) => (
	            <div
	              key={index}
	              className={`flex items-center gap-2.5 p-3 rounded-md border text-sm transition-colors ${
	                feature.enabled
	                  ? "bg-background border-border text-foreground"
	                  : "bg-muted/30 border-border/40 text-muted-foreground opacity-60"
	              }`}
	            >
	              <div className={feature.enabled ? "text-foreground" : "text-muted-foreground"}>
	                {feature.icon}
	              </div>
	              <span className="font-medium text-xs">{feature.name}</span>
	            </div>
	          ))}
	        </div>
	      </div>
	    </CardContent>
	  </Card>
	);
}
