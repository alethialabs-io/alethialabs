// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { PreviewSettingsSkeleton } from "@/components/settings/general/general-states";

/**
 * Skeleton for the project Preview environments settings page, in its final shape: the one
 * Preview environments section with its Save band. No title — the page has none (the breadcrumb
 * names it), so a title-shaped placeholder made the page jump when it loaded.
 */
export default function PreviewSettingsLoading() {
	return <PreviewSettingsSkeleton />;
}
