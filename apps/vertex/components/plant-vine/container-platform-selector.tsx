"use client";

import { Badge } from "@/components/ui/badge";
import { CheckCircle2, Cpu, Settings, Zap } from "lucide-react";

interface ContainerPlatformSelectorProps {
	selected: string;
	onSelect: (platform: string) => void;
}

const platforms = [
	{
		id: "standard",
		title: "Standard",
		description: "General purpose workloads with balanced compute and memory.",
		icon: Cpu,
		features: ["General workloads", "Balanced resources", "Cost optimized"],
	},
	{
		id: "ai-workloads",
		title: "AI Workloads",
		description: "Optimized for machine learning and AI applications.",
		icon: Zap,
		features: ["GPU support", "ML frameworks", "High memory"],
		recommended: true,
	},
	{
		id: "custom",
		title: "Custom",
		description: "Fully customizable. You choose all template repositories.",
		icon: Settings,
		features: ["Full control", "Custom templates", "Expert mode"],
	},
];

export function ContainerPlatformSelector({
	selected,
	onSelect,
}: ContainerPlatformSelectorProps) {
	return (
		<div className="grid md:grid-cols-3 gap-3">
			{platforms.map((platform) => {
				const isSelected = selected === platform.id;
				const Icon = platform.icon;

				return (
					<button
						key={platform.id}
						type="button"
						onClick={() => onSelect(platform.id)}
						className={`relative p-4 rounded-lg border text-left transition-all ${
							isSelected
								? "border-foreground bg-muted/30"
								: "border-border/50 hover:border-border hover:bg-muted/10"
						}`}
					>
						{platform.recommended && (
							<Badge
								variant="secondary"
								className="absolute top-2 right-2 text-[10px]"
							>
								Recommended
							</Badge>
						)}

						<div className="flex items-center gap-2.5 mb-2">
							<div className={`p-1.5 rounded-md border ${isSelected ? "bg-foreground text-background border-foreground" : "bg-muted border-border/50 text-muted-foreground"}`}>
								<Icon className="w-3.5 h-3.5" />
							</div>
							<span className="text-sm font-medium text-foreground">
								{platform.title}
							</span>
						</div>

						<p className="text-[11px] text-muted-foreground mb-3 leading-relaxed">
							{platform.description}
						</p>

						<ul className="space-y-1">
							{platform.features.map((feature) => (
								<li
									key={feature}
									className="flex items-center gap-1.5 text-[11px] text-muted-foreground"
								>
									<CheckCircle2 className={`w-3 h-3 shrink-0 ${isSelected ? "text-foreground" : "text-muted-foreground/40"}`} />
									{feature}
								</li>
							))}
						</ul>
					</button>
				);
			})}
		</div>
	);
}
