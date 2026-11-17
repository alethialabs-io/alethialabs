// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The General settings pages' non-data renders (#6128, RUBRIC B2/B4): the project page's skeleton in
// the form's final shape, and the refused render. With the error render (`RegionError`) they make four distinct
// answers — pending, refused, failed, data — so a failed or refused read never looks like a form
// that is still loading (F050: a `null` read used to draw a skeleton forever).
//
// No "use client": presentational, rendered by the route's `loading.tsx` (a server component) and
// by the client forms alike.

import { Skeleton } from "@repo/ui/skeleton";
import { cn } from "@repo/ui/utils";
import { RegionRefusal } from "@/components/errors/region-refusal";
import { SettingsPanel } from "@/components/settings/settings-ui";
import { SETTINGS_FIELD_ROW_CLASS } from "@/components/settings/settings-field-row";
import type { ReadRefusal } from "@/lib/rpc/refusal";

/**
 * One settings section as `SettingsSection` > `SettingsPanel` draws it: the heading with its rule,
 * a bordered panel of `fields` label | control rows, and — when `foot` — the `SettingsCardFoot`
 * band with its Save button.
 *
 * The panel IS `SettingsPanel` and each row takes `SETTINGS_FIELD_ROW_CLASS`, the form row's own
 * classes, so a row stacks below the panel's 32rem container step and is a `200px | 1fr` grid from
 * it exactly as the form's does (#6135). The heading, the danger row and the foot band still mirror
 * `components/settings/settings-ui.tsx` by hand, because those components take real text; change
 * one with the other.
 */
function SectionSkeleton({
	fields,
	foot,
	danger,
	className,
}: {
	fields: number;
	foot?: boolean;
	danger?: boolean;
	className?: string;
}) {
	return (
		<div className={cn("mb-[18px]", className)}>
			<div className="mb-3 flex items-center gap-3">
				<Skeleton className="h-4 w-36" />
				<span className="h-px flex-1 bg-border" />
			</div>
			<SettingsPanel danger={danger}>
				<div className={danger ? undefined : "py-1"}>
					{Array.from({ length: fields }, (_, f) =>
						danger ? (
							<div
								key={f}
								className="flex flex-wrap items-center justify-between gap-x-5 gap-y-3 border-b border-border px-[22px] py-4 last:border-b-0"
							>
								<div className="flex min-w-0 flex-[1_1_16rem] flex-col gap-1.5">
									<Skeleton className="h-3.5 w-36" />
									<Skeleton className="h-3 w-72 max-w-full" />
								</div>
								<Skeleton className="h-8 w-20 shrink-0 rounded-md" />
							</div>
						) : (
							<div key={f} data-slot="settings-field" className={SETTINGS_FIELD_ROW_CLASS}>
								<div data-slot="settings-field-label" className="flex flex-col gap-1.5">
									<Skeleton className="h-3.5 w-28" />
									<Skeleton className="h-3 w-40 max-w-full" />
								</div>
								<Skeleton className="h-[38px] min-w-0 rounded-sm" />
							</div>
						),
					)}
				</div>
				{foot ? (
					<div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t border-border bg-surface-sunken px-[22px] py-[13px]">
						<Skeleton className="h-3 w-32" />
						<Skeleton className="ml-auto h-8 w-28 rounded-md" />
					</div>
				) : null}
			</SettingsPanel>
		</div>
	);
}

/**
 * The project General page while its read is pending: Project profile (name, URL, classification)
 * with its Save band, then the one-row Danger zone.
 *
 * The org General and Preview environments pages draw their loading forms from their own
 * primitives and copy (`org-general-skeleton.tsx`, `preview/preview-settings-skeleton.tsx`).
 */
export function ProjectGeneralSkeleton() {
	return (
		<div data-slot="project-general-skeleton" aria-hidden>
			<SectionSkeleton fields={3} foot />
			<SectionSkeleton fields={1} danger className="mb-0" />
		</div>
	);
}

/**
 * The refused render of a General page: the console's one refused render
 * (`components/errors/region-refusal.tsx`), naming what was asked for as "these settings". An
 * expected answer, not a failure — a lock, no retry (the same question gets the same answer), and
 * `data-state="refused"` to tell it apart from the error render (`data-state="error"`) for a reader
 * and a test.
 */
export function GeneralRefusal({
	refusal,
	title,
	description,
}: {
	refusal: ReadRefusal;
	/** Overrides the refusal's default title, in the page's own terms. */
	title?: string;
	/** Overrides the refusal's default line. */
	description?: string;
}) {
	return (
		<RegionRefusal
			refusal={refusal}
			subject="these settings"
			title={title}
			description={description}
		/>
	);
}
