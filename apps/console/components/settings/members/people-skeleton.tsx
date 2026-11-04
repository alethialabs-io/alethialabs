// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// No "use client": the people & access routes' `loading.tsx` render this, and they are server
// components.

import { PageToolbarSkeleton } from "@repo/ui/page-toolbar";
import { Skeleton } from "@repo/ui/skeleton";
import { DataTableSkeleton } from "@/components/skeletons/data-table-skeleton";

/**
 * The loading form of a people & access list (members, teams, access), in the order and the boxes
 * the page renders (#6129, RUBRIC B2):
 *
 * - the toolbar — a result count, ONE line of description, and `actions` buttons;
 * - the filter bar — the search box (`w-[240px] max-w-[380px] flex-1`, as every one of these
 *   pages sizes it) and one `h-8` control per facet;
 * - the table, with the real table's column count.
 *
 * `lead` draws the Access page's inheritance note above the toolbar, which it renders whatever the
 * entitlement (see `AccessNoteSkeleton`).
 */
export function PeopleListSkeleton({
	facets,
	columns,
	actions = 1,
	rows = 6,
	lead = false,
}: {
	facets: number;
	columns: number;
	actions?: number;
	rows?: number;
	lead?: boolean;
}) {
	return (
		<div aria-busy>
			{lead && <AccessNoteSkeleton />}
			<PageToolbarSkeleton className="mb-4" count actions={actions} />
			<div aria-hidden className="mb-4 flex flex-wrap items-center gap-2.5">
				<Skeleton className="h-8 w-[240px] max-w-[380px] flex-1 rounded-md" />
				{Array.from({ length: facets }, (_, i) => (
					<Skeleton key={i} className="h-8 w-28 rounded-md" />
				))}
			</div>
			<DataTableSkeleton columns={columns} rows={rows} />
		</div>
	);
}

/**
 * The Access page's inheritance note in its loading form: the note's own box — `p-4`, a border, the
 * sunken fill, the 16px info icon — around ONE line of its `text-ui-sm leading-relaxed` copy, which
 * is what the note wraps to at the console's content width (#6320). It used to be a 74px filled box,
 * 20px taller than the note, which also made it a "block" that the audit matched against the panel
 * below the note rather than the note itself (score ~0.08 on both Access routes).
 */
function AccessNoteSkeleton() {
	return (
		<div aria-hidden className="mb-[18px] flex gap-3 rounded-lg border border-border bg-surface-sunken p-4">
			<Skeleton className="mt-0.5 size-4 shrink-0 rounded-full" />
			<div className="flex h-[1lh] flex-1 items-center text-ui-sm leading-relaxed">
				<Skeleton className="h-3 w-3/4" />
			</div>
		</div>
	);
}

/**
 * The upsell panel (`FeatureUpsell`, an `EmptyState`) in its loading form, box for box (#6320): the
 * dashed, sunken frame with the same padding, the 40px icon tile, the title's line, two lines of
 * blurb and the "Available on …" line, and the two `sm` buttons. It used to be a flat 260px box
 * against the panel's ~319px, so everything below the panel moved when it landed.
 */
function FeatureUpsellSkeleton() {
	return (
		<div
			aria-hidden
			className="flex min-w-0 flex-col items-center justify-center gap-6 rounded-lg border border-dashed border-border bg-surface-sunken p-6 md:p-12"
		>
			<div className="flex max-w-sm flex-col items-center gap-2">
				<Skeleton className="mb-2 size-10 rounded-lg" />
				<div className="flex h-7 items-center">
					<Skeleton className="h-4 w-40" />
				</div>
				<div className="flex w-full flex-col items-center text-sm/relaxed">
					<div className="flex h-[1lh] w-full items-center justify-center">
						<Skeleton className="h-3 w-80 max-w-full" />
					</div>
					<div className="flex h-[1lh] w-full items-center justify-center">
						<Skeleton className="h-3 w-56" />
					</div>
					<div className="mt-2 flex h-[1lh] items-center text-ui-sm">
						<Skeleton className="h-3 w-44" />
					</div>
				</div>
			</div>
			<div className="flex items-center gap-2">
				<Skeleton className="h-8 w-28" />
				<Skeleton className="h-8 w-24" />
			</div>
		</div>
	);
}

/**
 * The loading form of a gated people & access page whose body, for an org without the plan, is the
 * upsell panel (F021): the toolbar when the page keeps one (Teams keeps its disabled Create team),
 * and the panel — never a filter bar or a table the page will not draw.
 */
export function PeopleUpsellSkeleton({
	toolbar = true,
	lead = false,
}: {
	toolbar?: boolean;
	lead?: boolean;
}) {
	return (
		<div aria-busy>
			{lead && <AccessNoteSkeleton />}
			{toolbar && <PageToolbarSkeleton className="mb-4" count actions={1} />}
			<FeatureUpsellSkeleton />
		</div>
	);
}
