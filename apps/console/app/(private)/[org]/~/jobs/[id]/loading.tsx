// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { SectionHeading } from "@repo/ui/section-heading";
import { Skeleton } from "@repo/ui/skeleton";

import { JOB_DETAIL_COLUMN, JOB_DETAIL_SECTIONS, JOB_VIEWPORT_HEIGHT } from "./detail-column";

/** A run of placeholder text: the words are there to give the line its real width, and are not shown. */
function TextBar({ children }: { children: string }) {
	return (
		<span data-slot="skeleton" className="animate-pulse rounded-md bg-accent text-transparent">
			{children}
		</span>
	);
}

/**
 * Instant skeleton for a single job.
 *
 * The job view is a full-height log surface: a status header bar, the streamed log column, and the
 * job's facts under it. It breaks out of the shell padding with the same negative margins the page
 * uses, so the swap does not shift.
 *
 * FOR MOST OF ITS LIFE THIS FILE WAS NOT WHAT A NAVIGATION PAINTED (#6350). `~/jobs/loading.tsx`
 * wraps every segment under `~/jobs`, this one included, so the first thing a navigation to a job
 * showed was the jobs LIST skeleton — a filter bar over a table — and only then this. The list's
 * page and skeleton now live in the `(list)` route group, where their boundary wraps the list alone.
 *
 * THE LOG PANE IS `flex-1`, so its two edges are set by what sits above and below it, and both are
 * drawn here from what the page draws rather than from a guess:
 *
 * - above it, the status row and the outcome line. Every finished job states an outcome under its
 *   status, and the placeholder is the one-line form (`JobOutcome`'s plain sentence). A job still
 *   running has none, and a failure box is taller; those swaps move the log's top edge, which is
 *   the one shape a skeleton drawn before the job is known cannot be right about;
 * - below it, one row per `JOB_DETAIL_SECTIONS` title, drawn with the page's own `SectionHeading`
 *   at the page's `py-2.5`. The page draws all three for every job, so this strip is exact.
 *
 * IT IMPORTS THE PAGE'S COLUMN WIDTH RATHER THAN REPEATING IT. RUBRIC.md's S3 asks whether the
 * skeleton is the same width as the page, and the first version of this file answered yes by
 * hard-coding the layout the page had that day — which is an answer that goes stale silently the
 * next time the page moves. One literal, two importers (`detail-column.ts`), and the predicate
 * cannot be passed by a skeleton that is no longer the page's shape.
 */
export default function JobDetailLoading() {
	return (
		<div
			aria-busy
			data-slot="job-detail-skeleton"
			className={`-m-4 flex flex-col sm:-m-6 lg:-m-8 xl:-m-10 ${JOB_VIEWPORT_HEIGHT}`}
		>
			{/* Status header — icon, status pill + meta, and the action buttons; then the outcome. */}
			<div aria-hidden className="shrink-0 border-b border-border/40 bg-muted/5 px-6 py-4">
				<div className={JOB_DETAIL_COLUMN}>
					<div className="flex items-start gap-3">
						<Skeleton className="mt-0.5 size-5 shrink-0 rounded-sm" />
						<div className="min-w-0 flex-1 space-y-2">
							<div className="flex flex-wrap items-center gap-2">
								<Skeleton className="h-4 w-20 rounded-full" />
								<Skeleton className="h-3 w-12" />
								<Skeleton className="h-3 w-16" />
								<Skeleton className="h-3 w-28" />
							</div>
						</div>
						<Skeleton className="h-8 w-24 shrink-0 rounded-md" />
					</div>
					{/* `JobOutcome`'s one-line form, in its own box: `mt-3`, the `text-ui-md` line, a
					    `size-4` icon. A `div`, not the page's `p`: a skeleton block inside a `p` is
					    invalid nesting, which React reports as a hydration error. */}
					<div data-slot="job-outcome-skeleton" className="mt-3 flex items-center gap-2 text-ui-md">
						<Skeleton className="size-4 shrink-0 rounded-full" />
						<TextBar>Job completed successfully.</TextBar>
					</div>
				</div>
			</div>

			{/* Log column — line number, timestamp, message, at decreasing fill. Full width, like
			    the pane it stands in for: it is the one region that does not obey the column above. */}
			<div aria-hidden className="flex-1 space-y-1.5 overflow-hidden bg-muted/20 p-6">
				{["w-3/4", "w-2/3", "w-5/6", "w-1/2", "w-4/6", "w-3/5", "w-2/5", "w-3/4"].map(
					(w, i) => (
						<div key={i} className="flex gap-4">
							<Skeleton className="h-3 w-8 shrink-0" />
							<Skeleton className="h-3 w-[85px] shrink-0" />
							<Skeleton className={`h-3 ${w}`} />
						</div>
					),
				)}
			</div>

			{/* The detail sections, back inside the column: one row per title the page draws, each
			    the page's own heading at the page's padding, so a row is exactly as tall as the
			    disclosure that replaces it. */}
			<div aria-hidden className="shrink-0 border-t border-border/40 px-6">
				<div className={JOB_DETAIL_COLUMN}>
					{JOB_DETAIL_SECTIONS.map((title) => (
						<div key={title} data-slot="job-detail-section-skeleton" className="border-b border-border/40 last:border-b-0">
							<SectionHeading
								className="py-2.5"
								level={2}
								title={
									// Spans only: this sits inside the heading, which takes phrasing content.
									<span className="flex items-center gap-2">
										<span data-slot="skeleton" className="size-3 shrink-0 animate-pulse rounded-md bg-accent" />
										<TextBar>{title}</TextBar>
									</span>
								}
							/>
						</div>
					))}
				</div>
			</div>
		</div>
	);
}
