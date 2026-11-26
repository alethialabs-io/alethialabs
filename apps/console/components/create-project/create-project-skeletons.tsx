// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The create screen's loading shape (RUBRIC B2: the skeleton is the final layout).
//   · CreateProjectSkeleton     ↔ the whole route: the agent prompt, then the form
//   · CreateProjectFormSkeleton ↔ create-project-screen.tsx (the page's Suspense fallback)
// Both are drawn from the screen's own parts — `FieldRow`, the starting-point grid and option box
// (`source-options.ts`), the option copy — so the rows, the columns and the option heights cannot
// drift from the screen. Text the viewer must not read yet is the real text, invisible inside its
// bar, so a bar is as wide as the text and wraps where it wraps.
//
// SYNCHRONOUS ON PURPOSE (B-29): nothing here waits on a read. The screen it stands for opens on
// "Standard", whose rows do not depend on the viewer's git accounts or clouds.

import type { ReactNode } from "react";

import { SkeletonRoot } from "@/components/skeleton/skeleton-root";
import { Skeleton } from "@repo/ui/skeleton";

import { EXAMPLE_PROMPTS, examplePromptLabel } from "./example-prompts";
import { SOURCE_GRID_CLASS, SOURCE_OPTION_CLASS, sourceOptions } from "./source-options";

/** The number of clouds the skeleton draws: the release's four. */
const CLOUD_TILES = 4;

/**
 * One labelled row of the create form: the label in a narrow column beside the field from `sm`,
 * above it on a phone. `htmlFor` makes the label the field's own; a row holding a radio group
 * leaves it out, and the group's legend names it instead.
 */
export function FieldRow({
	label,
	htmlFor,
	children,
}: {
	label: string;
	htmlFor?: string;
	children: ReactNode;
}) {
	return (
		<div className="grid gap-2 sm:grid-cols-[7rem_minmax(0,1fr)] sm:gap-6">
			{htmlFor ? (
				<label htmlFor={htmlFor} className="pt-2 text-ui-sm text-muted-foreground">
					{label}
				</label>
			) : (
				<span aria-hidden="true" className="pt-2 text-ui-sm text-muted-foreground">
					{label}
				</span>
			)}
			<div className="min-w-0">{children}</div>
		</div>
	);
}

/** The agent prompt above the form, at rest. */
export function AgentPromptSkeleton() {
	return (
		<section className="space-y-5">
			<div className="flex items-center justify-between gap-4">
				<Skeleton className="h-9 w-72 max-w-full sm:h-10" />
				<Skeleton className="h-8 w-28 shrink-0 rounded-full" />
			</div>
			<div className="rounded-xl border border-border bg-card shadow-sm">
				<div className="flex items-start gap-3 p-4 pb-2">
					<Skeleton className="mt-0.5 size-7 shrink-0 rounded-md" />
					{/* The empty prompt: ONE line of its rung under its 4px top pad, as the empty
					    textarea is (it sizes to its content, and its placeholder is not content). */}
					<div data-slot="prompt-skeleton" className="min-w-0 flex-1 pt-1 text-ui-lg">
						<div className="flex h-[1lh] items-center">
							<Skeleton className="h-4 w-full" />
						</div>
					</div>
				</div>
				<div className="flex items-center justify-between px-4 pb-3">
					<Skeleton className="h-3 w-12" />
					<Skeleton className="size-9 rounded-md" />
				</div>
			</div>
			<div className="flex flex-wrap gap-2" aria-hidden="true">
				{EXAMPLE_PROMPTS.map((ex) => (
					<Skeleton key={ex} className="rounded-full border border-transparent px-3 py-1.5 text-left text-xs">
						<span className="invisible">{examplePromptLabel(ex)}</span>
					</Skeleton>
				))}
			</div>
		</section>
	);
}

/**
 * The form at rest on "Standard": the starting points in their own grid with their own copy, the
 * four cloud tiles and the account line, the region select, the name field with its slug line, and
 * the footer with a Create-sized placeholder.
 */
export function CreateProjectFormSkeleton({
	byoHelmEnabled,
	byoIacEnabled,
}: {
	byoHelmEnabled: boolean;
	byoIacEnabled: boolean;
}) {
	return (
		<SkeletonRoot className="space-y-6" data-testid="create-project-form-skeleton">
			<FieldRow label="Start from">
				<div className={SOURCE_GRID_CLASS} aria-hidden="true">
					{sourceOptions({ byoHelmEnabled, byoIacEnabled }).map((option) => (
						<div key={option.value} data-slot="source-option-skeleton" className={SOURCE_OPTION_CLASS}>
							<Skeleton className="mt-0.5 size-4 shrink-0" />
							<div className="min-w-0">
								<Skeleton className="block text-ui-sm">
									<span className="invisible">{option.title}</span>
								</Skeleton>
								<Skeleton className="mt-0.5 block text-ui-xs">
									<span className="invisible">{option.description}</span>
								</Skeleton>
							</div>
						</div>
					))}
				</div>
			</FieldRow>
			<FieldRow label="Cloud">
				<div className="space-y-3">
					<div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
						{Array.from({ length: CLOUD_TILES }, (_, i) => (
							<div key={i} className="flex items-center gap-2.5 border border-border bg-card px-3 py-2.5">
								<Skeleton className="size-[18px] shrink-0" />
								<div className="space-y-1">
									<Skeleton className="h-4 w-14" />
									<Skeleton className="h-3 w-20" />
								</div>
							</div>
						))}
					</div>
					<Skeleton className="h-5 w-64 max-w-full" />
				</div>
			</FieldRow>
			<FieldRow label="Region">
				<Skeleton className="h-9 w-full max-w-[280px]" />
			</FieldRow>
			<FieldRow label="Project name">
				<Skeleton className="h-9 w-full max-w-md" />
				<Skeleton className="mt-2 h-4 w-48" />
			</FieldRow>
			<div className="flex flex-wrap items-center justify-between gap-4 border-t border-border pt-5">
				<Skeleton className="h-4 w-80 max-w-full" />
				<Skeleton className="h-9 w-36" />
			</div>
		</SkeletonRoot>
	);
}

/** The whole route at rest: the agent prompt, then the form. */
export function CreateProjectSkeleton({
	byoHelmEnabled,
	byoIacEnabled,
}: {
	byoHelmEnabled: boolean;
	byoIacEnabled: boolean;
}) {
	return (
		<SkeletonRoot className="space-y-9 pb-20">
			<AgentPromptSkeleton />
			<CreateProjectFormSkeleton byoHelmEnabled={byoHelmEnabled} byoIacEnabled={byoIacEnabled} />
		</SkeletonRoot>
	);
}
