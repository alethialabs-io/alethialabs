// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { ListToolbarSkeleton } from "@repo/ui/list-toolbar";
import { CaseListSkeletonRows } from "@/components/support/cases/case-list-skeleton";

/**
 * Instant skeleton shown while the "My cases" route prefetches on the server. Mirrors the loaded
 * layout of `CaseList`: the one toolbar row (search, the two facet buttons, the three bucket chips,
 * then "Submit a case" on the right — `ListToolbar`'s row with its `mb-4`), and the bordered list of
 * case rows — so the swap to real data doesn't shift the page.
 */
export default function MyCasesLoading() {
	return (
		<div className="space-y-4">
			{/* The bucket chips sit between the facets and the actions; three chips are about two
			    facet buttons wide, so they count as two. */}
			<ListToolbarSkeleton facets={4} actions={1} />

			<CaseListSkeletonRows />
		</div>
	);
}
