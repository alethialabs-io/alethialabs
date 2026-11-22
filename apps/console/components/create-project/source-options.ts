// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The create screen's starting points, as data: what the radio group and its skeleton both draw.
// Not a client module, so the route's server-rendered skeleton can read it.

import { Boxes, Cpu, FileCode2, GitBranch, Package, Sparkles, Square } from "lucide-react";
import type { LucideIcon } from "lucide-react";

import type { CreateSource } from "./create-project.wizard";

/** One starting point, as the screen lists it. */
export interface SourceOption {
	readonly value: CreateSource;
	readonly title: string;
	readonly description: string;
	readonly icon: LucideIcon;
}

/**
 * The starting points the screen offers, in order. The two BYO options are behind their server
 * flags. Every template creates the same cluster (`templates.ts`); they differ in the starter they
 * hand over, which is what the description says.
 */
export function sourceOptions(flags: {
	readonly byoHelmEnabled: boolean;
	readonly byoIacEnabled: boolean;
}): SourceOption[] {
	return [
		{
			value: "import",
			title: "Import a repository",
			description: "Scan a git repository; Alethia infers the stack.",
			icon: GitBranch,
		},
		{
			value: "standard",
			title: "Standard",
			description: "A cluster and an apps repository for ArgoCD.",
			icon: Cpu,
		},
		{
			value: "ai",
			title: "AI workloads",
			description: "The same cluster with a CPU-only RAG stack.",
			icon: Sparkles,
		},
		{
			value: "blank",
			title: "Blank",
			description: "An empty canvas; add components yourself.",
			icon: Square,
		},
		{
			value: "custom",
			title: "Cluster only",
			description: "The cluster, and no starter repository.",
			icon: Boxes,
		},
		...(flags.byoHelmEnabled
			? [
					{
						value: "byo-helm" as const,
						title: "Your Helm chart",
						description: "Deploy a chart from git through ArgoCD.",
						icon: Package,
					},
				]
			: []),
		...(flags.byoIacEnabled
			? [
					{
						value: "byo-iac" as const,
						title: "Your IaC module",
						description: "Plan, verify and apply an OpenTofu module.",
						icon: FileCode2,
					},
				]
			: []),
	];
}

/** The grid the options sit in; shared with the skeleton so both have the same columns. */
export const SOURCE_GRID_CLASS = "grid gap-2 sm:grid-cols-2 lg:grid-cols-4";

/** One option's box; shared with the skeleton so both are the same height. */
export const SOURCE_OPTION_CLASS = "flex min-h-[4.5rem] items-start gap-3 border border-border bg-card p-3";
