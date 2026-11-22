// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { ActivityFeedSkeleton } from "@/components/settings/activity/activity-skeleton";

/**
 * Instant skeleton for a project's settings/activity route, in the feed's own shape (R6 F-21): the
 * toolbar with the loaded-row count and one line — no Export, which the project feed does not offer
 * — the filter bar (search, the two range controls, User and Events: no Project facet, the feed is
 * already this project's) and the month-grouped rows. Without it the route fell back to the project
 * settings' generic two-bars-and-a-box skeleton.
 */
export default function ProjectActivityLoading() {
	return <ActivityFeedSkeleton facets={2} exportSlot={false} />;
}
