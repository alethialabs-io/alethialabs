// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Reusable route-loading skeletons. Each route's `loading.tsx` composes the shapes that match its
// content so navigation shows instant structure during the server prefetch instead of a blank gap.
//
// The kit (#6117): `PageToolbarSkeleton` (`@repo/ui/page-toolbar`) for the row a page opens with,
// `DataTableSkeleton` (`./data-table-skeleton`) for a table, `SettingsColumnsSkeleton` below for a
// two-up settings page, and the form and panel shapes below. There is no title skeleton: the
// console has no page titles, and a skeleton that draws one makes the page jump when it loads.

import { Skeleton } from "@repo/ui/skeleton";

/** A form: N label + input rows, then a submit button. */
export function FormSkeleton({ fields = 4 }: { fields?: number }) {
	return (
		<div className="space-y-5">
			{Array.from({ length: fields }, (_, i) => (
				<div key={i} className="space-y-2">
					<Skeleton className="h-3.5 w-28" />
					<Skeleton className="h-9 w-full max-w-md rounded-md" />
				</div>
			))}
			<Skeleton className="h-9 w-32 rounded-md" />
		</div>
	);
}

/** A bordered panel: title bar + a few content lines. */
export function PanelSkeleton({ lines = 4 }: { lines?: number }) {
	return (
		<div className="rounded-lg border bg-card">
			<div className="border-b px-4 py-3">
				<Skeleton className="h-4 w-40" />
			</div>
			<div className="space-y-3 p-4">
				{Array.from({ length: lines }, (_, i) => (
					<Skeleton key={i} className="h-4 w-full" />
				))}
			</div>
		</div>
	);
}

/**
 * The loading form of a settings page built from `SettingsColumns` > `SettingsSection` >
 * `SettingsPanel` > `SettingsField` rows (`components/settings/settings-ui.tsx`).
 *
 * `sections` lists how many field rows each section's panel holds, in order, so the placeholder
 * takes the space the page will. Every section is drawn the way `SettingsSection` draws one: a
 * heading with a hairline rule beside it, then a bordered panel of label | control rows.
 *
 * The classes below mirror `settings-ui.tsx` by hand, because those components take real labels
 * and titles. Change one with the other.
 *
 * @example
 * <SettingsColumnsSkeleton sections={[3, 2]} />
 */
export function SettingsColumnsSkeleton({ sections = [3, 3] }: { sections?: number[] }) {
	return (
		<div data-slot="settings-columns-skeleton" aria-hidden className="grid grid-cols-1 gap-x-6 lg:grid-cols-2">
			{sections.map((fields, s) => (
				<div key={s} className="mb-[18px]">
					<div className="mb-3 flex items-center gap-3">
						<Skeleton className="h-4 w-36" />
						<span className="h-px flex-1 bg-border" />
					</div>
					<div className="rounded-lg border border-border bg-surface shadow-sm">
						<div className="py-1">
							{Array.from({ length: fields }, (_, f) => (
								<div
									key={f}
									className="flex items-start gap-6 border-b border-border px-[22px] py-[15px] last:border-b-0"
								>
									{/* `SettingsField` is a `200px 1fr` grid at every width; a fixed
									    200px column beside a flexible one is the same geometry. */}
									<div className="flex w-[200px] shrink-0 flex-col gap-1.5">
										<Skeleton className="h-3.5 w-28" />
										<Skeleton className="h-3 w-40 max-w-full" />
									</div>
									<Skeleton className="h-[38px] min-w-0 flex-1 rounded-sm" />
								</div>
							))}
						</div>
					</div>
				</div>
			))}
		</div>
	);
}
