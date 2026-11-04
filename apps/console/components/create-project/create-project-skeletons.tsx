// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The create flow's loading shapes (#6131, RUBRIC B2: the skeleton matches the final layout).
//   · ChooserSkeleton   ↔ create-project-form.tsx + repo-import-panel.tsx + start-from-scratch-cards.tsx
//   · ConfigureSkeleton ↔ configure-project.tsx + source-summary.tsx
// The chooser's skeleton is DRAWN FROM THE CHOOSER'S OWN PARTS (`chooser-parts.tsx`, #6351): its
// column headings, the import card's heading and frame, and the scratch cards' frames and copy. Text
// the viewer must not read yet (the chips, the card copy) is the real text, invisible inside its bar,
// so the bar is as wide as the text and wraps where it wraps. Only the controls the chooser draws
// from live data are bars: the import card's selector is the shape the viewer's linked git accounts
// give it (`linked`, read before the skeleton draws), and the prompt is one line box, as the empty
// textarea is (it sizes to its content, and its placeholder is not content).
// The Configure skeleton still mirrors its screen by hand. Change it with the screen.

import { Skeleton } from "@repo/ui/skeleton";
import { cn } from "@repo/ui/utils";
import { RepositorySelectorSkeleton } from "@/components/repository-selector";
import {
	ColHead,
	IMPORT_CARD_CLASS,
	IMPORT_COLUMN_TITLE,
	ImportCardHeading,
	NEW_PILL_CLASS,
	SCRATCH_CARD_CLASS,
	SCRATCH_COLUMN_TITLE,
	SCRATCH_DESCRIPTION_CLASS,
	SCRATCH_GRID_CLASS,
	SCRATCH_TITLE_ROW_CLASS,
	scratchCards,
} from "./chooser-parts";
import { EXAMPLE_PROMPTS, examplePromptLabel } from "./example-prompts";

/**
 * Step 1 (`/~/new`): the agent hero, its example chips, then the two on-ramp columns: the import
 * card with the selector the viewer will get, and as many scratch cards as the chooser will show
 * (Template + Blank, plus each BYO card its flag turns on), each with its own copy.
 */
export function ChooserSkeleton({
	byoHelmEnabled,
	byoIacEnabled,
	linked,
}: {
	byoHelmEnabled: boolean;
	byoIacEnabled: boolean;
	/** Whether the viewer has a git account linked; `undefined` (not known) draws the selector's row. */
	linked: boolean | undefined;
}) {
	return (
		<div className="space-y-9 pb-20" aria-busy="true">
			<section className="space-y-5">
				<div className="flex items-center justify-between gap-4">
					<Skeleton className="h-9 w-72 max-w-full sm:h-10" />
					<Skeleton className="h-8 w-28 shrink-0 rounded-full" />
				</div>
				<div className="rounded-xl border border-border bg-card shadow-sm">
					<div className="flex items-start gap-3 p-4 pb-2">
						<Skeleton className="mt-0.5 size-7 shrink-0 rounded-md" />
						{/* The empty prompt: ONE line of its rung under its 4px top pad. It used to be
						    two bars, 44px against the textarea's 26.5px, which pushed everything
						    below it down by 14px. */}
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
				{/* The chips' REAL text, invisible, in the chips' own box: they are as wide as the
				    chips and wrap where the chips wrap, at every width. Fixed-width bars on one row
				    were neither. Hidden from assistive tech — it is a placeholder, not content. */}
				<div className="flex flex-wrap gap-2" aria-hidden="true">
					{EXAMPLE_PROMPTS.map((ex) => (
						<Skeleton
							key={ex}
							className="rounded-full border border-transparent px-3 py-1.5 text-left text-xs"
						>
							<span className="invisible">{examplePromptLabel(ex)}</span>
						</Skeleton>
					))}
				</div>
			</section>

			<div className="grid gap-6 lg:grid-cols-2">
				<div className="space-y-3">
					<ColHead>{IMPORT_COLUMN_TITLE}</ColHead>
					<ImportPanelSkeleton linked={linked} />
				</div>
				<div className="space-y-3">
					<ColHead>{SCRATCH_COLUMN_TITLE}</ColHead>
					<ScratchCardsSkeleton byoHelmEnabled={byoHelmEnabled} byoIacEnabled={byoIacEnabled} />
				</div>
			</div>
		</div>
	);
}

/**
 * The "Import a repository" card at rest: its real heading, the selector in the shape the viewer's
 * linked git accounts give it (the row, or the "No Git accounts linked" panel), then the footer.
 */
function ImportPanelSkeleton({ linked }: { linked: boolean | undefined }) {
	return (
		<div data-slot="import-card-skeleton" className={IMPORT_CARD_CLASS}>
			<ImportCardHeading />
			<div className="space-y-3 px-4 pb-4">
				<RepositorySelectorSkeleton linked={linked} />
				<div className="flex items-center justify-between gap-3">
					<Skeleton className="h-3 w-32" />
					<Skeleton className="h-9 w-40 rounded-md" />
				</div>
			</div>
		</div>
	);
}

/**
 * The scratch cards, one per card the chooser shows, in the cards' own frames: the icon tile, the
 * title (with the "New" pill where the card has one) and the description, each the card's real
 * text, invisible, inside its bar — the description wraps to several lines in a half-column card,
 * and a fixed bar cannot know how many. Hidden from assistive tech: a placeholder, not content.
 */
function ScratchCardsSkeleton({
	byoHelmEnabled,
	byoIacEnabled,
}: {
	byoHelmEnabled: boolean;
	byoIacEnabled: boolean;
}) {
	return (
		<div className={SCRATCH_GRID_CLASS} aria-hidden="true">
			{scratchCards({ byoHelmEnabled, byoIacEnabled }).map((card) => (
				<div key={card.kind} data-slot="scratch-card-skeleton" className={SCRATCH_CARD_CLASS}>
					<Skeleton className="size-9 shrink-0 rounded-md" />
					<div className="min-w-0 flex-1">
						<div className={SCRATCH_TITLE_ROW_CLASS}>
							<Skeleton>
								<span className="invisible">{card.title}</span>
							</Skeleton>
							{card.isNew && (
								<Skeleton className={cn(NEW_PILL_CLASS, "border-transparent")}>
									<span className="invisible">New</span>
								</Skeleton>
							)}
						</div>
						<Skeleton className={SCRATCH_DESCRIPTION_CLASS}>
							<span className="invisible">{card.description}</span>
						</Skeleton>
					</div>
					<span className="size-4 shrink-0" />
				</div>
			))}
		</div>
	);
}

/**
 * Step 2 (`?scan=` / `?scratch=`): the step header, the source rail, and the numbered sections at
 * their sections' heights — Project (field + slug line), the Template picker on the template path
 * only, Cloud & region (the account cards + the region row), Environments (the placement groups).
 */
export function ConfigureSkeleton({ template }: { template: boolean }) {
	return (
		<div className="w-full" aria-busy="true">
			<div className="mb-[22px] flex items-center gap-3">
				<Skeleton className="size-8 shrink-0" />
				<div className="flex-1 space-y-2">
					<Skeleton className="h-5 w-52" />
					<Skeleton className="h-3 w-80 max-w-full" />
				</div>
			</div>
			<div className="grid gap-6 lg:grid-cols-[336px_1fr]">
				<div className="flex flex-col gap-[18px]">
					<div className="flex flex-col gap-2.5">
						<Skeleton className="h-3 w-16" />
						<Skeleton className="h-16 w-full rounded-xl" />
					</div>
					<div className="flex flex-col gap-2.5">
						<Skeleton className="h-3 w-24" />
						<Skeleton className="h-32 w-full rounded-xl" />
					</div>
				</div>
				<div className="flex flex-col gap-7">
					<SectionSkeleton>
						<Skeleton className="h-9 w-full rounded-md" />
						<Skeleton className="mt-2 h-4 w-40" />
					</SectionSkeleton>
					{template && (
						<SectionSkeleton>
							<div className="flex flex-col gap-3">
								<div className="grid gap-3 md:grid-cols-3">
									{[0, 1, 2].map((i) => (
										<Skeleton key={i} className="h-28 w-full rounded-lg" />
									))}
								</div>
								<Skeleton className="h-10 w-full rounded-md" />
							</div>
						</SectionSkeleton>
					)}
					<SectionSkeleton>
						<div className="grid gap-3 sm:grid-cols-2">
							{[0, 1, 2, 3].map((i) => (
								<Skeleton key={i} className="h-16 w-full rounded-lg" />
							))}
						</div>
						<div className="mt-3 flex items-center gap-3">
							<Skeleton className="h-3 w-12" />
							<Skeleton className="h-9 w-56 rounded-md" />
						</div>
					</SectionSkeleton>
					<SectionSkeleton>
						<div className="space-y-5">
							{[0, 1].map((g) => (
								<div key={g} className="space-y-2.5">
									<Skeleton className="h-3 w-24" />
									<Skeleton className="h-12 w-full rounded-md" />
									<Skeleton className="h-12 w-full rounded-md" />
								</div>
							))}
						</div>
					</SectionSkeleton>
					<div className="flex items-center justify-between gap-4 border-t border-border pt-5">
						<Skeleton className="h-3 w-56" />
						<Skeleton className="h-9 w-44 rounded-md" />
					</div>
				</div>
			</div>
		</div>
	);
}

/** One numbered configure section: its heading row (number, title, rule), then its body. */
function SectionSkeleton({ children }: { children: React.ReactNode }) {
	return (
		<div>
			<div className="mb-3 flex items-center gap-3">
				<Skeleton className="h-4 w-6" />
				<Skeleton className="h-4 w-32" />
				<span className="h-px flex-1 bg-border" />
			</div>
			{children}
		</div>
	);
}
