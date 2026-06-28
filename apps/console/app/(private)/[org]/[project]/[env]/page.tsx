// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { notFound } from "next/navigation";
import { resolveProjectId } from "@/app/server/actions/resolve";
import { ProjectDetailView } from "@/components/project-detail/project-detail-view";

/** `/{org}/{project}/{env}` — project detail focused on a specific environment. */
export default async function ProjectEnvSlugPage({
	params,
}: {
	params: Promise<{ org: string; project: string; env: string }>;
}) {
	const { project, env } = await params;
	let projectId: string;
	try {
		projectId = await resolveProjectId(project);
	} catch {
		notFound();
	}
	return <ProjectDetailView projectId={projectId} envName={env} />;
}
