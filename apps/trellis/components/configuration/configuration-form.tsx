"use client";

import { createVine, type CreateVineInput } from "@/app/server/actions/vines";
import {
	getCachedAwsResources,
	type CachedAwsResources,
} from "@/app/server/actions/aws/resources";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Form } from "@/components/ui/form";
import { publicConfigurationsInsertSchema } from "@/lib/validations/database.schemas";
import { PublicConfigurationsInsert } from "@/lib/validations/db.schemas";
import { zodResolver } from "@hookform/resolvers/zod";
import { AlertCircle, Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { Resolver, SubmitHandler, useForm } from "react-hook-form";

import { SectionProjectBasics } from "./section-project-basics";
import { SectionAwsNetwork } from "./section-aws-network";
import { SectionPlatformEks } from "./section-platform-eks";
import { SectionRepositories } from "./section-repositories";
import { SectionDatabase } from "./section-database";
import { SectionAdvanced } from "./section-advanced";
import { CostPreview } from "./cost-preview";

export type ConfigFormValues = PublicConfigurationsInsert & {
	argocd_git_provider?: string;
	selected_vpc_id?: string | null;
	eks_version?: string;
};

export function NewConfigurationForm() {
	const router = useRouter();
	const [isLoading, setIsLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [awsResources, setAwsResources] =
		useState<CachedAwsResources | null>(null);

	const form = useForm<ConfigFormValues>({
		resolver: zodResolver(
			publicConfigurationsInsertSchema,
		) as Resolver<ConfigFormValues>,
		defaultValues: {
			user_id: "",
			container_platform: "",
			project_name: "",
			vineyard_id: "",
			aws_account_id: "",
			environment_stage: "development",
			terraform_version: "1.11.4",
			eks_version: "1.32",
			aws_region: "",
			enable_gitops_destination: false,
			env_git_repo: "",
			gitops_destination_repo: "",
			applications_template_repo: "",
			applications_destination_repo: "",
			gitops_argocd_token: "",
			gitops_app_token: "",
			argocd_git_provider: "",
			create_rds: true,
			create_vpc: true,
			vpc_cidr: "10.0.0.0/16",
			selected_vpc_id: null,
			enable_dns: false,
			dns_hosted_zone: "",
			dns_domain_name: "",
			db_min_capacity: 2,
			db_max_capacity: 16,
			eks_cluster_admins: "",
			ses_queues_topics: "",
			enable_cloudfront_waf: false,
			enable_redis: false,
			redis_allowed_cidr_blocks: "",
			enable_karpenter: true,
		},
	});

	const cloudIdentityId = form.watch("cloud_identity_id");

	useEffect(() => {
		if (!cloudIdentityId) {
			setAwsResources(null);
			return;
		}
		getCachedAwsResources(cloudIdentityId).then(setAwsResources);
	}, [cloudIdentityId]);

	const onSubmit: SubmitHandler<ConfigFormValues> = async (data) => {
		setIsLoading(true);
		setError(null);

		if (!data.cloud_identity_id) {
			setError("Please connect an AWS account first.");
			setIsLoading(false);
			return;
		}

		try {
			const platform = data.container_platform;
			const gitopsTemplate =
				platform === "ai-workloads"
					? "git@github.com:itgix/adp-k8s-aitempl-argoinfra.git"
					: "git@github.com:itgix/adp-k8s-templ-argoinfrasvcs.git";

			const input: CreateVineInput = {
				vine: {
					project_name: data.project_name,
					environment_stage: (data.environment_stage || "development") as any,
					aws_region: data.aws_region || "eu-west-1",
					aws_account_id: data.aws_account_id || null,
					vineyard_id: data.vineyard_id || null,
					cloud_identity_id: data.cloud_identity_id || null,
					terraform_version: data.terraform_version || "1.11.4",
				},
				vpc: {
					provision_vpc: data.create_vpc ?? true,
					vpc_id: data.selected_vpc_id || null,
					vpc_cidr: data.vpc_cidr || "10.0.0.0/16",
				},
				eks: {
					cluster_version: data.eks_version || "1.32",
					enable_karpenter: data.enable_karpenter ?? true,
				},
				dns: {
					enabled: data.enable_dns ?? false,
					hosted_zone_id: data.dns_hosted_zone || null,
					domain_name: data.dns_domain_name || null,
					cloudfront_waf: data.enable_cloudfront_waf ?? false,
				},
				repositories: {
					env_destination_repo: data.env_git_repo || null,
					gitops_template_repo: gitopsTemplate,
					gitops_destination_repo: data.gitops_destination_repo || null,
					apps_template_repo: data.applications_template_repo || null,
					apps_destination_repo: data.applications_destination_repo || null,
				},
				databases: data.create_rds
					? [
							{
								name: "primary",
								min_capacity: data.db_min_capacity ?? 0.5,
								max_capacity: data.db_max_capacity ?? 4,
							},
						]
					: [],
				caches: data.enable_redis
					? [{ name: "primary" }]
					: [],
			};

			const { vine } = await createVine(input);

			if (vine.vineyard_id) {
				router.push(`/dashboard/vineyards/${vine.vineyard_id}`);
			} else {
				router.push(`/dashboard/vines`);
			}
		} catch (err) {
			console.error("Error creating vine:", err);
			setError(
				err instanceof Error
					? err.message
					: "An unexpected error occurred",
			);
			setIsLoading(false);
		}
	};

	const formValues = form.watch();

	return (
		<Form {...form}>
			<form
				onSubmit={form.handleSubmit(onSubmit)}
				className="flex gap-6"
			>
				<div className="flex-1 space-y-6 min-w-0">
					<SectionProjectBasics form={form} />
					<SectionAwsNetwork
						form={form}
						awsResources={awsResources}
					/>
					<SectionPlatformEks form={form} />
					<SectionRepositories form={form} />
					<SectionDatabase
						form={form}
						awsResources={awsResources}
					/>
					<SectionAdvanced
						form={form}
						awsResources={awsResources}
					/>

					{error && (
						<Alert variant="destructive">
							<AlertCircle className="h-4 w-4" />
							<AlertTitle>Error</AlertTitle>
							<AlertDescription>{error}</AlertDescription>
						</Alert>
					)}

					<div className="flex justify-end pt-4 pb-8">
						<Button
							type="submit"
							disabled={isLoading}
							className="min-w-[160px]"
						>
							{isLoading ? (
								<>
									<Loader2 className="mr-2 h-4 w-4 animate-spin" />
									Creating...
								</>
							) : (
								"Plant Vine"
							)}
						</Button>
					</div>
				</div>

				<div className="hidden xl:block w-72 shrink-0">
					<CostPreview values={formValues} />
				</div>
			</form>
		</Form>
	);
}
