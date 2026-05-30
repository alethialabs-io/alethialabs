import { getIntegrationsWithStatus } from "@/app/server/actions/integrations";
import {
	getAwsConnectionStatus,
	getAwsExternalId,
} from "@/app/(private)/dashboard/providers/actions";
import {
	getGcpConnectionStatus,
	initGcpIdentity,
} from "@/app/(private)/dashboard/providers/gcp-actions";
import { IntegrationsPage } from "@/components/integrations/integrations-page";

export default async function IntegrationsRoute() {
	const [integrations, awsStatus, gcpStatus] = await Promise.all([
		getIntegrationsWithStatus(),
		getAwsConnectionStatus(),
		getGcpConnectionStatus(),
	]);

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
			/>
		</div>
	);
}
