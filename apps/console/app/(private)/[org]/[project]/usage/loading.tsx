// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { UsageSkeleton } from "@/components/settings/usage/usage-skeleton";

/**
 * Skeleton for the project Usage view — the panel's own pending render in its project shape (two
 * facts where the org page has gauges, no AI section), so the route skeleton and the page that
 * replaces it cannot disagree (RUBRIC B2).
 */
export default function UsageLoading() {
	return <UsageSkeleton scope="project" />;
}
