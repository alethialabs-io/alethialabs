// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import {
	BellRing,
	Boxes,
	Cable,
	Calculator,
	Cpu,
	Database,
	DollarSign,
	GitBranch,
	Layers,
	type LucideIcon,
	MemoryStick,
	PlugZap,
	Radar,
	Rocket,
	ScrollText,
	ShieldCheck,
	Gauge,
} from "lucide-react";

export interface ElenchSuggestion {
	icon: LucideIcon;
	title: string;
	sub: string;
	/** The prompt sent when the suggestion is picked. */
	prompt: string;
}

/**
 * Org modal landing chips — control-plane-wide questions (read-only, safe). Nine
 * entries so the landing carousel fills three pages of three cards.
 */
export const ORG_SUGGESTIONS: ElenchSuggestion[] = [
	{
		icon: PlugZap,
		title: "Are my connectors healthy?",
		sub: "Check cloud connections",
		prompt: "Are my connectors healthy?",
	},
	{
		icon: Boxes,
		title: "What clusters are running?",
		sub: "List active clusters",
		prompt: "What clusters are running?",
	},
	{
		icon: ScrollText,
		title: "Show recent jobs",
		sub: "Latest provisioning jobs",
		prompt: "Show my recent provisioning jobs",
	},
	{
		icon: DollarSign,
		title: "What is my spend?",
		sub: "Cost under management",
		prompt: "What is my current cloud spend under management?",
	},
	{
		icon: Radar,
		title: "Any drift?",
		sub: "Live vs. provisioned",
		prompt: "Is any of my infrastructure drifting from what was provisioned?",
	},
	{
		icon: Cpu,
		title: "How are my runners?",
		sub: "Runner fleet status",
		prompt: "How are my runners doing?",
	},
	{
		icon: Gauge,
		title: "Show my usage",
		sub: "Runner minutes & AI credits",
		prompt: "Show my usage this period — runner minutes and AI credits.",
	},
	{
		icon: Rocket,
		title: "Recent deploys",
		sub: "Latest deploy outcomes",
		prompt: "Show my recent deploys and their outcomes.",
	},
	{
		icon: BellRing,
		title: "Any alerts?",
		sub: "Open alerts & issues",
		prompt: "Are there any open alerts or issues I should know about?",
	},
];

/**
 * Project panel suggestions — the build-&-operate loop for one project. Nine
 * entries so the landing carousel fills three pages of three cards.
 */
export const PROJECT_SUGGESTIONS: ElenchSuggestion[] = [
	{
		icon: GitBranch,
		title: "Scan a repo",
		sub: "Infer infrastructure from code",
		prompt: "Scan my repo: https://github.com/",
	},
	{
		icon: Database,
		title: "Add a database",
		sub: "Add a Postgres database",
		prompt: "Add a Postgres database",
	},
	{
		icon: ShieldCheck,
		title: "Plan & verify",
		sub: "Plan this project and show the verification",
		prompt: "Plan this project and show me the verification",
	},
	{
		icon: Boxes,
		title: "What clusters are running?",
		sub: "List active clusters",
		prompt: "What clusters are running?",
	},
	{
		icon: Rocket,
		title: "Deploy this project",
		sub: "Provision the current design",
		prompt: "Deploy this project",
	},
	{
		icon: MemoryStick,
		title: "Add a cache",
		sub: "Add a Redis cache",
		prompt: "Add a Redis cache to this project",
	},
	{
		icon: Calculator,
		title: "Estimate the cost",
		sub: "Monthly cost of this design",
		prompt: "Estimate the monthly cost of this project.",
	},
	{
		icon: Layers,
		title: "Environments",
		sub: "Compare staging vs. prod",
		prompt: "Show this project's environments and how they differ.",
	},
	{
		icon: Cable,
		title: "Check connections",
		sub: "Cloud & provider connectors",
		prompt: "Which connectors does this project rely on, and are they healthy?",
	},
];
