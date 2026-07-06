// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { notFound } from "next/navigation";
import { resolveProjectId } from "@/app/server/actions/resolve";
import { AccessManager } from "@/components/settings/access/access-manager";
import { pageMetadata } from "@/lib/seo/page-metadata";

export const metadata = pageMetadata({
	title: "Access · Settings",
	description: "Access grants scoped to this project.",
});

/** `/{org}/{project}/settings/access` — Access grants scoped to this project. Resolves the project
 * slug → project id and hands it to the shared manager, which filters grants + fixes new-grant scope. */
export default async function ProjectAccessPage({
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
	return <AccessManager projectId={projectId} />;
}
