// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import {
	Boxes,
	GitBranch,
	type LucideIcon,
	PlugZap,
	Rocket,
	Database,
	ScrollText,
	ShieldCheck,
} from "lucide-react";

export interface ElenchSuggestion {
	icon: LucideIcon;
	title: string;
	sub: string;
	/** The prompt sent when the suggestion is picked. */
	prompt: string;
}

/** Org modal landing chips — control-plane-wide questions (read-only, safe). */
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
];

/** Project panel suggestions — the build-&-operate loop for one project. */
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
];
