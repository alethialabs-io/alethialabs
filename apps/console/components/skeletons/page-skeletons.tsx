// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Reusable route-loading skeletons. Each route's `loading.tsx` composes the shapes that match its
// content so navigation shows instant structure during the server prefetch instead of a blank gap.
//
// The kit (#6117): `PageToolbarSkeleton` (`@repo/ui/page-toolbar`) for the row a page opens with,
// `DataTableSkeleton` (`./data-table-skeleton`) for a table, `SettingsColumnsSkeleton` below for a
// two-up settings page, and the panel shape below. A form draws its own loading form from its own
// layout (`AbuseFormSkeleton`, `SubmitCaseFormSkeleton`) — a generic field stack was 313px off one
// (#6354). There is no title skeleton: the console has no page titles, and a skeleton that draws
// one makes the page jump when it loads.

import { Skeleton } from "@repo/ui/skeleton";
import { SETTINGS_FIELD_ROW_CLASS } from "@/components/settings/settings-field-row";
import { SettingsPanel } from "@/components/settings/settings-ui";

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
 * The panel IS `SettingsPanel` (the query container) and each row takes `SETTINGS_FIELD_ROW_CLASS`,
 * the form row's own classes, so a row stacks below the panel's 32rem container step and is a
 * `200px | 1fr` grid from it, as `SettingsField` is (#6135). The heading mirrors `settings-ui.tsx`
 * by hand, because `SettingsSection` takes a real title. Change one with the other.
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
					<SettingsPanel>
						<div className="py-1">
							{Array.from({ length: fields }, (_, f) => (
								<div key={f} data-slot="settings-field" className={SETTINGS_FIELD_ROW_CLASS}>
									<div data-slot="settings-field-label" className="flex flex-col gap-1.5">
										<Skeleton className="h-3.5 w-28" />
										<Skeleton className="h-3 w-40 max-w-full" />
									</div>
									<Skeleton className="h-[38px] min-w-0 rounded-sm" />
								</div>
							))}
						</div>
					</SettingsPanel>
				</div>
			))}
		</div>
	);
}
