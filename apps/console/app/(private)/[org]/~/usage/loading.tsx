// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { UsageSkeleton } from "@/components/settings/usage/usage-skeleton";

/**
 * Instant skeleton for the org usage route — the panel's own pending render, so the route skeleton
 * and the page it is replaced by have one shape (F008, RUBRIC B2): the toolbar, Plan & limits'
 * three gauges, the over-time card with its pickers, Resources, and the AI section.
 */
export default function UsageLoading() {
	return <UsageSkeleton />;
}
