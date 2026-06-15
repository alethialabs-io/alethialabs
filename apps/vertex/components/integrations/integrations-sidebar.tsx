"use client";
// SPDX-FileCopyrightText: 2026 Alethia OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only


import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import type { Database } from "@/types/database.types";
import { Activity, Blocks, Cloud, Container, GitBranch, Globe, KeyRound } from "lucide-react";

type IntegrationCategory = Database["public"]["Enums"]["integration_category"];
export type CategoryFilter = "all" | IntegrationCategory;

interface IntegrationsSidebarProps {
	selected: CategoryFilter;
	onSelect: (category: CategoryFilter) => void;
	counts: Record<CategoryFilter, number>;
}

const categories: {
	id: CategoryFilter;
	label: string;
	icon: typeof Blocks;
}[] = [
	{ id: "all", label: "All", icon: Blocks },
];

const subcategories: {
	id: CategoryFilter;
	label: string;
	icon: typeof GitBranch;
}[] = [
	{ id: "git", label: "Git", icon: GitBranch },
	{ id: "cloud", label: "Cloud", icon: Cloud },
	{ id: "observability", label: "Observability", icon: Activity },
	{ id: "registry", label: "Registries", icon: Container },
	{ id: "dns", label: "DNS", icon: Globe },
	{ id: "secrets", label: "Secrets", icon: KeyRound },
];

export function IntegrationsSidebar({
	selected,
	onSelect,
	counts,
}: IntegrationsSidebarProps) {
	return (
		<div className="w-48 shrink-0 space-y-1">
			{categories.map((cat) => (
				<Button
					key={cat.id}
					variant="ghost"
					className={cn(
						"w-full justify-start gap-2.5 h-9 px-3 text-sm font-medium transition-colors",
						selected === cat.id
							? "bg-muted/80 text-foreground"
							: "text-muted-foreground hover:text-foreground hover:bg-muted/40",
					)}
					onClick={() => onSelect(cat.id)}
				>
					<cat.icon className="h-4 w-4" />
					<span className="flex-1 text-left">{cat.label}</span>
					<span className="text-[10px] tabular-nums text-muted-foreground">
						{counts[cat.id]}
					</span>
				</Button>
			))}

			<Separator className="my-2" />

			{subcategories.map((cat) => (
				<Button
					key={cat.id}
					variant="ghost"
					className={cn(
						"w-full justify-start gap-2.5 h-9 px-3 text-sm font-medium transition-colors",
						selected === cat.id
							? "bg-muted/80 text-foreground"
							: "text-muted-foreground hover:text-foreground hover:bg-muted/40",
					)}
					onClick={() => onSelect(cat.id)}
				>
					<cat.icon className="h-4 w-4" />
					<span className="flex-1 text-left">{cat.label}</span>
					<span className="text-[10px] tabular-nums text-muted-foreground">
						{counts[cat.id]}
					</span>
				</Button>
			))}
		</div>
	);
}
