// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { getVerifiedCloudIdentities } from "@/app/server/actions/aws/identities";
import { getConnectorsWithStatus } from "@/app/server/actions/connectors";
import { getScanProposal } from "@/app/server/actions/scanner";
import { getCloudConnectSetup } from "@/lib/connectors/cloud-connect-setup";
import { getCollaborationAccess } from "@/app/server/actions/billing";
import { CreateProjectForm } from "@/components/create-project/create-project-form";
import { DesignProjectWorkbench } from "@/components/design-project/design-project-workbench";
import { ScanReviewNotice } from "@/components/create-project/scan-review-notice";
import { pageMetadata } from "@/lib/seo/page-metadata";

export const metadata = pageMetadata({
	title: "New project",
	description: "Create a project to provision multi-cloud infrastructure.",
});

/**
 * `/{org}/~/new` — create a project. Two entry paths:
 *  - `?scan=<jobId>`: a repo scan finished; seed the design workbench with the
 *    inferred project so the user reviews/edits before saving (the scan→design bridge).
 *  - otherwise: the quick create form (agent hero + manual name/template/cloud).
 */
export default async function NewProjectPage({
	params,
	searchParams,
}: {
	params: Promise<{ org: string }>;
	searchParams: Promise<{ scan?: string | string[] }>;
}) {
	const { org } = await params;
	const sp = await searchParams;
	const scanJobId = typeof sp.scan === "string" ? sp.scan : undefined;

	// Scan-review path: a finished scan's proposal seeds the workbench for review.
	if (scanJobId) {
		const result = await getScanProposal(scanJobId);
		if (result.status === "READY") {
			const [identities, connectors] = await Promise.all([
				getVerifiedCloudIdentities(),
				getConnectorsWithStatus(),
			]);
			return (
				<div className="w-full space-y-6">
					<div className="space-y-1.5">
						<h1 className="text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">
							Review proposed infrastructure
						</h1>
						<p className="text-sm text-muted-foreground">
							We scanned your repository and inferred the stack below. Review and edit it,
							then save to create the project.
						</p>
					</div>
					<DesignProjectWorkbench
						cloudIdentities={identities}
						connectors={connectors}
						sourceProject={{
							formData: result.proposal.proposedProject,
							provider: result.proposal.provider,
						}}
					/>
				</div>
			);
		}
		// PENDING / NEEDS_SETUP / NOT_FOUND — show status + a path forward, not the bare form.
		return <ScanReviewNotice org={org} result={result} />;
	}

	const [{ canManage, integrations, awsSetup, gcpSetup, azureSetup, extraSetup }, collab] =
		await Promise.all([getCloudConnectSetup(), getCollaborationAccess()]);

	return (
		<CreateProjectForm
			orgSlug={org}
			canManage={canManage}
			canCollaborate={collab.canInvite}
			integrations={integrations}
			awsSetup={awsSetup}
			gcpSetup={gcpSetup}
			azureSetup={azureSetup}
			extraSetup={extraSetup}
		/>
	);
}
