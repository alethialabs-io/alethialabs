// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The usage pages' skeleton, in the FINAL layout's shape (#6127, F008, RUBRIC B2). It used to be a
// generic two-box skeleton (`h-24` over `h-48`) on both the route and the panel, so the content that
// replaced it moved every section: four titled sections arrived where two grey boxes had been. This
// draws what the panels draw, section by section, and the route's `loading.tsx` and the panel's
// pending branch render the SAME component, so they cannot disagree with each other either.
// No "use client": it renders from the route's loading file (a server component) and from panels.

import type { ReactNode } from "react";
import { Skeleton } from "@repo/ui/skeleton";

/** A settings section's title row: the heading, then the hairline rule, then (maybe) an action. */
function SectionTitle({ action }: { action?: "picker" }) {
	return (
		<div className="mb-3 flex items-center gap-3">
			<Skeleton className="h-5 w-32" />
			<span className="h-px flex-1 bg-border" />
			{action === "picker" ? (
				<div className="flex gap-2">
					<Skeleton className="h-8 w-28 rounded-md" />
					<Skeleton className="h-8 w-40 rounded-md" />
				</div>
			) : null}
		</div>
	);
}

/** One gauge cell: label + value on a row, the 5px bar, the sub line. */
function MeterCell() {
	return (
		<div className="border-r border-border px-6 py-4 last:border-r-0">
			<div className="mb-[9px] flex items-baseline justify-between">
				<Skeleton className="h-3 w-20" />
				<Skeleton className="h-4 w-16" />
			</div>
			<Skeleton className="h-[5px] w-full rounded-full" />
			<Skeleton className="mt-2 h-3 w-32" />
		</div>
	);
}

/** One fact row: term on the left, value on the right. */
function FactRow() {
	return (
		<div className="flex items-baseline justify-between gap-4 border-b border-border px-6 py-[11px] last:border-b-0">
			<Skeleton className="h-4 w-40" />
			<Skeleton className="h-4 w-16" />
		</div>
	);
}

/** The card frame every usage section draws its content in. */
function Card({ children }: { children: ReactNode }) {
	return (
		<div className="mb-[18px] overflow-hidden rounded-lg border border-border bg-surface shadow-sm">
			{children}
		</div>
	);
}

/**
 * The org Usage page's shape: toolbar, Plan & limits (three gauges), Usage over time (pickers and
 * the chart card), Resources (three facts and a footnote), AI plan & usage (plan row, two gauges).
 * `scope="project"` draws what the project page has instead: its first section is two facts and a
 * footnote (a project has no quota to gauge), and it has no AI section.
 */
export function UsageSkeleton({ scope = "org" }: { scope?: "org" | "project" }) {
	return (
		<div className="space-y-2" aria-busy="true">
			{/* PageToolbar: one description line and one action, on a row. */}
			<div className="flex items-start justify-between gap-4 pb-2">
				<Skeleton className="h-4 w-64" />
				<Skeleton className="h-8 w-28 rounded-md" />
			</div>

			<section>
				<SectionTitle />
				<Card>
					{scope === "org" ? (
						<div className="grid grid-cols-1 sm:grid-cols-3">
							<MeterCell />
							<MeterCell />
							<MeterCell />
						</div>
					) : (
						<>
							<FactRow />
							<FactRow />
							<div className="border-t border-border px-6 py-[14px]">
								<Skeleton className="h-4 w-3/4" />
							</div>
						</>
					)}
				</Card>
			</section>

			<section>
				<SectionTitle action="picker" />
				<Card>
					<div className="p-5">
						<div className="mb-4 flex flex-wrap items-center justify-between gap-3">
							<div className="flex gap-1">
								<Skeleton className="h-7 w-28" />
								<Skeleton className="h-7 w-14" />
								<Skeleton className="h-7 w-20" />
							</div>
							<Skeleton className="h-4 w-36" />
						</div>
						<Skeleton className="h-28 w-full" />
					</div>
				</Card>
			</section>

			<section>
				<SectionTitle />
				<Card>
					<FactRow />
					<FactRow />
					<FactRow />
					<div className="border-t border-border px-6 py-[14px]">
						<Skeleton className="h-4 w-72" />
					</div>
				</Card>
			</section>

			{scope === "org" ? (
				<section>
					<SectionTitle />
					<Card>
						<div className="flex items-center justify-between gap-3 border-b border-border px-6 py-4">
							<div className="flex flex-col gap-1.5">
								<Skeleton className="h-5 w-28" />
								<Skeleton className="h-3 w-48" />
							</div>
							<Skeleton className="h-7 w-32 rounded-md" />
						</div>
						<div className="grid grid-cols-1 sm:grid-cols-2">
							<MeterCell />
							<MeterCell />
						</div>
					</Card>
				</section>
			) : null}
		</div>
	);
}
