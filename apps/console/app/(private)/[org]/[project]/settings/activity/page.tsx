// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { notFound } from "next/navigation";
import { getActivityPermissions } from "@/app/server/actions/activity";
import { resolveProjectId } from "@/app/server/actions/resolve";
import { ActivityLog } from "@/components/settings/activity/activity-log";
import { ActivityNoAccess } from "@/components/settings/activity/activity-no-access";
import { pageMetadata } from "@/lib/seo/page-metadata";

export const metadata = pageMetadata({
	title: "Activity · Project settings",
	description: "Every change made to this project, who made it, and when.",
});

/** `/{org}/{project}/settings/activity` — Activity scoped to this project (project). Resolves
 * the project slug → project id and hands it to the shared feed, which forces the project filter.
 * A caller without `activity:view_activity` gets the no-access notice (#3932); the feed hides
 * export when project-scoped, so no export decision is passed. */
export default async function ProjectActivityPage({
	params,
}: {
	params: Promise<{ org: string; project: string }>;
}) {
	const { project } = await params;
	let projectId: string;
	try {
		projectId = await resolveProjectId(project);
	} catch {
		notFound();
	}
	const { canView } = await getActivityPermissions();
	if (!canView) return <ActivityNoAccess />;
	return <ActivityLog projectId={projectId} />;
}
