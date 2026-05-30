"use client";

import { createVine, type CreateVineInput } from "@/app/server/actions/vines";
import type { CachedAwsResources } from "@/app/server/actions/aws/resources";
import { vineFormSchema, type VineFormData } from "@/lib/validations/vine-form.schema";
import { useVineStore } from "./use-vine-store";
import { Button } from "@/components/ui/button";
import { Loader2, Rocket } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { FormProvider, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";

import { SectionProjectBasics } from "./section-project-basics";
import { SectionAwsRegion } from "./section-aws-region";
import { SectionVpc } from "./section-vpc";
import { SectionEks } from "./section-eks";
import { SectionRepositories } from "./section-repositories";
import { SectionDatabases } from "./section-databases";
import { SectionCaches } from "./section-caches";
import { SectionDns } from "./section-dns";
import { SectionMessaging } from "./section-messaging";
import { SectionDynamodb } from "./section-dynamodb";
import { SectionSecrets } from "./section-secrets";
import { CostSidebar } from "./cost-sidebar";

interface PlantVineFormProps {
	awsConnected: boolean;
	awsIdentityId?: string;
	awsAccountId?: string;
	initialAwsResources: CachedAwsResources | null;
}

export function PlantVineForm({
	awsConnected,
	awsIdentityId,
	awsAccountId,
	initialAwsResources,
}: PlantVineFormProps) {
	const router = useRouter();
	const store = useVineStore();

	useEffect(() => {
		store.set({ awsConnected, awsResources: initialAwsResources });
	}, []);

	const form = useForm<VineFormData>({
		resolver: zodResolver(vineFormSchema) as any,
		defaultValues: {
			vine: {
				project_name: "",
				environment_stage: "development",
				aws_region: "",
				aws_account_id: awsAccountId || null,
				cloud_identity_id: awsIdentityId || null,
				terraform_version: "1.11.4",
				vineyard_id: null,
			},
			vpc: {
				provision_vpc: true,
				vpc_cidr: "10.0.0.0/16",
				single_nat_gateway: true,
			},
			eks: {
				cluster_version: "1.32",
				enable_karpenter: true,
				instance_types: ["t3.medium"],
				node_min_size: 2,
				node_max_size: 5,
				node_desired_size: 2,
				cluster_admins: [],
			},
			dns: {
				enabled: false,
				acm_certificate: false,
				cloudfront_waf: false,
				application_waf: false,
			},
			repositories: {},
			databases: [],
			caches: [],
			queues: [],
			topics: [],
			dynamodb_tables: [],
			secrets: [],
		},
		mode: "onChange",
	});

	const region = form.watch("vine.aws_region");
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
		<FormProvider {...form}>
			<form onSubmit={form.handleSubmit(onSubmit, onError)} className="flex gap-6">
				<div className="flex-1 space-y-6 min-w-0">
					<SectionProjectBasics />
					<SectionAwsRegion />
					<SectionVpc />
					<SectionEks />
					<SectionRepositories />
					<SectionDatabases />
					<SectionCaches />
					<SectionDns />
					<SectionMessaging />
					<SectionDynamodb />
					<SectionSecrets />

					<div className="flex items-center justify-end gap-4 pt-4 pb-8">
						{store.error && (
							<p className="text-sm text-destructive">{store.error}</p>
						)}
						<Button
							type="submit"
							disabled={store.isLoading || !awsConnected}
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
	);
}
