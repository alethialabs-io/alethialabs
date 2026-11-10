// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { OrgGeneralSkeleton } from "@/components/settings/general/org-general-skeleton";

/**
 * Instant skeleton for the settings/general route, in the page's final shape: Organization profile
 * (five rows) beside Defaults (three), each with its Save band, then the Danger zone, and no title.
 * It is the form's own primitives over the form's own copy (`org-general-skeleton.tsx`, #6352), so
 * each row is as tall as the hint that sets its height.
 */
export default function GeneralLoading() {
	return <OrgGeneralSkeleton />;
}
