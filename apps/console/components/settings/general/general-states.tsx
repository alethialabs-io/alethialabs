// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The General settings pages' non-data renders (#6128, RUBRIC B2/B4): the skeleton in the form's
// final shape, and the refused render. With the error render (`RegionError`) they make four distinct
// answers — pending, refused, failed, data — so a failed or refused read never looks like a form
// that is still loading (F050: a `null` read used to draw a skeleton forever).
//
// No "use client": presentational, rendered by the route's `loading.tsx` (a server component) and
// by the client forms alike.

import { Lock } from "lucide-react";
import { EmptyState } from "@repo/ui/empty";
import { Skeleton } from "@repo/ui/skeleton";
import { cn } from "@repo/ui/utils";
import type { ReadRefusal } from "@/lib/rpc/refusal";

/**
 * One settings section as `SettingsSection` > `SettingsPanel` draws it: the heading with its rule,
 * a bordered panel of `fields` label | control rows, and — when `foot` — the `SettingsCardFoot`
 * band with its Save button. The classes mirror `components/settings/settings-ui.tsx` by hand,
 * because those components take real labels; change one with the other.
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
			<div
				className={cn(
					"@container rounded-lg border bg-surface shadow-sm",
					danger ? "border-border-strong" : "border-border",
				)}
			>
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
							<div
								key={f}
								className="flex flex-col gap-2 border-b border-border px-[22px] py-[15px] last:border-b-0 @lg:flex-row @lg:items-start @lg:gap-6"
							>
								{/* `SettingsField` stacks below 32rem of panel width and is a `200px 1fr`
								    grid from there (#6135); a fixed 200px column beside a flexible one
								    is the same geometry, and the panel above is the same container. */}
								<div className="flex flex-col gap-1.5 @lg:w-[200px] @lg:shrink-0">
									<Skeleton className="h-3.5 w-28" />
									<Skeleton className="h-3 w-40 max-w-full" />
								</div>
								<Skeleton className="h-[38px] w-full min-w-0 rounded-sm @lg:w-auto @lg:flex-1" />
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
			</div>
		</div>
	);
}

/**
 * The org General page while its read is pending: Organization profile (five rows) beside Defaults
 * (three rows), each with its Save band, then the two-row Danger zone — the page's final layout.
 */
export function OrgGeneralSkeleton() {
	return (
		<div data-slot="org-general-skeleton" aria-hidden>
			<div className="grid grid-cols-1 gap-x-6 lg:grid-cols-2">
				<SectionSkeleton fields={5} foot />
				<SectionSkeleton fields={3} foot />
			</div>
			<SectionSkeleton fields={2} danger className="mb-0" />
		</div>
	);
}

/**
 * The project General page while its read is pending: Project profile (name, URL, classification)
 * with its Save band, then the one-row Danger zone.
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
 * The project Preview environments page while its read is pending: the one Preview environments
 * section (Enable, Source, Placement, Credentials) with its Save band — no title above it.
 */
export function PreviewSettingsSkeleton() {
	return (
		<div data-slot="preview-settings-skeleton" aria-hidden>
			<SectionSkeleton fields={4} foot className="mb-0" />
		</div>
	);
}

const REFUSAL_COPY: Record<ReadRefusal, { title: string; description: string }> = {
	forbidden: {
		title: "You can't see these settings",
		description: "Your role in this organization doesn't include them. Ask an owner or admin.",
	},
	"not-found": {
		title: "Not found",
		description: "This no longer exists, or it isn't in this organization.",
	},
	plan: {
		title: "Not on this plan",
		description: "Your plan doesn't include these settings.",
	},
};

/**
 * The refused render of a General page: an expected answer, not a failure — a lock, no retry (the
 * same question gets the same answer), and `data-state="refused"` to tell it apart from the error
 * render (`data-state="error"`) for a reader and a test.
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
	const copy = REFUSAL_COPY[refusal];
	return (
		<EmptyState
			data-state="refused"
			data-refusal={refusal}
			className="border border-dashed border-border p-6 md:p-6"
			icon={<Lock size={18} aria-hidden />}
			title={title ?? copy.title}
			description={description ?? copy.description}
		/>
	);
}
