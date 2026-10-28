// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { JobsListSkeleton } from "@/components/jobs/jobs-skeleton";

/**
 * Instant skeleton while a project's jobs route prefetches. The project's list has no Project
 * facet and no Project column, so neither does this — the org route's skeleton has one of each,
 * which is why this file no longer re-exports it.
 */
export default function ProjectJobsLoading() {
	return <JobsListSkeleton showProject={false} />;
}
