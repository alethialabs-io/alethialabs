// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { notFound } from "next/navigation";
import { getProjectGeneral } from "@/app/server/actions/projects";
import { resolveProjectId } from "@/app/server/actions/resolve";
import { ProjectGeneral } from "@/components/settings/general/project-general";
import { pageMetadata } from "@/lib/seo/page-metadata";

export const metadata = pageMetadata({
	title: "General · Settings",
	description: "Rename or delete this project.",
});

/** `/{org}/{project}/settings/general` — the project's General settings (rename + delete). */
export default async function ProjectGeneralPage({
	params,
}: {
	params: Promise<{ org: string; project: string }>;
}) {
	const { org, project } = await params;
	let general: Awaited<ReturnType<typeof getProjectGeneral>>;
	try {
		const projectId = await resolveProjectId(project);
		general = await getProjectGeneral(projectId);
	} catch {
		notFound();
	}

	return (
		<ProjectGeneral
			projectId={general.id}
			orgSlug={org}
			initialName={general.project_name}
			slug={general.slug}
		/>
	);
}
