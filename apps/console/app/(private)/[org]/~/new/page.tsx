// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { getCloudConnectSetup } from "@/lib/connectors/cloud-connect-setup";
import { getCollaborationAccess } from "@/app/server/actions/billing";
import { CreateProjectForm } from "@/components/create-project/create-project-form";
import { pageMetadata } from "@/lib/seo/page-metadata";

export const metadata = pageMetadata({
	title: "New project",
	description: "Create a project to provision multi-cloud infrastructure.",
});

/** `/{org}/~/new` — the quick create-project form (agent hero + manual name/template/cloud). */
export default async function NewProjectPage({
	params,
}: {
	params: Promise<{ org: string }>;
}) {
	const { org } = await params;
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
