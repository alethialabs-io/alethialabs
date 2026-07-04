// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { getCloudConnectSetup } from "@/lib/connectors/cloud-connect-setup";
import { ConnectorsPage } from "@/components/connectors/connectors-page";
import { pageMetadata } from "@/lib/seo/page-metadata";

export const metadata = pageMetadata({
	title: "Connectors",
	description: "Connect AWS, GCP, and Azure cloud accounts to Alethia.",
});

export default async function ConnectorsRoute({
	params,
}: {
	params: Promise<{ org: string }>;
}) {
	const { org: orgSlug } = await params;

	const {
		canManage,
		integrations,
		awsSetup,
		gcpSetup,
		azureSetup,
		extraSetup,
		platformConfigured,
	} = await getCloudConnectSetup();

	return (
		<ConnectorsPage
			orgSlug={orgSlug}
			canManage={canManage}
			integrations={integrations}
			awsSetup={awsSetup}
			gcpSetup={gcpSetup}
			azureSetup={azureSetup}
			extraSetup={extraSetup}
			platformConfigured={platformConfigured}
		/>
	);
}
