// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { OrgGeneralSkeleton } from "@/components/settings/general/general-states";

/**
 * Instant skeleton for the settings/general route, in the page's final shape: Organization profile
 * (five rows) beside Defaults (three), each with its Save band, then the Danger zone — no title.
 */
export default function GeneralLoading() {
	return <OrgGeneralSkeleton />;
}
