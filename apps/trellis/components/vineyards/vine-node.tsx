import { Badge } from "@/components/ui/badge";
import { Handle, Position } from "@xyflow/react";
import { Grape } from "lucide-react";

interface VineNodeProps {
	data: {
		config: any;
		onClick: () => void;
	};
}

const STATUS_STYLES: Record<string, string> = {
	DRAFT: "bg-muted text-muted-foreground",
	QUEUED: "bg-blue-500/10 text-blue-700 dark:text-blue-400",
	PROVISIONING: "bg-amber-500/10 text-amber-700 dark:text-amber-400",
	ACTIVE: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
	FAILED: "bg-red-500/10 text-red-700 dark:text-red-400",
	DESTROYING: "bg-orange-500/10 text-orange-700 dark:text-orange-400",
	DESTROYED: "bg-muted text-muted-foreground",
};

export function VineNode({ data }: VineNodeProps) {
	const { config, onClick } = data;
	const status = config.status || "DRAFT";

	return (
		<div
			onClick={onClick}
			className="w-64 bg-card rounded-xl border border-border/80 shadow-sm cursor-pointer transition-all hover:border-foreground/30 hover:shadow-md group"
		>
			<div className="p-4 flex flex-col gap-2.5">
				<div className="flex items-center justify-between">
					<div className="flex items-center gap-2">
						<div className="p-1.5 bg-muted rounded-md border border-border/50">
							<Grape className="w-4 h-4 text-foreground" />
						</div>
						<span className="font-semibold text-sm truncate max-w-[140px] text-foreground">
							{config.project_name || "Vine"}
						</span>
					</div>
					<Badge
						variant="secondary"
						className={`text-[10px] h-5 font-medium px-1.5 ${STATUS_STYLES[status] || ""}`}
					>
						{status}
					</Badge>
				</div>

				<div className="flex items-center gap-2 text-xs text-muted-foreground">
					<span className="font-mono">{config.region || "—"}</span>
					<span>·</span>
					<span>{config.environment_stage || "development"}</span>
				</div>
			</div>

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
