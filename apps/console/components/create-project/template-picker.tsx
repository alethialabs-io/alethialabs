"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The Configure screen's template picker (#4110, ruling B: wire it, do not delete it).
//
// This is the former `design-project/container-platform-selector.tsx`, moved to the feature it now
// serves. Its three cards were always Standard / AI Workloads / Custom; they are now keyed on
// `TemplateId` from `./templates` — the console's ONE set of template ids — instead of a private
// string list, so there is not a second picker for the same idea.
//
// Its copy was rewritten against what the starter repositories actually are (#4935 measured the old
// copy false): "AI Workloads" no longer promises "GPU support", because `alethia-starter-ai` is
// CPU-only, and it is no longer badged "Recommended". The catalogue — every string and each starter
// repository — lives in `TEMPLATE_OPTIONS`; this file only renders it.

import { buttonVariants } from "@repo/ui/button";
import { CheckCircle2, Cpu, ExternalLink, type LucideIcon, Settings, Sparkles } from "lucide-react";

import {
	TEMPLATE_OPTIONS,
	type TemplateId,
	starterCopyUrl,
	templateOption,
} from "./templates";

const ICONS: Record<TemplateId, LucideIcon> = {
	standard: Cpu,
	ai: Sparkles,
	custom: Settings,
};

interface TemplatePickerProps {
	value: TemplateId;
	onChange: (template: TemplateId) => void;
}

/**
 * Three toggle cards over {@link TEMPLATE_OPTIONS}, then the chosen template's starter repository
 * with a "Use this template" link and the one step to take after the project exists. Controlled:
 * the host owns the value. A template with no starter (Custom) says so instead of showing a link.
 */
export function TemplatePicker({ value, onChange }: TemplatePickerProps) {
	const selected = templateOption(value);

	return (
		<div className="flex flex-col gap-3">
			<div className="grid gap-3 md:grid-cols-3" role="group" aria-label="Template">
				{TEMPLATE_OPTIONS.map((option) => {
					const isSelected = option.id === value;
					const Icon = ICONS[option.id];
					return (
						<button
							key={option.id}
							type="button"
							aria-pressed={isSelected}
							onClick={() => onChange(option.id)}
							className={`relative rounded-lg border p-4 text-left transition-all ${
								isSelected
									? "border-foreground bg-muted/30"
									: "border-border/50 hover:border-border hover:bg-muted/10"
							}`}
						>
							<div className="mb-2 flex items-center gap-2.5">
								<div
									className={`rounded-md border p-1.5 ${isSelected ? "border-foreground bg-foreground text-background" : "border-border/50 bg-muted text-muted-foreground"}`}
								>
									<Icon className="h-3.5 w-3.5" />
								</div>
								<span className="text-sm font-medium text-foreground">{option.title}</span>
							</div>
							<p className="mb-3 text-ui-xs leading-relaxed text-muted-foreground">
								{option.description}
							</p>
							<ul className="space-y-1">
								{option.features.map((feature) => (
									<li
										key={feature}
										className="flex items-center gap-1.5 text-ui-xs text-muted-foreground"
									>
										<CheckCircle2
											className={`h-3 w-3 shrink-0 ${isSelected ? "text-foreground" : "text-text-tertiary"}`}
										/>
										{feature}
									</li>
								))}
							</ul>
						</button>
					);
				})}
			</div>

			<div className="flex flex-wrap items-center justify-between gap-3 border border-border bg-card px-3 py-2.5">
				<div className="flex min-w-0 flex-col gap-0.5">
					<span className="font-mono text-ui-2xs uppercase tracking-[0.1em] text-muted-foreground">
						Starter repository
					</span>
					{selected.starter ? (
						<a
							href={selected.starter.url}
							target="_blank"
							rel="noreferrer"
							className="font-mono text-ui-sm text-foreground underline-offset-4 hover:underline"
						>
							alethialabs-io/{selected.starter.name}
						</a>
					) : (
						<span className="text-ui-sm text-foreground">None — bring your own</span>
					)}
					<span className="text-ui-xs text-muted-foreground">{selected.nextStep}</span>
				</div>
				{selected.starter && (
					// A plain anchor in the button's clothes, not `<Button render={<a/>}>`: base-ui gives
					// that anchor `role="button"`, and this navigates — it should be announced as a link.
					<a
						href={starterCopyUrl(selected.starter)}
						target="_blank"
						rel="noreferrer"
						className={buttonVariants({ variant: "outline", size: "sm" })}
					>
						Use this template
						<ExternalLink className="size-3.5" />
					</a>
				)}
			</div>
		</div>
	);
}
