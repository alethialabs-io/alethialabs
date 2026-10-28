"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Settings · Classification in its loading form (#6320, RUBRIC B2), box for box against what the
// manager renders: the toolbar, then ONE of the manager's two bodies — the blank slate (a taxonomy
// with no dimensions: the heading, the explainer and the starter-template cards) or the master/detail
// (the dimension rail and the selected dimension's detail pane).
//
// WHICH BODY. A route skeleton is drawn before the taxonomy is read, and the two bodies share no
// geometry: the blank slate spans the content width, the detail pane starts 312px to its right. So
// the skeleton reads what the browser ALREADY holds — the unsearched taxonomy is the key every
// classification picker shares (`dimensionsInput()`), so a viewer who has met a picker this session
// has it — and draws that body with its real counts. With nothing cached it draws the blank slate:
// the state every org starts in, and the one this page is visited to leave. The skeleton used to
// draw the master/detail unconditionally, a 291px detail pane over a 532px blank slate (score 0.107
// against a 0.02 budget).
//
// Each line of text is a line BOX at its rung (`h-[1lh]` under the same `text-ui-*` and leading the
// real copy uses) with a bar inside it, so a line is exactly as tall as the line it stands for.

import { Skeleton } from "@repo/ui/skeleton";
import { cn } from "@repo/ui/utils";
import { useQueryClient } from "@tanstack/react-query";
import { useHydrated } from "@/hooks/use-hydrated";
import { dimensionsInput } from "@/lib/query/use-classification-query";
import { orpc } from "@/lib/rpc/client";
import { CLASSIFICATION_TEMPLATES } from "./classification-templates";

/** The most rail rows / value rows drawn: past this the real list runs below the fold anyway. */
const MAX_ROWS = 8;

/** The parts of a cached dimension the detail pane's shape depends on. */
interface DimShape {
	description?: string | null;
	values: readonly unknown[];
	resourceCount: number;
}

/** What the skeleton knows before the page answers: the cached taxonomy and edit decision, if any. */
interface Known {
	dims: readonly DimShape[] | undefined;
	canEdit: boolean;
}

/**
 * The cached unsearched taxonomy and edit decision. Read only once hydrated: on the server and in
 * the render that hydrates its HTML the cache cannot be assumed to agree (`useHydrated`, #5786), so
 * both draw the default; a soft navigation — the case a route skeleton is for — is past hydration
 * from its first render.
 */
function useKnown(): Known {
	const hydrated = useHydrated();
	const queryClient = useQueryClient();
	if (!hydrated) return { dims: undefined, canEdit: true };
	const dims = queryClient.getQueryData(orpc.classification.dimensions.queryKey({ input: dimensionsInput() }));
	const canEdit = queryClient.getQueryData(orpc.classification.canEdit.queryKey({ input: undefined }));
	return { dims, canEdit: canEdit ?? true };
}

/** The route skeleton: the toolbar, then the body (see the file header for which body). */
export function ClassificationSkeleton() {
	const { canEdit } = useKnown();
	return (
		<div aria-busy>
			<div aria-hidden className="mb-4 flex items-center gap-2.5">
				<Skeleton className="h-9 w-[240px] rounded-sm" />
				<Skeleton className="h-3 w-24" />
				<div className="flex-1" />
				<Skeleton className="size-9 rounded-sm" />
				{canEdit && <Skeleton className="h-8 w-32" />}
			</div>
			<ClassificationBodySkeleton />
		</div>
	);
}

/** The manager's body while the taxonomy is unknown — the blank slate or the master/detail. */
export function ClassificationBodySkeleton() {
	const { dims, canEdit } = useKnown();
	const first = dims?.[0];
	if (!dims || !first) return <BlankSlateSkeleton canEdit={canEdit} />;
	return (
		<div aria-hidden className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[296px_1fr]">
			<RailSkeleton rows={dims.length} />
			<DetailSkeleton dim={first} canEdit={canEdit} />
		</div>
	);
}

/** `TaxonomyBlankSlate`: the dashed frame, heading, three-line explainer, template cards, Create. */
function BlankSlateSkeleton({ canEdit }: { canEdit: boolean }) {
	return (
		<div
			aria-hidden
			data-testid="classification-skeleton-blank"
			className="rounded-md border border-dashed border-border-strong bg-surface px-[30px] py-[34px]"
		>
			<div className="max-w-[60ch]">
				<div className="mb-[7px] flex h-[1lh] items-center text-ui-lg">
					<Skeleton className="h-4 w-44" />
				</div>
				<div className="mb-[22px] text-ui-md leading-relaxed">
					{["w-full", "w-full", "w-2/3"].map((w, i) => (
						<div key={i} className="flex h-[1lh] items-center">
							<Skeleton className={cn("h-3", w)} />
						</div>
					))}
				</div>
			</div>
			{canEdit && (
				<>
					<div className="mb-5 grid grid-cols-1 gap-3 sm:grid-cols-2">
						{CLASSIFICATION_TEMPLATES.map((t) => (
							<div
								key={t.key}
								className="flex flex-col gap-2.5 rounded-[4px] border bg-surface-sunken px-4 py-[15px]"
							>
								<div className="flex h-[1lh] items-center justify-between text-ui-md">
									<Skeleton className="h-3 w-28" />
									<Skeleton className="h-3 w-12 rounded-full" />
								</div>
								<div className="min-h-[34px] text-ui-xs leading-relaxed">
									<div className="flex h-[1lh] items-center">
										<Skeleton className="h-2.5 w-4/5" />
									</div>
								</div>
								<div className="flex items-center justify-between gap-2.5">
									<Skeleton className="h-2.5 w-40" />
									<Skeleton className="h-8 w-28" />
								</div>
							</div>
						))}
					</div>
					<Skeleton className="h-9 w-44" />
				</>
			)}
		</div>
	);
}

/** `DimensionRail`: the header line, then one two-line row per dimension. */
function RailSkeleton({ rows }: { rows: number }) {
	return (
		<div className="rounded-lg border bg-surface p-1.5 shadow-sm">
			<div className="flex items-center justify-between px-2 pb-[7px] pt-2 text-ui-2xs">
				<div className="flex h-[1lh] items-center">
					<Skeleton className="h-2 w-20" />
				</div>
			</div>
			{Array.from({ length: Math.min(rows, MAX_ROWS) }, (_, i) => (
				<div key={i} className="flex items-center gap-2 px-2 py-2">
					<div className="min-w-0 flex-1">
						<div className="flex h-[1lh] items-center text-ui-md">
							<Skeleton className="h-3 w-28" />
						</div>
						<div className="flex h-[1lh] items-center text-ui-2xs">
							<Skeleton className="h-2 w-20" />
						</div>
					</div>
					<Skeleton className="h-6 w-8" />
				</div>
			))}
		</div>
	);
}

/**
 * `DimensionDetail` for the dimension the page opens on: the header (title, key line, the
 * description when it has one, the single/multi block), the values list with its real count, the
 * add-value row for an editor, and the coverage panel — its one-liner when nothing carries the
 * dimension, its chart otherwise.
 */
function DetailSkeleton({ dim, canEdit }: { dim: DimShape; canEdit: boolean }) {
	const values = Math.min(dim.values.length, MAX_ROWS);
	return (
		<div className="overflow-hidden rounded-lg border bg-surface shadow-sm">
			<div className="border-b px-5 pb-4 pt-[17px]">
				<div className="flex h-[1lh] items-center text-ui-lg">
					<Skeleton className="h-4 w-40" />
				</div>
				<div className="mt-1 flex h-[1lh] items-center text-ui-xs">
					<Skeleton className="h-2.5 w-56" />
				</div>
				{dim.description && (
					<div className="mt-2 flex h-[1lh] items-center text-ui-sm leading-relaxed">
						<Skeleton className="h-3 w-80 max-w-full" />
					</div>
				)}
				<div className="mt-3.5 border-t border-border-faint pt-3.5">
					<div className="flex h-[1lh] items-center text-ui-sm">
						<Skeleton className="h-3 w-48" />
					</div>
					<div className="mt-px flex h-[1lh] items-center text-ui-xs">
						<Skeleton className="h-2.5 w-64" />
					</div>
				</div>
			</div>
			<div className="px-2 py-1.5">
				<div className="flex items-center px-3 pb-2 pt-2.5 text-ui-xs">
					<div className="flex h-[1lh] items-center">
						<Skeleton className="h-2 w-16" />
					</div>
				</div>
				{values === 0 ? (
					<div className="px-3 py-2">
						<div className="flex h-[1lh] items-center text-ui-sm">
							<Skeleton className="h-3 w-48" />
						</div>
					</div>
				) : (
					Array.from({ length: values }, (_, i) => (
						<div key={i} className="flex items-center gap-2.5 px-3 py-2">
							<div className="w-[190px]">
								<div className="flex h-[1lh] items-center text-ui-md">
									<Skeleton className="h-3 w-28" />
								</div>
								<div className="flex h-[1lh] items-center text-ui-2xs">
									<Skeleton className="h-2 w-20" />
								</div>
							</div>
							<Skeleton className="h-[5px] max-w-[180px] flex-1 rounded-full" />
							<Skeleton className="h-6 w-24" />
						</div>
					))
				)}
				{canEdit && (
					<div className="px-3 pb-3 pt-2">
						<Skeleton className="h-8 w-full" />
					</div>
				)}
			</div>
			{dim.resourceCount === 0 ? (
				<div className="border-t bg-surface-sunken px-5 py-3.5">
					<div className="flex h-[1lh] items-center text-ui-xs">
						<Skeleton className="h-2.5 w-48" />
					</div>
				</div>
			) : (
				<div className="border-t bg-surface-sunken px-5 pb-[18px] pt-[15px]">
					<div className="mb-3 flex h-[1lh] items-center text-ui-2xs">
						<Skeleton className="h-2 w-40" />
					</div>
					<div className="grid grid-cols-1 gap-x-[26px] gap-y-2.5 sm:grid-cols-2">
						<div className="flex h-[1lh] items-center text-ui-sm">
							<Skeleton className="h-3 w-full" />
						</div>
						<div className="flex h-[1lh] items-center text-ui-sm">
							<Skeleton className="h-3 w-full" />
						</div>
					</div>
				</div>
			)}
		</div>
	);
}
