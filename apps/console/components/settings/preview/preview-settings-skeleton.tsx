// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The Preview environments page in loading form (#6335, RUBRIC B2), box for box against the form
// in `preview-settings.tsx`. It is rendered by the route's `loading.tsx` (a server component) and
// by the page's own pending branch, so there is no "use client" here.
//
// It is built from the form's own primitives (`SettingsSection`, `SettingsPanel`, `SettingsField`,
// `SettingsCardFoot`) with the form's own copy (`preview-copy.ts`). A row's height is set by its
// label column, where a two- or three-line hint wraps at 200px, and a hand-drawn bar of one line
// cannot know that. The earlier skeleton was four one-control rows, 372px against a 736px form,
// scored 0.028 against the 0.02 budget.
//
// The controls are bars, each in a LINE BOX at the rung the real control's text uses (`h-[1lh]`), or
// at the control's own fixed height (`h-[38px]` inputs, `h-9` selects).
//
// THE SOURCE ROW has two layouts: the "No Git accounts linked" panel or the repository row. The
// skeleton draws the one the viewer will get, from `linked`. The route reads the viewer's linked git
// accounts before it draws (see `loading.tsx`).

import { Skeleton } from "@repo/ui/skeleton";
import { RepositorySelectorSkeleton } from "@/components/repository-selector";
import {
	SettingsCardFoot,
	SettingsField,
	SettingsPanel,
	SettingsSection,
} from "@/components/settings/settings-ui";
import type { GitProvider } from "@/lib/db/schema";
import { PREVIEW_ROWS, PREVIEW_SAVE_NOTE, PREVIEW_SECTION_TITLE } from "./preview-copy";

/**
 * Whether the viewer has a git account linked, from the `projects.linkedGitProviders` answer.
 * `undefined` when there is no answer (the read failed or was never made). The skeleton then draws
 * the selector's row, which is what an unseeded selector shows while it reads the list itself.
 */
export function linkedFromProviders(
	providers: readonly GitProvider[] | undefined,
): boolean | undefined {
	return providers === undefined ? undefined : providers.length > 0;
}

/** A dashed note under a control, one line of `text-ui-sm`, as the form's notes are drawn. */
function NoteSkeleton() {
	return (
		<div className="rounded-sm border border-dashed border-border-strong bg-surface-sunken px-3 py-2 text-ui-sm">
			<div className="flex h-[1lh] items-center">
				<Skeleton className="h-3 w-3/4" />
			</div>
		</div>
	);
}

/**
 * The project Preview environments page while its read is pending: the one Preview environments
 * section (Enable, Source, Placement, Credentials) with its Save band, and no title above it.
 */
export function PreviewSettingsSkeleton({ linked }: { linked: boolean | undefined }) {
	return (
		<div data-slot="preview-settings-skeleton" aria-hidden>
			<SettingsSection title={PREVIEW_SECTION_TITLE} className="mb-0">
				<SettingsPanel>
					<div className="py-1">
						<SettingsField label={PREVIEW_ROWS.enable.label} hint={PREVIEW_ROWS.enable.hint}>
							<div className="flex items-center justify-between gap-4">
								<div className="flex min-w-0 items-center gap-2">
									<Skeleton className="h-5 w-20 shrink-0" />
									<div className="flex h-[1lh] items-center text-ui-sm">
										<Skeleton className="h-3 w-56 max-w-full" />
									</div>
								</div>
								<Skeleton className="h-[1.15rem] w-8 shrink-0 rounded-full" />
							</div>
						</SettingsField>

						<SettingsField label={PREVIEW_ROWS.source.label} hint={PREVIEW_ROWS.source.hint}>
							<RepositorySelectorSkeleton linked={linked} variant="settings" />
							<div className="flex min-h-[1lh] items-center gap-2 text-ui-xs">
								<Skeleton className="size-3.5 shrink-0" />
								<Skeleton className="h-3 w-24" />
							</div>
							<div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_160px]">
								<Skeleton className="h-[38px] rounded-sm" />
								<Skeleton className="h-[38px] rounded-sm" />
							</div>
						</SettingsField>

						<SettingsField
							label={PREVIEW_ROWS.placement.label}
							hint={PREVIEW_ROWS.placement.hint}
						>
							<Skeleton className="h-9 w-full" />
							<div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
								<Skeleton className="h-[38px] rounded-sm" />
								<Skeleton className="h-9" />
							</div>
							<NoteSkeleton />
						</SettingsField>

						<SettingsField
							label={PREVIEW_ROWS.credentials.label}
							hint={PREVIEW_ROWS.credentials.hint}
						>
							<Skeleton className="h-9 w-full" />
							<NoteSkeleton />
						</SettingsField>
					</div>
					<SettingsCardFoot note={PREVIEW_SAVE_NOTE}>
						<Skeleton className="h-8 w-28" />
					</SettingsCardFoot>
				</SettingsPanel>
			</SettingsSection>
		</div>
	);
}
