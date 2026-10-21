// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The Billing page's skeleton, in the page's shape (#6127, F008, RUBRIC B2) — rendered by the
// route's `loading.tsx` AND by the panel while its summary is pending, so the two are one shape.
// It used to be a generic two-box skeleton, and four or more titled sections replaced it.
//
// What it draws is what EVERY hosted org's page starts with: the current-plan card, the AI plan &
// usage card, and one section below. What follows (cards, charges, invoices) depends on whether a Stripe
// customer exists and on the viewer's permission, so it is not promised: content that appears
// BELOW the drawn shape moves nothing that was already on screen.
// No "use client": it renders from the route's loading file and from the panel.

import { Skeleton } from "@repo/ui/skeleton";

/** A settings section's title row: the heading, then the hairline rule. */
function SectionTitle() {
	return (
		<div className="mb-3 flex items-center gap-3">
			<Skeleton className="h-5 w-32" />
			<span className="h-px flex-1 bg-border" />
		</div>
	);
}

/** The Billing page's pending render. */
export function BillingSkeleton() {
	return (
		<div aria-busy="true">
			{/* Current plan: name + badges and tagline on the left, the price on the right, then the
			    sunken footer with the provider note and the plan action. */}
			<section className="mb-[18px]">
				<SectionTitle />
				<div className="overflow-hidden rounded-lg border border-border bg-surface shadow-sm">
					<div className="flex flex-wrap items-start justify-between gap-5 px-6 py-[22px]">
						<div className="flex flex-col gap-[9px]">
							<Skeleton className="h-7 w-40" />
							<Skeleton className="h-4 w-64" />
						</div>
						<div className="flex flex-col items-end gap-[3px]">
							<Skeleton className="h-7 w-28" />
							<Skeleton className="h-3 w-36" />
						</div>
					</div>
					<div className="flex items-center justify-between gap-4 border-t border-border px-6 py-[14px]">
						<Skeleton className="h-4 w-72" />
						<Skeleton className="h-8 w-28 rounded-md" />
					</div>
				</div>
			</section>

			{/* AI plan & usage: the plan row, then the session and weekly meters. */}
			<section className="mb-[18px]">
				<SectionTitle />
				<div className="overflow-hidden rounded-lg border border-border bg-surface shadow-sm">
					<div className="flex items-center justify-between gap-3 border-b border-border px-6 py-4">
						<div className="flex flex-col gap-1.5">
							<Skeleton className="h-5 w-28" />
							<Skeleton className="h-3 w-48" />
						</div>
						<Skeleton className="h-7 w-32 rounded-md" />
					</div>
					<div className="grid grid-cols-1 sm:grid-cols-2">
						{[0, 1].map((i) => (
							<div key={i} className="border-r border-border px-6 py-4 last:border-r-0">
								<div className="mb-[9px] flex items-baseline justify-between">
									<Skeleton className="h-3 w-24" />
									<Skeleton className="h-4 w-10" />
								</div>
								<Skeleton className="h-[5px] w-full rounded-full" />
								<Skeleton className="mt-2 h-3 w-32" />
							</div>
						))}
					</div>
				</div>
			</section>

			{/* The first section below (plan history, or payment methods once a customer exists). */}
			<section className="mb-[18px]">
				<SectionTitle />
				<div className="space-y-3 rounded-lg border border-border bg-surface p-5 shadow-sm">
					<Skeleton className="h-10 w-full" />
					<Skeleton className="h-10 w-full" />
				</div>
			</section>
		</div>
	);
}
