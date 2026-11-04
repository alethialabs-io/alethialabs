// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The org General page in loading form (#6352, RUBRIC B2), box for box against the form in
// `org-general.tsx`. It is rendered by the route's `loading.tsx` (a server component) and by the
// page's own pending branch, so there is no "use client" here.
//
// It is built from the form's own primitives (`SettingsColumns`, `SettingsSection`, `SettingsPanel`,
// `SettingsField`, `SettingsCardFoot`, `SettingsDangerRow`) with the form's own copy
// (`org-general-copy.ts`). A row's height is set by whichever column is taller: the label column,
// where a hint wraps at 200px to two or three lines, or the control column, which is under 200px
// wide in the two-column layout. The earlier skeleton drew every row as a one-line label beside one
// 38px bar: its Organization profile panel came out about 100px short of the form's 515px, and its
// Danger zone, 131px, was scored against the profile panel the form had grown into (0.182 against
// the 0.02 budget, release-gate run 40822681524).
//
// The controls are bars at the real control's fixed height (`h-[38px]` inputs, `h-9` selects, the
// 64px textarea, the 56px avatar, `h-8` buttons). The two fixed notes under a control are the real
// text, because one of them wraps.

import { Skeleton } from "@repo/ui/skeleton";
import { cn } from "@repo/ui/utils";
import {
	SettingsCardFoot,
	SettingsColumns,
	SettingsDangerRow,
	SettingsField,
	SettingsPanel,
	SettingsSection,
} from "@/components/settings/settings-ui";
import {
	ORG_CONTROL_NOTES,
	ORG_DANGER_ROWS,
	ORG_DEFAULTS_ROWS,
	ORG_DEFAULTS_SAVE_NOTE,
	ORG_GENERAL_SECTIONS,
	ORG_PROFILE_ROWS,
	ORG_PROFILE_SAVE_NOTE,
} from "./org-general-copy";

/** A fixed note under a control, typeset as the form's (`font-mono text-ui-2xs`). */
function ControlNote({ children }: { children: string }) {
	return <span className="font-mono text-ui-2xs text-text-tertiary">{children}</span>;
}

/** A bar in one line box of `className`'s rung, as tall as one line of the text it stands for. */
function LineSkeleton({ className, bar }: { className: string; bar: string }) {
	return (
		<div className={cn("flex h-[1lh] items-center", className)}>
			<Skeleton className={cn("h-3", bar)} />
		</div>
	);
}

/**
 * The org General page while its read is pending: Organization profile (five rows) beside Defaults
 * (three rows), each with its Save band, then the two-row Danger zone, which is the page's final
 * layout. No title above it.
 */
export function OrgGeneralSkeleton() {
	return (
		<div data-slot="org-general-skeleton" aria-hidden>
			<SettingsColumns>
				<SettingsSection title={ORG_GENERAL_SECTIONS.profile}>
					<SettingsPanel>
						<div className="py-1">
							<SettingsField label={ORG_PROFILE_ROWS.logo.label} hint={ORG_PROFILE_ROWS.logo.hint}>
								{/* `OrgLogoUpload`: the 56px avatar beside its Upload button. */}
								<div className="flex items-center gap-4">
									<Skeleton className="size-14 shrink-0 rounded-lg" />
									<Skeleton className="h-8 w-28" />
								</div>
							</SettingsField>
							<SettingsField label={ORG_PROFILE_ROWS.name.label} hint={ORG_PROFILE_ROWS.name.hint}>
								<Skeleton className="h-[38px] rounded-sm" />
							</SettingsField>
							<SettingsField label={ORG_PROFILE_ROWS.slug.label} hint={ORG_PROFILE_ROWS.slug.hint}>
								<Skeleton className="h-[38px] rounded-sm" />
								<ControlNote>{ORG_CONTROL_NOTES.slug}</ControlNote>
							</SettingsField>
							<SettingsField
								label={ORG_PROFILE_ROWS.description.label}
								hint={ORG_PROFILE_ROWS.description.hint}
							>
								{/* The textarea's `min-h-16`: two rows of text and its padding fall under it. */}
								<Skeleton className="h-16 rounded-sm" />
							</SettingsField>
							<SettingsField label={ORG_PROFILE_ROWS.address.label} hint={ORG_PROFILE_ROWS.address.hint}>
								<LineSkeleton className="font-mono text-ui-xs" bar="w-3/4" />
							</SettingsField>
						</div>
						<SettingsCardFoot note={ORG_PROFILE_SAVE_NOTE}>
							<Skeleton className="h-8 w-28" />
						</SettingsCardFoot>
					</SettingsPanel>
				</SettingsSection>

				<SettingsSection title={ORG_GENERAL_SECTIONS.defaults}>
					<SettingsPanel>
						<div className="py-1">
							<SettingsField label={ORG_DEFAULTS_ROWS.region.label} hint={ORG_DEFAULTS_ROWS.region.hint}>
								<Skeleton className="h-9 w-full" />
								<ControlNote>{ORG_CONTROL_NOTES.region}</ControlNote>
							</SettingsField>
							<SettingsField
								label={ORG_DEFAULTS_ROWS.defaultEnv.label}
								hint={ORG_DEFAULTS_ROWS.defaultEnv.hint}
							>
								<Skeleton className="h-9 w-full" />
							</SettingsField>
							<SettingsField
								label={ORG_DEFAULTS_ROWS.terraformVersion.label}
								hint={ORG_DEFAULTS_ROWS.terraformVersion.hint}
							>
								<Skeleton className="h-[38px] rounded-sm" />
							</SettingsField>
						</div>
						<SettingsCardFoot note={ORG_DEFAULTS_SAVE_NOTE}>
							<Skeleton className="h-8 w-28" />
						</SettingsCardFoot>
					</SettingsPanel>
				</SettingsSection>
			</SettingsColumns>

			<SettingsSection title={ORG_GENERAL_SECTIONS.danger} className="mb-0">
				<SettingsPanel danger>
					<SettingsDangerRow
						title={ORG_DANGER_ROWS.transfer.title}
						description={ORG_DANGER_ROWS.transfer.description}
					>
						<Skeleton className="h-8 w-20" />
					</SettingsDangerRow>
					<SettingsDangerRow
						title={ORG_DANGER_ROWS.delete.title}
						description={
							<>
								{ORG_DANGER_ROWS.delete.before}{" "}
								{/* The org's name, which the form writes here: one word's width, inline. */}
								<Skeleton className="inline-block h-3 w-20 align-middle" />{" "}
								{ORG_DANGER_ROWS.delete.after}
							</>
						}
					>
						<Skeleton className="h-8 w-20" />
					</SettingsDangerRow>
				</SettingsPanel>
			</SettingsSection>
		</div>
	);
}
