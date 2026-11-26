"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The route's `loading.tsx` (a server component) renders it with no props.

import { ListToolbarSkeleton } from "@repo/ui/list-toolbar";
import { SkeletonRoot } from "@/components/skeleton/skeleton-root";
import { DataTableSkeleton } from "@/components/skeletons/data-table-skeleton";
import { ENVIRONMENT_COLUMN_COUNT } from "./environment-status";

/** The min-height a full-region state of the Environments page takes: its refusal and its error. */
export const ENVIRONMENTS_REGION = "min-h-[60vh]";

/**
 * The Environments page while its read is in flight. The route's `loading.tsx` and the view's own
 * pending branch render THIS one component, so the two cannot drift apart (RUBRIC B2).
 *
 * It draws the page in the order and the boxes it renders: the one-row `ListToolbar` (the search,
 * the Stage and Status facets, and the two actions on the right — no count, no description line)
 * and the table with its real column count and ONE row. Every project starts with exactly its
 * default environment, and the skeleton cannot know the count, so it draws the common case.
 *
 * Synchronous: it reads nothing. It promises nothing that a project may not have: no notice, no
 * promotion panel, and no consistency matrix or promotion history. Those render only when there is
 * data for them.
 */
export function EnvironmentsSkeleton() {
	return (
		<SkeletonRoot className="space-y-8" data-skeleton="environments" inert>
			<ListToolbarSkeleton facets={2} actions={2} />
			<section className="space-y-4">
				<DataTableSkeleton columns={ENVIRONMENT_COLUMN_COUNT} rows={1} />
			</section>
		</SkeletonRoot>
	);
}
