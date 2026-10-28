// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The create flow's loading shapes (#6131, RUBRIC B2: the skeleton matches the final layout). Each
// mirrors the screen it stands in for BY HAND — the boxes are the real components' boxes, at their
// real sizes — because those components take live data. Change one with the other:
//   · ChooserSkeleton   ↔ create-project-form.tsx + repo-import-panel.tsx + start-from-scratch-cards.tsx
//   · ConfigureSkeleton ↔ configure-project.tsx + source-summary.tsx
// It used to be a generic five-field form, which is neither screen: the chooser is a prompt hero over
// two on-ramp columns, and the content jumped into a different shape when it arrived.

import { Skeleton } from "@repo/ui/skeleton";
import { EXAMPLE_PROMPTS, examplePromptLabel } from "./example-prompts";

/**
 * Step 1 (`/~/new`): the agent hero, its example chips, then the two on-ramp columns. The scratch
 * column holds as many cards as the chooser will (Template + Blank, plus each BYO card its flag
 * turns on), so the column is the height it will be.
 */
export function ChooserSkeleton({
	byoHelmEnabled,
	byoIacEnabled,
}: {
	byoHelmEnabled: boolean;
	byoIacEnabled: boolean;
}) {
	const scratchCards = 2 + (byoHelmEnabled ? 1 : 0) + (byoIacEnabled ? 1 : 0);
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
						<div className="flex-1 space-y-2 pt-1">
							<Skeleton className="h-4 w-full" />
							<Skeleton className="h-4 w-2/3" />
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
					<ColHeadSkeleton />
					<ImportPanelSkeleton />
				</div>
				<div className="space-y-3">
					<ColHeadSkeleton />
					<div className="grid gap-3 sm:grid-cols-2">
						{Array.from({ length: scratchCards }, (_, i) => (
							<div
								key={i}
								className="flex items-start gap-4 rounded-xl border border-border bg-card p-4"
							>
								<Skeleton className="size-9 shrink-0 rounded-md" />
								<div className="min-w-0 flex-1 space-y-2">
									<Skeleton className="h-4 w-36 max-w-full" />
									<Skeleton className="h-3 w-full" />
									<Skeleton className="h-3 w-3/4" />
								</div>
							</div>
						))}
					</div>
				</div>
			</div>
		</div>
	);
}

/** The "Import a repository" card at rest: its heading, the provider + repository row, the footer. */
function ImportPanelSkeleton() {
	return (
		<div className="rounded-xl border border-border bg-card shadow-sm">
			<div className="flex items-start gap-3 p-4 pb-3">
				<Skeleton className="mt-0.5 size-7 shrink-0 rounded-md" />
				<div className="min-w-0 flex-1 space-y-2">
					<Skeleton className="h-4 w-40" />
					<Skeleton className="h-3 w-full" />
				</div>
			</div>
			<div className="space-y-3 px-4 pb-4">
				<Skeleton className="h-9 w-full rounded-md" />
				<div className="flex items-center justify-between gap-3">
					<Skeleton className="h-3 w-32" />
					<Skeleton className="h-9 w-40 rounded-md" />
				</div>
			</div>
		</div>
	);
}

/** A column heading with its trailing hairline (create-project-form.tsx `ColHead`). */
function ColHeadSkeleton() {
	return (
		<div className="flex items-center gap-3">
			<Skeleton className="h-5 w-44" />
			<span className="h-px flex-1 bg-border" />
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
