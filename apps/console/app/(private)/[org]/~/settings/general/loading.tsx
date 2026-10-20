// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { SettingsColumnsSkeleton } from "@/components/skeletons/page-skeletons";

/**
 * Instant skeleton for the settings/general route: the two-up profile and defaults sections the
 * page renders through `SettingsColumns`, with no title above them.
 */
export default function GeneralLoading() {
	return <SettingsColumnsSkeleton sections={[4, 3]} />;
}
