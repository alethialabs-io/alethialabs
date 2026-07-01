// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { notFound } from "next/navigation";
import { getVerifiedCloudIdentities } from "@/app/server/actions/aws/identities";
import { getConnectorsWithStatus } from "@/app/server/actions/connectors";
import { getProjectAsFormData } from "@/app/server/actions/projects";
import { resolveEnvironmentId, resolveProjectId } from "@/app/server/actions/resolve";
import { DesignProjectWorkbench } from "@/components/design-project/design-project-workbench";
import { ProjectAssistant } from "@/components/project-assistant/project-assistant";
import { pageMetadata } from "@/lib/seo/page-metadata";

/** Per-project tab title from the URL slug (kept cheap — no extra project fetch). */
export async function generateMetadata({
	params,
}: {
	params: Promise<{ org: string; project: string }>;
}) {
	const { project } = await params;
	return pageMetadata({
		title: project,
		description: "Design this project's multi-cloud infrastructure.",
	});
}

/**
 * `/{org}/{project}` — the project's design page. Loads the project as the workbench source so
 * its infrastructure can be (re)designed on the canvas/form. (Ported from the retired
 * `~/design-project` route; the project IS the design surface.)
 */
export default async function ProjectDesignPage({
	params,
	searchParams,
}: {
	params: Promise<{ org: string; project: string }>;
	searchParams: Promise<{ env?: string | string[] }>;
}) {
	const { project } = await params;
	const sp = await searchParams;
	const envName = typeof sp.env === "string" ? sp.env : undefined;
	let projectId: string;
	try {
		projectId = await resolveProjectId(project);
	} catch {
		notFound();
	}

	// The active environment (`?env=`) scopes which env's design loads; absent → the default env.
	const environmentId = envName
		? await resolveEnvironmentId(projectId, envName).catch(() => null)
		: null;

	const [identities, connectors, sourceProject] = await Promise.all([
		getVerifiedCloudIdentities(),
		getConnectorsWithStatus(),
		getProjectAsFormData(projectId, environmentId).catch(() => undefined),
	]);

	return (
		<>
			{/* Full-bleed canvas: cancel the AppShell padding and fill topbar→sidebar, no scroll. */}
			<div className="-m-4 h-[calc(100dvh-3.5rem)] overflow-hidden sm:-m-6 lg:-m-8 xl:-m-10">
				<DesignProjectWorkbench
					cloudIdentities={identities}
					connectors={connectors}
					sourceProject={sourceProject}
					projectId={projectId}
					envName={envName}
				/>
			</div>

			{/* Project-scoped assistant: scan→propose→design→plan/deploy with verification.
			    A Sheet (portal) driven by the shared store — opened from the canvas "AI" button. */}
			<ProjectAssistant projectId={projectId} />
		</>
	);
}
