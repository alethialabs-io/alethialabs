// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { notFound } from "next/navigation";
import { resolveProjectId } from "@/app/server/actions/resolve";
import { ProjectDetailView } from "@/components/project-detail/project-detail-view";

/** `/{org}/{project}` — project (project) detail by slug (its default environment). */
export default async function ProjectSlugPage({
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
	return <ProjectDetailView projectId={projectId} />;
}
