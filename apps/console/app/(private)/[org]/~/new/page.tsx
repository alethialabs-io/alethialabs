// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { getCollaborationAccess } from "@/app/server/actions/billing";
import { getScanProposal } from "@/app/server/actions/scanner";
import { ConfigureProject } from "@/components/create-project/configure-project";
import { CreateProjectForm } from "@/components/create-project/create-project-form";
import type { ScratchKind } from "@/components/create-project/start-from-scratch-cards";
import { isByoIacEnabled } from "@/lib/addons/byo-iac-flag";
import { isByoHelmEnabled } from "@/lib/addons/byo-flag";
import { getCloudConnectSetup } from "@/lib/connectors/cloud-connect-setup";
import { pageMetadata } from "@/lib/seo/page-metadata";
import { arrayIncludes } from "@/lib/type-guards";

export const metadata = pageMetadata({
	title: "New project",
	description: "Create a project to provision multi-cloud infrastructure.",
});

const SCRATCH_KINDS: readonly ScratchKind[] = [
	"template",
	"blank",
	"byo-helm",
	"byo-iac",
];

/**
 * `/{org}/~/new` — the two-step create flow.
 *  - **Step 1 (bare):** the source chooser — an Elench hero + Import a repository + Start from scratch.
 *  - **Step 2 (`?scan=<jobId>` or `?scratch=<kind>`):** the Configure screen — name, cloud + region,
 *    environments — which creates the project and opens its canvas.
 */
export default async function NewProjectPage({
	params,
	searchParams,
}: {
	params: Promise<{ org: string }>;
	searchParams: Promise<{ scan?: string | string[]; scratch?: string | string[] }>;
}) {
	const { org } = await params;
	const sp = await searchParams;
	const scanJobId = typeof sp.scan === "string" ? sp.scan : undefined;
	const scratch =
		typeof sp.scratch === "string" && arrayIncludes(SCRATCH_KINDS, sp.scratch)
			? sp.scratch
			: undefined;
	const byoHelmEnabled = isByoHelmEnabled();
	const byoIacEnabled = isByoIacEnabled();

	// Step 2 — Configure (import or scratch). Both funnel through the same screen.
	if (scanJobId || scratch) {
		const setup = await getCloudConnectSetup();
		const source = scanJobId
			? {
					kind: "import" as const,
					scanJobId,
					initial: await getScanProposal(scanJobId),
				}
			: { kind: "scratch" as const, scratch: scratch! };
		return (
			<ConfigureProject
				orgSlug={org}
				source={source}
				canManage={setup.canManage}
				integrations={setup.integrations}
				awsSetup={setup.awsSetup ?? null}
				gcpSetup={setup.gcpSetup ?? null}
				azureSetup={setup.azureSetup ?? null}
				extraSetup={setup.extraSetup}
				platformConfigured={setup.platformConfigured}
				byoHelmEnabled={byoHelmEnabled}
				byoIacEnabled={byoIacEnabled}
			/>
		);
	}

	// Step 1 — the source chooser.
	const collab = await getCollaborationAccess();
	return (
		<CreateProjectForm
			orgSlug={org}
			canCollaborate={collab.canInvite}
			byoHelmEnabled={byoHelmEnabled}
			byoIacEnabled={byoIacEnabled}
		/>
	);
}
