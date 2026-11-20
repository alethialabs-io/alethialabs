// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The projects area while its read is pending. Rendered by the route's `loading.tsx` (through
// `OverviewSkeleton`) and by the grid itself, so both draw one shape. No "use client".

import { Skeleton } from "@repo/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@repo/ui/table";
import type { ViewMode } from "@repo/ui/view-toggle";

/** The most project placeholders drawn: past the second row of cards they are below the fold. */
export const MAX_PROJECT_PLACEHOLDERS = 6;

/** Placeholders drawn when the number of projects is not known. */
export const UNKNOWN_PROJECT_PLACEHOLDERS = 2;

/** The table view's column headings, in order. The last column holds the actions menu. */
export const PROJECT_TABLE_COLUMNS = [
	"Project",
	"Cloud",
	"Region",
	"Status",
	"Envs",
	"Add-ons",
	"Cost",
	"Last deploy",
] as const;

/** The columns whose cells are right-aligned. */
const RIGHT_ALIGNED: readonly string[] = ["Cost", "Last deploy"];

/** The table view's header row: the page and its skeleton both render this one. */
export function ProjectTableHeader() {
	return (
		<TableHeader>
			<TableRow className="hover:bg-transparent">
				{PROJECT_TABLE_COLUMNS.map((column) => (
					<TableHead key={column} className={RIGHT_ALIGNED.includes(column) ? "text-right" : undefined}>
						{column}
					</TableHead>
				))}
				<TableHead className="w-8">
					<span className="sr-only">Actions</span>
				</TableHead>
			</TableRow>
		</TableHeader>
	);
}

/**
 * The projects area's placeholder.
 *
 * - `count` is how many projects the answer will have when the caller knows (the route skeleton
 *   reads the shell's cached list); `undefined` draws {@link UNKNOWN_PROJECT_PLACEHOLDERS}.
 * - `count === 0` draws the first-run panel's height in plain bars, with no frame and no empty
 *   copy: a pending page must not say there is nothing (RUBRIC B3).
 * - `view` is the table view when the caller knows it; the route skeleton does not, and draws cards.
 *
 * It sets no `aria-busy` of its own: the skeleton root or the pending region around it does.
 */
export function ProjectsSkeleton({ count, view = "card" }: { count: number | undefined; view?: ViewMode }) {
	if (count === 0) {
		return (
			<div className="flex flex-col items-center justify-center gap-6 p-6 md:p-12" data-testid="projects-empty-skeleton">
				<div className="flex flex-col items-center gap-2">
					<Skeleton className="mb-2 size-10 rounded-lg" />
					<Skeleton className="h-7 w-40" />
					<div className="flex flex-col items-center gap-1">
						<Skeleton className="h-5 w-72 max-w-full" />
						<Skeleton className="h-5 w-56 max-w-full" />
					</div>
				</div>
				<Skeleton className="h-8 w-36" />
			</div>
		);
	}
	const placeholders = Math.min(count ?? UNKNOWN_PROJECT_PLACEHOLDERS, MAX_PROJECT_PLACEHOLDERS);
	if (view === "table") {
		return (
			<div className="overflow-x-auto rounded-xl border border-border/60">
				<Table>
					<ProjectTableHeader />
					<TableBody>
						{Array.from({ length: placeholders }, (_, row) => (
							<TableRow key={row} className="hover:bg-transparent" data-testid="project-row-skeleton">
								{PROJECT_TABLE_COLUMNS.map((column) => (
									<TableCell key={column}>
										<Skeleton className={column === "Project" ? "h-5 w-40" : "h-5 w-14"} />
									</TableCell>
								))}
								<TableCell />
							</TableRow>
						))}
					</TableBody>
				</Table>
			</div>
		);
	}
	return (
		<div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(238px,1fr))]">
			{Array.from({ length: placeholders }, (_, i) => (
				<Skeleton key={i} className="h-32 w-full rounded-lg" data-testid="project-card-skeleton" />
			))}
		</div>
	);
}
