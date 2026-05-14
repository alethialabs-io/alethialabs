import { ProvidersGrid } from "@/components/providers/providers-grid";
import {
	getAwsConnectionStatus,
	getAwsExternalId,
} from "./actions";

export default async function ProvidersPage() {
	const awsStatus = await getAwsConnectionStatus();

	let awsSetup: { externalId: string; identityId: string } | null = null;
	if (!awsStatus.connected) {
		try {
			awsSetup = await getAwsExternalId();
		} catch {
			// Will show error state in the UI
		}
	}

	return (
		<div className="space-y-8">
			<div>
				<h1 className="text-2xl font-semibold tracking-tight text-foreground">
					Providers
				</h1>
				<p className="text-sm text-muted-foreground mt-1">
					Connect your cloud accounts to provision and manage infrastructure.
				</p>
			</div>

			<ProvidersGrid
				awsStatus={awsStatus}
				awsSetup={awsSetup}
			/>
		</div>
	);
}
