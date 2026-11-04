// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { ActivityFeedSkeleton } from "@/components/settings/activity/activity-skeleton";

/**
 * Instant skeleton for the settings/activity route, in the feed's own shape (#6129, B2): the
 * `Activity` heading and its count, the filter bar (search, the two range controls, User, Project,
 * Events, and Export on the right) and the month-grouped rows — not a table, which this page never
 * draws.
 */
export default function ActivityLoading() {
	return <ActivityFeedSkeleton facets={3} />;
}
