// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { getActivityPermissions } from "@/app/server/actions/activity";
import { ActivityLog } from "@/components/settings/activity/activity-log";
import { ActivityNoAccess } from "@/components/settings/activity/activity-no-access";
import { pageMetadata } from "@/lib/seo/page-metadata";

export const metadata = pageMetadata({
	title: "Activity · Settings",
	description: "Recorded access decisions and audit history for your organization.",
});

/** Activity — the PDP's recorded access decisions. Viewable on every plan by a caller holding
 *  `activity:view_activity`; export additionally needs `activity:export_activity` and the
 *  Enterprise entitlement. The server actions enforce both; this only decides what to render. */
export default async function ActivityPage() {
	const { canView, canExport } = await getActivityPermissions();
	if (!canView) return <ActivityNoAccess />;
	return <ActivityLog exportPermitted={canExport} />;
}
