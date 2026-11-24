// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// A hand-built `ActivityView` for the panel tests that render `ActivityPanel` from a fixed state
// rather than through `useActivityView` (tests/components/alerts/activity-keyset.test.tsx drives the
// real hook). The ledger is a keyset list since #7489, so the view's read state is the list's
// FIRST-PAGE state: `data` undefined while pending or failed, a page once answered.

import type { DeliveryDTO } from "@/app/server/actions/alerts";
import type { ActivityView } from "@/components/alerts/activity-view";

/** The first-page state a panel test wants to see rendered. */
export type ListState = "loading" | "error" | "ready";

/** An Activity view in `state`, with `rows` loaded and nothing further to page. */
export function activityViewOf(
	state: ListState,
	{
		rows = [],
		retry = () => {},
		universeEmpty = rows.length === 0,
	}: { rows?: DeliveryDTO[]; retry?: () => unknown; universeEmpty?: boolean } = {},
): ActivityView {
	const ready = state === "ready";
	return {
		list: {
			rows,
			facets: ready ? { status: [] } : null,
			universeEmpty: ready ? universeEmpty : null,
			query: {
				isLoading: state === "loading",
				isError: state === "error",
				data: ready ? { pages: [{ rows }], pageParams: [null] } : undefined,
				error: state === "error" ? new Error("boom") : null,
				refetch: retry,
			},
			isPending: !ready,
			isPlaceholderData: false,
			hasMore: false,
			loadingMore: false,
			loadMoreFailed: false,
			loadMore: () => {},
		},
		facets: { status: [] },
		stale: false,
		busy: !ready,
	};
}
