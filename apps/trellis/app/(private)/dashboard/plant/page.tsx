import { getCachedAwsResources } from "@/app/server/actions/aws/resources";
import { getAwsConnectionStatus } from "@/app/(private)/dashboard/providers/actions";
import { PlantVineForm } from "@/components/plant-vine/plant-vine-form";

export default async function PlantPage() {
	const awsStatus = await getAwsConnectionStatus();

	let awsResources = null;
	if (awsStatus.connected && awsStatus.identityId) {
		try {
			awsResources = await getCachedAwsResources(awsStatus.identityId);
		} catch {}
	}

	return (
		<div className="w-full space-y-6">
			<div className="space-y-1.5">
				<h1 className="text-2xl sm:text-3xl font-semibold tracking-tight text-foreground">
					Plant a Vine
				</h1>
				<p className="text-muted-foreground text-sm">
					Configure your infrastructure components. Each section maps
					to a resource in your cloud account.
				</p>
			</div>

			<PlantVineForm
				cloudConnected={awsStatus.connected}
				cloudIdentityId={awsStatus.identityId}
				initialResources={awsResources}
			/>
		</div>
	);
}
