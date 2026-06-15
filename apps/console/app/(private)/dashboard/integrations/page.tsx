// SPDX-FileCopyrightText: 2026 Alethia OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { getIntegrationsWithStatus } from "@/app/server/actions/integrations";
import { getValidProviderToken } from "@/app/server/actions/identities";
import {
	getAwsConnectionStatus,
	getAwsExternalId,
} from "@/app/(private)/dashboard/providers/actions";
import {
	getGcpConnectionStatus,
	initGcpIdentity,
} from "@/app/(private)/dashboard/providers/gcp-actions";
import {
	getAzureConnectionStatus,
	initAzureIdentity,
} from "@/app/(private)/dashboard/providers/azure-actions";
import { IntegrationsPage } from "@/components/integrations/integrations-page";
import type { PublicGitProvider } from "@/lib/validations/db.schemas";

export default async function IntegrationsRoute() {
	let [integrations, awsStatus, gcpStatus, azureStatus] =
		await Promise.all([
			getIntegrationsWithStatus(),
			getAwsConnectionStatus(),
			getGcpConnectionStatus(),
			getAzureConnectionStatus(),
		]);

	// Attempt auto-refresh for expired git tokens
	const expiredGitIntegrations = integrations.filter(
		(i) => i.category === "git" && i.token_health === "expired",
	);
	if (expiredGitIntegrations.length > 0) {
		await Promise.all(
			expiredGitIntegrations.map((i) =>
				getValidProviderToken(i.slug as PublicGitProvider).catch(() => null),
			),
		);
		// Re-fetch to reflect updated health
		integrations = await getIntegrationsWithStatus();
	}

	let awsSetup: { externalId: string; identityId: string } | null = null;
	if (!awsStatus.connected) {
		try {
			awsSetup = await getAwsExternalId();
		} catch {}
	}

	let gcpSetup: { identityId: string } | null = null;
	if (!gcpStatus.connected) {
		try {
			gcpSetup = await initGcpIdentity();
		} catch {}
	}

	let azureSetup: { identityId: string } | null = null;
	if (!azureStatus.connected) {
		try {
			azureSetup = await initAzureIdentity();
		} catch {}
	}

	return (
		<div className="space-y-8">
			<div>
				<h1 className="text-2xl font-semibold tracking-tight text-foreground">
					Integrations
				</h1>
				<p className="text-sm text-muted-foreground mt-1">
					Connect your cloud and Git accounts to manage
					infrastructure and repositories.
				</p>
			</div>

			<IntegrationsPage
				integrations={integrations}
				awsSetup={awsSetup}
				gcpSetup={gcpSetup}
				azureSetup={azureSetup}
			/>
		</div>
	);
}
