// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { ReactNode } from "react";
import { notFound } from "next/navigation";
import { getVerifiedCloudIdentities } from "@/app/server/actions/aws/identities";
import { resolveProjectId } from "@/app/server/actions/resolve";
import { ProjectShell } from "@/components/design-project/project-shell";

/**
 * The project workspace layout. Owns the docked panel (service inspector + AI assistant) so the
 * assistant persists across the project's views (Architecture / Environments / Jobs / …) — Next
 * keeps the layout mounted across route changes. The routed view renders in the shell's main area.
 */
export default async function ProjectLayout({
	children,
	params,
}: {
	children: ReactNode;
	params: Promise<{ org: string; project: string }>;
}) {
	const { project } = await params;
	let projectId: string;
	try {
		projectId = await resolveProjectId(project);
	} catch {
		notFound();
	}
	const identities = await getVerifiedCloudIdentities();

	return (
		<ProjectShell projectId={projectId} identities={identities}>
			{children}
		</ProjectShell>
	);
}
