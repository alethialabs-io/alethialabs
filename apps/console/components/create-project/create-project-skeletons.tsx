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

/** Step 1 (`/~/new`): the agent hero, its example chips, then the two on-ramp columns. */
export function ChooserSkeleton() {
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
				<div className="flex flex-wrap gap-2">
					{["w-56", "w-48", "w-60"].map((w) => (
						<Skeleton key={w} className={`h-8 max-w-full rounded-full ${w}`} />
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
						{[0, 1].map((i) => (
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

/** Step 2 (`?scan=` / `?scratch=`): the step header, the source rail, and the numbered sections. */
export function ConfigureSkeleton() {
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
					{[1, 2, 3].map((n) => (
						<div key={n} className="space-y-3">
							<div className="flex items-center gap-3">
								<Skeleton className="h-4 w-6" />
								<Skeleton className="h-4 w-32" />
								<span className="h-px flex-1 bg-border" />
							</div>
							<Skeleton className="h-9 w-full rounded-md" />
						</div>
					))}
					<div className="flex items-center justify-between gap-4 border-t border-border pt-5">
						<Skeleton className="h-3 w-56" />
						<Skeleton className="h-9 w-44 rounded-md" />
					</div>
				</div>
			</div>
		</div>
	);
}
