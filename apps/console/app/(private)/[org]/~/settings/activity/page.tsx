// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { HydrationBoundary, dehydrate } from "@tanstack/react-query";
import { ActivityLog } from "@/components/settings/activity/activity-log";
import { ActivityNoAccess } from "@/components/settings/activity/activity-no-access";
import { prefetchActivityFeed } from "@/components/settings/activity/activity-prefetch";
import { settledReadOf } from "@/components/settings/members/people-reads";
import { getQueryClient } from "@/lib/query/client";
import { paramReader } from "@/lib/query/filter-url-codec";
import { readActivityPermissions } from "@/lib/rpc/procedures/activity";
import { pageMetadata } from "@/lib/seo/page-metadata";

export const metadata = pageMetadata({
	title: "Activity · Settings",
	description: "Recorded access decisions and audit history for your organization.",
});

/**
 * `/{org}/~/settings/activity` — the PDP's recorded access decisions (#6129, the jobs slice's
 * shape). Viewable on every plan by a caller holding `activity:view_activity`; export additionally
 * needs `activity:export_activity` and the Enterprise entitlement — the reads and the export
 * enforce both, this only decides what to render. A caller without `view_activity` gets the
 * no-access render on the first paint (B4).
 *
 * The first page (for the link's filters, in the default window resolved HERE) and the member list
 * the feed names actors with are prefetched in-process, so the feed paints with rows and the
 * browser fetches nothing on mount (B1).
 */
export default async function ActivityPage({
	searchParams,
}: {
	params: Promise<{ org: string }>;
	searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
	const { canView, canExport, exportEntitled } = await readActivityPermissions();
	if (!canView) return <ActivityNoAccess />;

	const queryClient = getQueryClient();
	const { defaultWindow, forbidden } = await prefetchActivityFeed(queryClient, paramReader(await searchParams));
	if (forbidden) return <ActivityNoAccess />;

	return (
		<HydrationBoundary state={dehydrate(queryClient, { shouldDehydrateQuery: settledReadOf("activity", "members") })}>
			<ActivityLog exportPermitted={canExport} exportEntitled={exportEntitled} defaultWindow={defaultWindow} />
		</HydrationBoundary>
	);
}
