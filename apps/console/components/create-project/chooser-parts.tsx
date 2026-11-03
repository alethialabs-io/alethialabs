// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The source chooser's static parts — its copy, its frames and the scratch-card list — in ONE plain
// module (no "use client"), because two renders draw them: the chooser itself
// (`create-project-form.tsx`, `repo-import-panel.tsx`, `start-from-scratch-cards.tsx`) and its
// loading state (`create-project-skeletons.tsx`, a server component). #6351 (RUBRIC B2): the
// skeleton used to redraw these by hand with fixed bars, and the two drifted. A one-line heading
// bar stood where a two-line description wraps, a three-line card where five lines do, and the
// import card came out 166px against a 398px card. Drawing both from here makes the copy, and so
// where it wraps, the same thing in both.

import { Boxes, Cpu, GitBranch, Square, type LucideIcon } from "lucide-react";
import { SectionHeading } from "@repo/ui/section-heading";

import type { ScratchKind } from "./start-from-scratch-cards";

/** The left on-ramp column's heading. */
export const IMPORT_COLUMN_TITLE = "Import Git Repository";

/** The right on-ramp column's heading. */
export const SCRATCH_COLUMN_TITLE = "Start from scratch";

/** The "Import a repository" card's frame. */
export const IMPORT_CARD_CLASS = "rounded-xl border border-border bg-card shadow-sm";

/** The scratch cards' grid: two up from `sm`. */
export const SCRATCH_GRID_CLASS = "grid gap-3 sm:grid-cols-2";

/** One scratch card's frame — its box, padding and the gap between icon, text and arrow. */
export const SCRATCH_CARD_CLASS =
	"flex w-full items-start gap-4 rounded-xl border border-border bg-card p-4 text-left";

/** A scratch card's title row: the title, and the "New" pill on the recent on-ramps. */
export const SCRATCH_TITLE_ROW_CLASS = "flex items-center gap-2 text-ui-lg font-medium";

/** A scratch card's description, under its title. */
export const SCRATCH_DESCRIPTION_CLASS = "mt-0.5 block text-ui-sm";

/** The "New" pill's box. Its border colour is the caller's: the skeleton draws it transparent. */
export const NEW_PILL_CLASS =
	"rounded-full border px-1.5 py-0.5 font-mono text-ui-3xs uppercase tracking-wider";

/** One way to start a project from scratch, as its card shows it. */
export interface ScratchCard {
	kind: ScratchKind;
	title: string;
	description: string;
	icon: LucideIcon;
	/** Shows the "New" pill (the recently-added on-ramps). */
	isNew?: boolean;
}

/**
 * The scratch cards the chooser shows, in order: Template, then each BYO card its flag turns on,
 * then Blank. The chooser and its skeleton both read this, so the skeleton has as many cards as the
 * chooser, with the same text in them.
 */
export function scratchCards({
	byoHelmEnabled,
	byoIacEnabled,
}: {
	byoHelmEnabled: boolean;
	byoIacEnabled: boolean;
}): ScratchCard[] {
	return [
		{
			kind: "template",
			title: "Start from a template",
			description: "A standard cluster you configure — pick a cloud and template, then design.",
			icon: Cpu,
		},
		...(byoHelmEnabled
			? [
					{
						kind: "byo-helm" as const,
						title: "Bring your own Helm chart",
						description:
							"Start from a git repo — Alethia deploys and governs it on your cluster via ArgoCD.",
						icon: GitBranch,
						isNew: true,
					},
				]
			: []),
		...(byoIacEnabled
			? [
					{
						kind: "byo-iac" as const,
						title: "Bring your own IaC",
						description:
							"Start from a git repo — Alethia plans, verifies, and applies your OpenTofu module.",
						icon: Boxes,
						isNew: true,
					},
				]
			: []),
		{
			kind: "blank",
			title: "Blank project",
			description: "An empty canvas — add components yourself and design from scratch.",
			icon: Square,
		},
	];
}

/** A small column heading with a trailing hairline rule. */
export function ColHead({ children }: { children: React.ReactNode }) {
	return (
		<div className="flex items-center gap-3">
			<span className="text-ui-md font-semibold tracking-tight">{children}</span>
			<span className="h-px flex-1 bg-border" />
		</div>
	);
}

/**
 * The "Import a repository" card's heading: its icon and the section heading with its description.
 * The description wraps to two lines in the chooser's half-width column, so the heading is drawn,
 * not approximated, wherever the card is.
 */
export function ImportCardHeading() {
	return (
		<div className="flex items-start gap-3 p-4 pb-3">
			<span className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-md border border-border text-muted-foreground">
				<GitBranch className="size-4" />
			</span>
			<SectionHeading
				className="min-w-0 flex-1"
				title="Import a repository"
				description="Scan a git repo — Alethia infers the stack and opens it on the canvas to review before you provision."
			/>
		</div>
	);
}
