// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { notFound } from "next/navigation";
import { getVerifiedCloudIdentities } from "@/app/server/actions/aws/identities";
import { getConnectorsWithStatus } from "@/app/server/actions/connectors";
import { getProjectAsFormData } from "@/app/server/actions/projects";
import {
	resolveActiveEnvironmentId,
	resolveProjectId,
} from "@/app/server/actions/resolve";
import { DesignProjectWorkbench } from "@/components/design-project/design-project-workbench";
import { isByoHelmEnabled } from "@/lib/addons/byo-flag";
import { isByoIacEnabled } from "@/lib/addons/byo-iac-flag";
import { isByoDescribeEnabled } from "@/lib/addons/describe-flag";
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
 * `/{org}/{project}/architecture` — the project's Architecture view: the full-bleed design canvas.
 * The active environment (`?environment_id=`) scopes which env's design loads; an absent or
 * unresolvable id falls back to the project's default environment. This is the project's default
 * view (the bare `/{org}/{project}` redirects here).
 */
export default async function ProjectArchitecturePage({
	params,
	searchParams,
}: {
	params: Promise<{ org: string; project: string }>;
	searchParams: Promise<{ environment_id?: string | string[] }>;
}) {
	const { project } = await params;
	const sp = await searchParams;
	const envIdParam =
		typeof sp.environment_id === "string" ? sp.environment_id : undefined;
	let projectId: string;
	try {
		projectId = await resolveProjectId(project);
	} catch {
		notFound();
	}

	const environmentId = await resolveActiveEnvironmentId(
		projectId,
		envIdParam,
	).catch(() => null);

	const [identities, connectors, sourceProject] = await Promise.all([
		getVerifiedCloudIdentities(),
		getConnectorsWithStatus(),
		getProjectAsFormData(projectId, environmentId).catch(() => undefined),
	]);

	return (
		// The project shell (layout) owns the full-bleed height + the docked panel; the board fills it.
		<div className="h-full overflow-hidden">
			<DesignProjectWorkbench
				cloudIdentities={identities}
				connectors={connectors}
				sourceProject={sourceProject}
				projectId={projectId}
				environmentId={environmentId ?? undefined}
				dockInShell
				byoHelmEnabled={isByoHelmEnabled()}
				byoDescribeEnabled={isByoDescribeEnabled()}
				byoIacEnabled={isByoIacEnabled()}
			/>
		</div>
	);
}
