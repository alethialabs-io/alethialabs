// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { HydrationBoundary, dehydrate } from "@tanstack/react-query";
import { notFound } from "next/navigation";
import { resolveProjectId } from "@/app/server/actions/resolve";
import { ActivityLog } from "@/components/settings/activity/activity-log";
import { ActivityNoAccess } from "@/components/settings/activity/activity-no-access";
import { prefetchActivityFeed } from "@/components/settings/activity/activity-prefetch";
import { settledReadOf } from "@/components/settings/members/people-reads";
import { getQueryClient } from "@/lib/query/client";
import { paramReader } from "@/lib/query/filter-url-codec";
import { readActivityPermissions } from "@/lib/rpc/procedures/activity";
import { pageMetadata } from "@/lib/seo/page-metadata";

export const metadata = pageMetadata({
	title: "Activity · Project settings",
	description: "Every change made to this project, who made it, and when.",
});

/** `/{org}/{project}/settings/activity` — Activity scoped to this project. Resolves the project
 * slug → project id and hands it to the shared feed, which forces the project scope. A caller
 * without `activity:view_activity` gets the no-access notice (#3932); the feed hides export when
 * project-scoped, so no export decision is passed. The project's first page and the member list are
 * prefetched exactly as the org feed's are (#6129, B1). */
export default async function ProjectActivityPage({
	params,
	searchParams,
}: {
	params: Promise<{ org: string; project: string }>;
	searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
	const { project } = await params;
	let projectId: string;
	try {
		projectId = await resolveProjectId(project);
	} catch {
		notFound();
	}
	const { canView } = await readActivityPermissions();
	if (!canView) return <ActivityNoAccess />;

	const queryClient = getQueryClient();
	const { defaultWindow, forbidden } = await prefetchActivityFeed(
		queryClient,
		paramReader(await searchParams),
		projectId,
	);
	if (forbidden) return <ActivityNoAccess />;

	return (
		<HydrationBoundary state={dehydrate(queryClient, { shouldDehydrateQuery: settledReadOf("activity", "members") })}>
			<ActivityLog projectId={projectId} defaultWindow={defaultWindow} />
		</HydrationBoundary>
	);
}
