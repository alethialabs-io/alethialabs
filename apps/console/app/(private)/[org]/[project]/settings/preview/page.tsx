// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { notFound } from "next/navigation";
import {
	getPreviewConfig,
	listProjectFabrics,
	listProjectGitCredentials,
} from "@/app/server/actions/preview";
import { resolveProjectId } from "@/app/server/actions/resolve";
import { PreviewSettings } from "@/components/settings/preview/preview-settings";
import { getGitlabBaseUrl } from "@/lib/config/auth";
import { pageMetadata } from "@/lib/seo/page-metadata";

export const metadata = pageMetadata({
	title: "Preview environments - Settings",
	description: "Configure pull request preview environments for this project.",
});

/** `/{org}/{project}/settings/preview` - PR-preview generator settings. */
export default async function ProjectPreviewSettingsPage({
	params,
}: {
	params: Promise<{ project: string }>;
}) {
	const { project } = await params;
	let projectId: string;
	try {
		projectId = await resolveProjectId(project);
	} catch {
		notFound();
	}

	const [initialConfig, fabrics, gitCredentials] = await Promise.all([
		getPreviewConfig(projectId),
		listProjectFabrics(projectId),
		listProjectGitCredentials(projectId),
	]);

	return (
		<PreviewSettings
			projectId={projectId}
			initialConfig={initialConfig}
			fabrics={fabrics}
			gitCredentials={gitCredentials}
			gitlabBaseUrl={getGitlabBaseUrl()}
		/>
	);
}
