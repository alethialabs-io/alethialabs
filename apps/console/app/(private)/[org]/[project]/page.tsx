// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { notFound } from "next/navigation";
import { getVerifiedCloudIdentities } from "@/app/server/actions/aws/identities";
import { getConnectorsWithStatus } from "@/app/server/actions/connectors";
import { getProjectAsFormData } from "@/app/server/actions/projects";
import { resolveProjectId } from "@/app/server/actions/resolve";
import { DesignProjectWorkbench } from "@/components/design-project/design-project-workbench";
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

	const [identities, connectors, sourceProject] = await Promise.all([
		getVerifiedCloudIdentities(),
		getConnectorsWithStatus(),
		getProjectAsFormData(projectId).catch(() => undefined),
	]);

	// Canvas is gated during rollout; when off the workbench renders only the form.
	const canvasEnabled = process.env.NEXT_PUBLIC_CANVAS_ENABLED === "true";

	return (
		<div className="w-full space-y-6">
			<div className="space-y-1.5">
				<h1 className="text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">
					{sourceProject?.formData.project.project_name ?? "Design"}
				</h1>
				<p className="text-sm text-muted-foreground">
					Design this project&apos;s infrastructure. Each section maps to a resource in your
					cloud account.
				</p>
			</div>

			<DesignProjectWorkbench
				cloudIdentities={identities}
				connectors={connectors}
				sourceProject={sourceProject}
				canvasEnabled={canvasEnabled}
			/>
		</div>
	);
}
