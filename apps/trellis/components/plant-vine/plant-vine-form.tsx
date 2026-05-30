"use client";

import { createVine, type CreateVineInput } from "@/app/server/actions/vines";
import type { CloudIdentityOption } from "@/app/server/actions/aws/identities";
import { vineFormSchema, type VineFormData } from "@/lib/validations/vine-form.schema";
import { CloudProviderProvider } from "@/lib/cloud-providers";
import { DEFAULT_INSTANCE_TYPE, DEFAULT_K8S_VERSION } from "@/lib/cloud-providers";
import { useVineStore } from "./use-vine-store";
import { Button } from "@/components/ui/button";
import { Loader2, Rocket } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { FormProvider, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";

import { SectionProjectBasics } from "./section-project-basics";
import { SectionCloudRegion } from "./section-cloud-region";
import { SectionNetwork } from "./section-network";
import { SectionCluster } from "./section-cluster";
import { SectionRepositories } from "./section-repositories";
import { SectionDatabases } from "./section-databases";
import { SectionCaches } from "./section-caches";
import { SectionDns } from "./section-dns";
import { SectionMessaging } from "./section-messaging";
import { SectionNosql } from "./section-nosql";
import { SectionSecrets } from "./section-secrets";
import { CostSidebar } from "./cost-sidebar";

interface PlantVineFormProps {
	cloudIdentities: CloudIdentityOption[];
}

export function PlantVineForm({ cloudIdentities }: PlantVineFormProps) {
	const router = useRouter();
	const store = useVineStore();
	const hasIdentities = cloudIdentities.length > 0;

	const form = useForm<VineFormData>({
		resolver: zodResolver(vineFormSchema) as any,
		defaultValues: {
			vine: {
				project_name: "",
				environment_stage: "development",
				region: "",
				cloud_identity_id: "",
				terraform_version: "1.11.4",
				vineyard_id: "",
			},
			network: {
				provision_network: true,
				cidr_block: "10.0.0.0/16",
				single_nat_gateway: true,
			},
			cluster: {
				cluster_version: DEFAULT_K8S_VERSION.aws,
				provider_config: { enable_karpenter: true },
				instance_types: [DEFAULT_INSTANCE_TYPE.aws],
				node_min_size: 2,
				node_max_size: 5,
				node_desired_size: 2,
				cluster_admins: [],
			},
			dns: {
				enabled: false,
				managed_certificate: false,
				waf_enabled: false,
				provider_config: {},
			},
			repositories: {},
			databases: [],
			caches: [],
			queues: [],
			topics: [],
			nosql_tables: [],
			secrets: [],
		},
		mode: "onChange",
	});

	const region = form.watch("vine.region");
	useEffect(() => {
		if (region) store.fetchPrices(region);
	}, [region]);

	const onSubmit = async (data: VineFormData) => {
		store.set({ isLoading: true, error: null });
		try {
			const input = data as unknown as CreateVineInput;
			const { vine } = await createVine(input);
			toast.success("Vine planted successfully!");

			if (vine.vineyard_id) {
				router.push(`/dashboard/vineyards/${vine.vineyard_id}`);
			} else {
				router.push("/dashboard/vines");
			}
		} catch (err) {
			store.set({
				error: err instanceof Error ? err.message : "An unexpected error occurred",
				isLoading: false,
			});
		}
	};

	const onError = () => {
		store.set({ submitted: true });
	};

	return (
		<CloudProviderProvider>
		<FormProvider {...form}>
			<form onSubmit={form.handleSubmit(onSubmit, onError)} className="flex gap-6">
				<div className="flex-1 space-y-6 min-w-0">
					<SectionProjectBasics />
					<SectionCloudRegion />
					<SectionNetwork />
					<SectionCluster />
					<SectionRepositories />
					<SectionDatabases />
					<SectionCaches />
					<SectionDns />
					<SectionMessaging />
					<SectionNosql />
					<SectionSecrets />

					<div className="flex items-center justify-end gap-4 pt-4 pb-8">
						{store.error && (
							<p className="text-sm text-destructive">{store.error}</p>
						)}
						<Button
							type="submit"
							disabled={store.isLoading || !hasIdentities}
							className="min-w-[160px]"
						>
							{store.isLoading ? (
								<>
									<Loader2 className="mr-2 h-4 w-4 animate-spin" />
									Planting...
								</>
							) : (
								<>
									<Rocket className="mr-2 h-4 w-4" />
									Plant Vine
								</>
							)}
						</Button>
					</div>
				</div>

				<div className="hidden lg:block w-72 shrink-0">
					<CostSidebar />
				</div>
			</form>
		</FormProvider>
		</CloudProviderProvider>
	);
}
