// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { getVerifiedCloudIdentities } from "@/app/server/actions/aws/identities";
import { getConnectorsWithStatus } from "@/app/server/actions/connectors";
import { getScanProposal } from "@/app/server/actions/scanner";
import { getProjectAsFormData } from "@/app/server/actions/projects";
import { DesignProjectWorkbench } from "@/components/design-project/design-project-workbench";

interface DesignProjectPageProps {
	searchParams: Promise<{ source?: string; scan?: string }>;
}

export default async function DesignProjectPage({ searchParams }: DesignProjectPageProps) {
	const { source, scan } = await searchParams;
	const [identities, connectors] = await Promise.all([
		getVerifiedCloudIdentities(),
		getConnectorsWithStatus(),
	]);

	let sourceProject: Awaited<ReturnType<typeof getProjectAsFormData>> | undefined;
	if (source) {
		try {
			sourceProject = await getProjectAsFormData(source);
		} catch {
			// Source project not found or unauthorized — proceed without pre-population
		}
	} else if (scan) {
		// Repo-analyzer handoff: open the scanner's proposed project for review.
		try {
			const res = await getScanProposal(scan);
			if (res.status === "READY") {
				const p = res.proposal.provider;
				sourceProject = {
					formData: res.proposal.proposedProject,
					provider: p === "gcp" || p === "azure" ? p : "aws",
				};
			}
		} catch {
			// Scan not ready / unauthorized — proceed without pre-population
		}
	}

	// Canvas is gated during rollout; when off the workbench renders only the form.
	const canvasEnabled = process.env.NEXT_PUBLIC_CANVAS_ENABLED === "true";

	return (
		<div className="w-full space-y-6">
			<div className="space-y-1.5">
				<h1 className="text-2xl sm:text-3xl font-semibold tracking-tight text-foreground">
					{sourceProject ? "Duplicate & Edit" : "Create a Project"}
				</h1>
				<p className="text-muted-foreground text-sm">
					{sourceProject
						? "Review and edit the converted project before creating."
						: "Configure your infrastructure components. Each section maps to a resource in your cloud account."}
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
