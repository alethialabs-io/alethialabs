// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { JobsListSkeleton } from "@/components/jobs/jobs-skeleton";

/** Instant skeleton while the org jobs route prefetches: the list's own shape, Project included. */
export default function JobsLoading() {
	return <JobsListSkeleton />;
}
