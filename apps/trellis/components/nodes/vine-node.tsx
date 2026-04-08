import { Badge } from "@/components/ui/badge";
import { Handle, Position } from "@xyflow/react";
import { Cloud, Database, Settings, Shield, Zap } from "lucide-react";

interface VineNodeProps {
	data: {
		config: any;
		onClick: () => void;
	};
}

export function VineNode({ data }: VineNodeProps) {
	const { config, onClick } = data;

	return (
		<div
			onClick={onClick}
			className="w-72 bg-card rounded-xl border border-border/80 shadow-sm cursor-pointer transition-all hover:border-foreground/30 hover:shadow-md group"
		>
			<div className="p-4 flex flex-col gap-3">
				<div className="flex items-center justify-between">
					<div className="flex items-center gap-2">
						<div className="p-1.5 bg-muted rounded-md border border-border/50">
							<Settings className="w-4 h-4 text-foreground" />
						</div>
						<div className="font-semibold text-sm truncate max-w-30 text-foreground">
							{config.project_name || "Vine"}
						</div>
					</div>
					<Badge
						variant="secondary"
						className="text-[10px] h-5 font-medium px-1.5 bg-muted"
					>
						{config.environment_stage || "Dev"}
					</Badge>
				</div>

				<div className="text-xs text-muted-foreground line-clamp-2 min-h-8">
					{config.description ||
						`Configuration tailored for ${config.container_platform}`}
				</div>

				<div className="flex items-center gap-1.5 mt-1 pt-3 border-t border-border/40">
					<Badge
						variant="outline"
						className="text-[9px] font-mono text-muted-foreground"
					>
						{config.container_platform}
					</Badge>
					<div className="flex items-center gap-1 ml-auto text-muted-foreground">
						{config.create_vpc && <Cloud className="w-3.5 h-3.5" />}
						{config.create_rds && (
							<Database className="w-3.5 h-3.5" />
						)}
						{config.enable_cloudfront_waf && (
							<Shield className="w-3.5 h-3.5" />
						)}
						{config.enable_karpenter && (
							<Zap className="w-3.5 h-3.5" />
						)}
					</div>
				</div>
			</div>

			{/* Connection points for future Harvest nodes */}
			<Handle
				type="source"
				position={Position.Bottom}
				className="w-3 h-3 border-2 border-background bg-foreground rounded-full"
			/>
			<Handle
				type="target"
				position={Position.Top}
				className="w-3 h-3 border-2 border-background bg-muted-foreground rounded-full opacity-0 group-hover:opacity-100 transition-opacity"
			/>
		</div>
	);
}
