import { getVerifiedCloudIdentities } from "@/app/server/actions/aws/identities";
import { getVineAsFormData } from "@/app/server/actions/vines";
import { PlantVineForm } from "@/components/plant-vine/plant-vine-form";

interface PlantPageProps {
	searchParams: Promise<{ source?: string }>;
}

export default async function PlantPage({ searchParams }: PlantPageProps) {
	const { source } = await searchParams;
	const identities = await getVerifiedCloudIdentities();

	let sourceVine = undefined;
	if (source) {
		try {
			sourceVine = await getVineAsFormData(source);
		} catch {
			// Source vine not found or unauthorized — proceed without pre-population
		}
	}

	return (
		<div className="w-full space-y-6">
			<div className="space-y-1.5">
				<h1 className="text-2xl sm:text-3xl font-semibold tracking-tight text-foreground">
					{sourceVine ? "Duplicate & Edit" : "Plant a Vine"}
				</h1>
				<p className="text-muted-foreground text-sm">
					{sourceVine
						? "Review and edit the converted configuration before creating."
						: "Configure your infrastructure components. Each section maps to a resource in your cloud account."}
				</p>
			</div>

			<PlantVineForm cloudIdentities={identities} sourceVine={sourceVine} />
		</div>
	);
}
