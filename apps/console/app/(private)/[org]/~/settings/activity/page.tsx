// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { ActivityLog } from "@/components/settings/activity/activity-log";
import { pageMetadata } from "@/lib/seo/page-metadata";

export const metadata = pageMetadata({
	title: "Activity · Settings",
	description: "Recorded access decisions and audit history for your organization.",
});

/** Activity — the PDP's recorded access decisions. Viewable on every plan; export is Enterprise. */
export default function ActivityPage() {
	return <ActivityLog />;
}
