"use client";

import { Info } from "lucide-react";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";
import { Button } from "@/components/ui/button";

interface ThemedInfoPopoverProps {
	type: "vine" | "vineyard" | "harvest";
}

const infoContent = {
	vineyard: {
		title: "What is a Vineyard?",
		description:
			"A Vineyard is a dedicated workspace for your infrastructure. It serves as a logical grouping for related infrastructure vines and harvests, allowing you to manage multiple environments or projects under a single estate.",
	},
	vine: {
		title: "What is a Vine?",
		description:
			"A Vine represents the blueprint or declarative configuration of your infrastructure (VPC, EKS Cluster, RDS). Think of it as the DNA of your environment that is planted once and nurtured through configuration.",
	},
	harvest: {
		title: "What is a Harvest?",
		description:
			"A Harvest is a live deployment or provision of a Vine. When you execute an infrastructure plan, you are harvesting the vine, yielding active resources and operational clusters.",
	},
};

export function ThemedInfoPopover({ type }: ThemedInfoPopoverProps) {
	const content = infoContent[type];

	return (
		<Popover>
			<PopoverTrigger asChild>
				<Button
					variant="ghost"
					size="icon"
					className="h-6 w-6 text-muted-foreground hover:text-foreground"
				>
					<Info className="h-4 w-4" />
					<span className="sr-only">Information about {type}</span>
				</Button>
			</PopoverTrigger>
			<PopoverContent side="right" className="w-80">
				<div className="space-y-2">
					<h4 className="font-semibold text-sm tracking-tight">
						{content.title}
					</h4>
					<p className="text-xs text-muted-foreground leading-relaxed">
						{content.description}
					</p>
				</div>
			</PopoverContent>
		</Popover>
	);
}
