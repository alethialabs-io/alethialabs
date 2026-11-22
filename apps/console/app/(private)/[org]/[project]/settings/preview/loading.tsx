// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { PreviewRouteSkeleton } from "@/components/settings/preview/preview-route-skeleton";

/**
 * Instant skeleton for the project Preview environments settings page, in its final shape: the one
 * Preview environments section with its Save band, and no title (the breadcrumb names the page).
 * Synchronous (CON-M4): the Source row's layout comes from the cached linked git accounts, not from
 * awaiting a read — see `preview-route-skeleton`.
 */
export default function PreviewSettingsLoading() {
	return <PreviewRouteSkeleton />;
}
