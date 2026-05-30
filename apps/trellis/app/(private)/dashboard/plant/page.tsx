import { getVerifiedCloudIdentities } from "@/app/server/actions/aws/identities";
import { PlantVineForm } from "@/components/plant-vine/plant-vine-form";

export default async function PlantPage() {
	const identities = await getVerifiedCloudIdentities();

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

			<PlantVineForm cloudIdentities={identities} />
		</div>
	);
}
