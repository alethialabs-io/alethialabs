"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// WHY THIS FILE HAS NO CALLER, and what has to be checked before anything wires it.
//
// It renders nowhere. The only occurrences of `ContainerPlatformSelector` under `apps/` or
// `packages/` are this file's own interface, definition and signature, plus the `ignoreIssues`
// entry for this path in `apps/console/knip.json` — which is the reason `check:dead-code` is
// green over it. The guard being happy is not evidence that the file is dead: the guard was
// told not to look.
//
// MAINTAINER RULING (#4110, 2026-09-18): B — keep it, and wire it as the entry point to the
// starter templates of epic #2766. The wiring depends on #4112 (the three public starter
// repositories), which is still open, so nothing is wired yet. Do not delete this as dead code
// on the strength of the knip entry; only the maintainer reverses the ruling.
//
// FOUR MEASUREMENTS THE WIRING HAS TO SURVIVE. They are recorded here rather than only on the
// issue because they are facts about this code, and because none of them was available when the
// ruling was made — the starter repositories did not exist until 2026-09-22.
//
//  1. THIS IS ABANDONED CODE, NOT UNBUILT GROUNDWORK. #4110 argued that nothing in the console
//     ever referenced a template flow, which is "never built" rather than "built and dropped".
//     `git log -S ContainerPlatformSelector --all` says otherwise: it was added on 2025-12-07
//     as the node-shape picker inside a "Platform & EKS" card (cluster version, node groups,
//     auto-scaling), and it was last rendered by `components/create-project/create-project-form.tsx`,
//     whose own doc comment read "Templates reuse {@link ContainerPlatformSelector}". That render
//     went away on 2026-07-29 in #1304, when `~/new` became the two-step source chooser. So
//     Custom's "You choose all template repositories" is a 2026-07 copy edit onto a compute
//     picker, not a sentence written for #2766.
//
//  2. THE CONSOLE'S LIVE TEMPLATE IDS ARE SOMEWHERE ELSE. `components/create-project/templates.ts`
//     declares `TemplateId = "standard" | "ai" | "custom"` — the same three options — and
//     implements `"ai"` as a GPU node pool (`GPU_INSTANCE`). Its only caller,
//     `components/create-project/configure-project.tsx`, passes `template: "standard"` literally,
//     so `"ai"` and `"custom"` are unreachable from the UI today. A second picker for the same
//     idea is the console telling the user it is two products; surface that one instead.
//
//  3. THE THREE STARTER REPOSITORIES ARE NOT THREE ALTERNATIVES. Per #4112 they are separated by
//     TRUST LEVEL, not by workload shape: `alethia-starter-apps` is an ArgoCD apps repository,
//     `alethia-starter-chart` is a bring-your-own Helm chart, and `alethia-starter-ai` SPANS BOTH
//     (CRD-bearing add-ons into the apps repository, plain workloads into a chart). A thing that
//     spans both cannot be one of three mutually exclusive cards. Each also already has a live
//     on-ramp: `~/new` → "Bring your own Helm chart" (`?attachChart=1`) and the environment's
//     Repositories → ArgoCD apps repository.
//
//  4. THIS FILE'S COPY IS FALSE OF THE TEMPLATE IT WOULD BE WIRED TO. The "AI Workloads" card
//     promises "GPU support"; `alethia-starter-ai` provisions no GPU and is CPU-only by explicit
//     decision (#4112: a GPU node pool is the most expensive thing a curious user could provision
//     by accident). The promise is true of `templates.ts`'s `"ai"` and false of the template.
//     Those are two different meanings of "AI Workloads", and the wiring has to choose one rather
//     than inherit these strings.
//
// IF THE RULING IS REVERSED TO A (delete), the whole diff is this file plus its `ignoreIssues`
// entry in `apps/console/knip.json` — both, or the suppression outlives its subject and mutes the
// guard for a path that no longer exists.

import { Badge } from "@repo/ui/badge";
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

/**
 * A three-card radio group over the platform presets above — Standard, AI Workloads and Custom —
 * calling `onSelect` with the chosen preset's id. Presentational: it holds no state and knows
 * nothing about what a preset means; the host decides that. Nothing renders it today — see the
 * ruling at the top of this file before wiring or deleting it.
 */
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
								className="absolute top-2 right-2 text-ui-2xs"
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

						<p className="text-ui-xs text-muted-foreground mb-3 leading-relaxed">
							{platform.description}
						</p>

						<ul className="space-y-1">
							{platform.features.map((feature) => (
								<li
									key={feature}
									className="flex items-center gap-1.5 text-ui-xs text-muted-foreground"
								>
									<CheckCircle2 className={`w-3 h-3 shrink-0 ${isSelected ? "text-foreground" : "text-text-tertiary"}`} />
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
