// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { OverviewSkeleton } from "@/components/overview/overview-skeleton";

/**
 * Instant skeleton shown while the org overview prefetches on the server — the page's own layout,
 * so nothing moves when it answers (RUBRIC B2): the filter bar's row, then the two columns. The left
 * column is the three cards' OWN pending renders; the right is the "Projects" heading and the
 * projects area. How many rows, cards and which card shapes it draws come from the shell's cached
 * reads, which the `[org]` layout already holds when this renders (#6347) — see `OverviewSkeleton`.
 */
export default function OverviewLoading() {
	return <OverviewSkeleton />;
}
