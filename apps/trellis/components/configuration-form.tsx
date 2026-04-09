import { useEffect, useState } from "react";

import { ClusterSelector } from "@/components/cluster-selector";
import { ContainerPlatformSelector } from "@/components/container-platform-selector";
import { RepositorySelector } from "@/components/repository-selector";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import {
	Form,
	FormControl,
	FormField,
	FormItem,
	FormLabel,
	FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import {
	Select,
	SelectContent,
	SelectGroup,
	SelectItem,
	SelectLabel,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { VineyardSelector } from "@/components/vineyard-selector";
import { publicConfigurationsInsertSchema } from "@/lib/validations/database.schemas";
import {
	PublicClustersRow,
	PublicConfigurationsInsert,
} from "@/lib/validations/db.schemas";
import { zodResolver } from "@hookform/resolvers/zod";
import {
	AlertCircle,
	CheckCircle2,
	Cloud,
	Database,
	Loader2,
	Server,
	Shield,
} from "lucide-react";
import { Resolver, SubmitHandler, useForm } from "react-hook-form";

import { createConfiguration } from "@/app/server/actions/configurations";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { useRouter } from "next/navigation";

export function ConfigurationForm() {
	const router = useRouter();
	const [isLoading, setIsLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [selectedCluster, setSelectedCluster] =
		useState<PublicClustersRow | null>(null);

	const form = useForm<PublicConfigurationsInsert>({
		resolver: zodResolver(
			publicConfigurationsInsertSchema,
		) as Resolver<PublicConfigurationsInsert>,
		defaultValues: {
			user_id: "",
			container_platform: "",
			project_name: "",
			vineyard_id: "",
			aws_account_id: "",
			environment_stage: "development",
			terraform_version: "1.5.0",
			aws_region: "us-east-1",
			enable_gitops_destination: false,
			gitops_app_template: "",
			gitops_destinations_repo: "",
			gitops_infra_destination_repo: "",
			gitops_app_token: "",
			create_rds: true,
			create_vpc: true,
			vpc_cidr: "10.0.0.0/16",
			enable_dns: false,
			dns_hosted_zone: "",
			dns_domain_name: "",
			db_min_capacity: 2,
			db_max_capacity: 16,
			created_at: new Date().toISOString(),

			eks_cluster_admins: `eks_cluster_admins:
  - username: "mihail.vukadinoff@itgix.com"
    path: /
  - username: "hristiyan.tonev@itgix.com"
    path: /`,
			ses_queues_topics: `queues:
  - name: email-processing
    visibility_timeout: 300
  - name: notification-queue
    visibility_timeout: 600
topics:
  - name: user-events
    subscriptions:
      - email-processing`,
			enable_cloudfront_waf: false,
			enable_redis: false,
			redis_allowed_cidr_blocks: "10.0.0.0/16",
			enable_karpenter: true,
		},
	});

	// Handle Cluster Selection
	const handleClusterSelect = (cluster: PublicClustersRow) => {
		setSelectedCluster(cluster);
		form.setValue("cluster_id", cluster.id);
		form.setValue("user_id", cluster.user_id); // Ensure user_id is set

		const metadata = cluster.metadata as {
			region?: string;
			vpc_cidr?: string;
		} | null;
		if (metadata?.region) {
			form.setValue("aws_region", metadata.region);
		}
		if (metadata?.vpc_cidr) {
			form.setValue("vpc_cidr", metadata.vpc_cidr);
			form.setValue("create_vpc", false);
		}
	};

	const onSubmit: SubmitHandler<PublicConfigurationsInsert> = async (
		data,
	) => {
		setIsLoading(true);
		setError(null);

		try {
			const { configuration } = await createConfiguration(data);

			if (configuration.vineyard_id) {
				router.push(
					`/dashboard/vineyards/${configuration.vineyard_id}?config_id=${configuration.id}`,
				);
			} else {
				router.push(
					`/dashboard/configurations?config_id=${configuration.id}`,
				);
			}
		} catch (error) {
			console.error("Error creating configuration:", error);
			setError(
				error instanceof Error
					? error.message
					: "An unexpected error occurred",
			);
			setIsLoading(false);
		}
	};

	useEffect(() => {
		console.log(form.formState.errors, form.formState.isValid);
	}, [form.formState.errors]);

	return (
		<Form {...form}>
			<form onSubmit={form.handleSubmit(onSubmit)}>
				<div className="space-y-8">
					{/* Cluster Selection (The "Context") */}
					<div className="space-y-4 p-5 bg-card rounded-lg border border-border shadow-sm">
						<div className="flex items-center gap-2.5 mb-1">
							<div className="p-1.5 bg-muted rounded-md border border-border/50">
								<Server className="w-4 h-4 text-foreground" />
							</div>
							<h3 className="font-semibold text-sm text-foreground tracking-tight">
								Target Environment
							</h3>
						</div>
						<p className="text-xs text-muted-foreground">
							Select the Kubernetes cluster where this
							configuration will be deployed.
						</p>
						<ClusterSelector onSelect={handleClusterSelect} />

						{selectedCluster && (
							<div className="text-[11px] font-medium text-foreground flex items-center gap-1.5 mt-2 bg-muted/50 w-fit px-2.5 py-1.5 rounded-md border border-border">
								<CheckCircle2 className="w-3.5 h-3.5 text-muted-foreground" />
								Linked to {selectedCluster.name}
							</div>
						)}
					</div>

					{/* Project Configuration */}
					<div className="space-y-5">
						<div className="flex items-center gap-2.5 mb-3">
							<div className="p-1.5 bg-muted rounded-md border border-border/50">
								<Cloud className="w-4 h-4 text-foreground" />
							</div>
							<h3 className="font-semibold text-sm text-foreground tracking-tight">
								Vine Details
							</h3>
						</div>

						<div className="grid md:grid-cols-2 gap-5">
							<FormField
								control={form.control}
								name="vineyard_id"
								render={({ field }) => (
									<FormItem className="space-y-1.5 md:col-span-2">
										<FormLabel className="text-xs">
											Vineyard Workspace *
										</FormLabel>
										<FormControl>
											<VineyardSelector
												value={field.value ?? undefined}
												onChange={field.onChange}
											/>
										</FormControl>
										<FormMessage className="text-xs" />
									</FormItem>
								)}
							/>
							<FormField
								control={form.control}
								name="project_name"
								render={({ field }) => (
									<FormItem className="space-y-1.5">
										<FormLabel
											htmlFor="project_name"
											className="text-xs"
										>
											Vine (Configuration) Name *
										</FormLabel>
										<FormControl>
											<Input
												id="project_name"
												placeholder="my-awesome-vine"
												required
												className="h-9 text-sm border-border/50"
												{...field}
											/>
										</FormControl>
										<FormMessage className="text-xs" />
									</FormItem>
								)}
							/>
							<FormField
								control={form.control}
								name="environment_stage"
								render={({ field }) => (
									<FormItem className="space-y-1.5">
										<FormLabel
											htmlFor="environment_stage"
											className="text-xs"
										>
											Environment Stage *
										</FormLabel>
										<FormControl>
											<Input
												id="environment_stage"
												placeholder="e.g. development, staging, production"
												required
												className="h-9 text-sm border-border/50"
												{...field}
											/>
										</FormControl>
										<FormMessage className="text-xs" />
									</FormItem>
								)}
							/>
							<FormField
								control={form.control}
								name="aws_account_id"
								render={({ field }) => (
									<FormItem className="space-y-1.5">
										<FormLabel
											htmlFor="aws_account_id"
											className="text-xs"
										>
											AWS Account ID *
										</FormLabel>
										<FormControl>
											<Input
												id="aws_account_id"
												placeholder="123456789012"
												pattern="[0-9]{12}"
												required
												className="h-9 text-sm border-border/50"
												{...field}
												value={field.value ?? ""}
											/>
										</FormControl>
										<FormMessage className="text-xs" />
									</FormItem>
								)}
							/>
							<FormField
								control={form.control}
								name="terraform_version"
								render={({ field }) => (
									<FormItem className="space-y-1.5">
										<FormLabel
											htmlFor="terraform_version"
											className="text-xs"
										>
											Terraform Version *
										</FormLabel>
										<Select
											onValueChange={field.onChange}
											value={field.value ?? ""}
										>
											<FormControl>
												<SelectTrigger className="h-9 text-sm border-border/50">
													<SelectValue />
												</SelectTrigger>
											</FormControl>
											<SelectContent>
												<SelectItem value="1.11.4">
													1.11.4
												</SelectItem>
												<SelectItem value="1.10.5">
													1.10.5
												</SelectItem>
												<SelectItem value="1.9.8">
													1.9.8
												</SelectItem>
												<SelectItem value="1.8.5">
													1.8.5
												</SelectItem>
												<SelectItem value="1.7.5">
													1.7.5
												</SelectItem>
												<SelectItem value="1.6.6">
													1.6.6
												</SelectItem>
												<SelectItem value="1.5.7">
													1.5.7
												</SelectItem>
												<SelectItem value="1.5.0">
													1.5.0
												</SelectItem>
												<SelectItem value="1.4.6">
													1.4.6
												</SelectItem>
												<SelectItem value="1.3.9">
													1.3.9
												</SelectItem>
											</SelectContent>
										</Select>
										<FormMessage className="text-xs" />
									</FormItem>
								)}
							/>
							<div className="space-y-1.5 md:col-span-2">
								<FormField
									control={form.control}
									name="aws_region"
									render={({ field }) => (
										<FormItem className="space-y-1.5">
											<FormLabel
												htmlFor="aws_region"
												className="text-xs"
											>
												AWS Region *
											</FormLabel>
											{selectedCluster ? (
												<div className="p-2 h-9 flex items-center bg-muted/30 rounded-md border border-border/50 text-sm text-muted-foreground">
													{field.value} (Locked to
													Cluster)
												</div>
											) : (
												<Select
													onValueChange={
														field.onChange
													}
													value={field.value ?? ""}
												>
													<FormControl>
														<SelectTrigger className="h-9 text-sm border-border/50">
															<SelectValue />
														</SelectTrigger>
													</FormControl>
													<SelectContent>
														<SelectGroup>
															<SelectLabel>
																US East
															</SelectLabel>
															<SelectItem value="us-east-1">
																N. Virginia
																(us-east-1)
															</SelectItem>
															<SelectItem value="us-east-2">
																Ohio (us-east-2)
															</SelectItem>
														</SelectGroup>
														<SelectGroup>
															<SelectLabel>
																US West
															</SelectLabel>
															<SelectItem value="us-west-1">
																N. California
																(us-west-1)
															</SelectItem>
															<SelectItem value="us-west-2">
																Oregon
																(us-west-2)
															</SelectItem>
														</SelectGroup>
														<SelectGroup>
															<SelectLabel>
																Canada
															</SelectLabel>
															<SelectItem value="ca-central-1">
																Central
																(ca-central-1)
															</SelectItem>
														</SelectGroup>
														<SelectGroup>
															<SelectLabel>
																Europe
															</SelectLabel>
															<SelectItem value="eu-central-1">
																Frankfurt
																(eu-central-1)
															</SelectItem>
															<SelectItem value="eu-west-1">
																Ireland
																(eu-west-1)
															</SelectItem>
															<SelectItem value="eu-west-2">
																London
																(eu-west-2)
															</SelectItem>
															<SelectItem value="eu-west-3">
																Paris
																(eu-west-3)
															</SelectItem>
															<SelectItem value="eu-north-1">
																Stockholm
																(eu-north-1)
															</SelectItem>
														</SelectGroup>
														<SelectGroup>
															<SelectLabel>
																Asia Pacific
															</SelectLabel>
															<SelectItem value="ap-south-1">
																Mumbai
																(ap-south-1)
															</SelectItem>
															<SelectItem value="ap-northeast-1">
																Tokyo
																(ap-northeast-1)
															</SelectItem>
															<SelectItem value="ap-northeast-2">
																Seoul
																(ap-northeast-2)
															</SelectItem>
															<SelectItem value="ap-southeast-1">
																Singapore
																(ap-southeast-1)
															</SelectItem>
															<SelectItem value="ap-southeast-2">
																Sydney
																(ap-southeast-2)
															</SelectItem>
														</SelectGroup>
														<SelectGroup>
															<SelectLabel>
																South America
															</SelectLabel>
															<SelectItem value="sa-east-1">
																São Paulo
																(sa-east-1)
															</SelectItem>
														</SelectGroup>
													</SelectContent>
												</Select>
											)}
											<FormMessage className="text-xs" />
										</FormItem>
									)}
								/>
							</div>
						</div>
					</div>

					<Separator className="bg-border/60" />

					{/* Container Platform Selection */}
					<div className="space-y-5">
						<div className="flex items-center gap-2.5 mb-3">
							<div className="p-1.5 bg-muted rounded-md border border-border/50">
								<Shield className="w-4 h-4 text-foreground" />
							</div>
							<h3 className="font-semibold text-sm text-foreground tracking-tight">
								Container Platform
							</h3>
						</div>
						<ContainerPlatformSelector
							selected={form.watch("container_platform")}
							onSelect={(platform) =>
								form.setValue("container_platform", platform, {
									shouldValidate: true,
								})
							}
						/>
					</div>

					<Separator className="bg-border/60" />

					{/* Repository Configuration */}
					<div className="space-y-5">
						<div className="flex items-center gap-2.5 mb-3">
							<div className="p-1.5 bg-muted rounded-md border border-border/50">
								<Shield className="w-4 h-4 text-foreground" />
							</div>
							<h3 className="font-semibold text-sm text-foreground tracking-tight">
								Repository Configuration
							</h3>
						</div>

						<div className="grid md:grid-cols-2 gap-5">
							{form.watch("container_platform") === "custom" ? (
								<>
									<FormField
										control={form.control}
										name="environment_repository"
										render={({ field }) => (
											<FormItem className="space-y-1.5">
												<FormControl>
													<RepositorySelector
														label="Environment Repository"
														placeholder="Select environment repository"
														required
														value={field.value ?? undefined}
														onChange={field.onChange}
													/>
												</FormControl>
												<FormMessage className="text-xs" />
											</FormItem>
										)}
									/>
									<FormField
										control={form.control}
										name="gitops_repository"
										render={({ field }) => (
											<FormItem className="space-y-1.5">
												<FormControl>
													<RepositorySelector
														label="GitOps Repository"
														placeholder="Select GitOps repository"
														required
														value={field.value ?? undefined}
														onChange={field.onChange}
													/>
												</FormControl>
												<FormMessage className="text-xs" />
											</FormItem>
										)}
									/>
								</>
							) : (
								<div className="md:col-span-2 grid md:grid-cols-2 gap-5 p-4 rounded-lg bg-muted/20 border border-border/50">
									<div className="space-y-1.5">
										<label className="text-xs font-medium text-muted-foreground">
											Environment Repository (Preset)
										</label>
										<div className="h-9 flex items-center px-3 text-sm bg-muted/50 border border-border/40 rounded-md text-foreground truncate" title="git@github.com:itgix/adp-tf-envtempl-standard.git">
											git@github.com:itgix/adp-tf-envtempl-standard.git
										</div>
									</div>
									<div className="space-y-1.5">
										<label className="text-xs font-medium text-muted-foreground">
											GitOps Repository (Preset)
										</label>
										<div className="h-9 flex items-center px-3 text-sm bg-muted/50 border border-border/40 rounded-md text-foreground truncate" title={form.watch("container_platform") === "ai-workloads" ? "git@github.com:itgix/adp-k8s-aitempl-argoinfra.git" : "git@github.com:itgix/adp-k8s-templ-argoinfrasvcs.git"}>
											{form.watch("container_platform") === "ai-workloads" 
												? "git@github.com:itgix/adp-k8s-aitempl-argoinfra.git" 
												: "git@github.com:itgix/adp-k8s-templ-argoinfrasvcs.git"}
										</div>
									</div>
									<div className="md:col-span-2 text-xs text-muted-foreground flex items-center gap-1.5">
										<CheckCircle2 className="w-3.5 h-3.5 text-primary" />
										Template repositories are automatically configured for your selected platform.
									</div>
								</div>
							)}

							<FormField
								control={form.control}
								name="gitops_argocd_token"
								render={({ field }) => (
									<FormItem className="space-y-1.5 md:col-span-2">
										<FormLabel
											htmlFor="gitops_token"
											className="text-xs"
										>
											GitOps ArgoCD Access Token *
										</FormLabel>
										<FormControl>
											<Input
												id="gitops_token"
												type="password"
												placeholder="Enter ArgoCD access token"
												required
												className="h-9 text-sm border-border/50"
												{...field}
												value={field.value ?? ""}
											/>
										</FormControl>
										<FormMessage className="text-xs" />
									</FormItem>
								)}
							/>
						</div>

						{/* GitOps Destination Repository Toggle */}
						<Card className="border-border/40 shadow-sm">
							<CardHeader className="pb-4 bg-muted/5 border-b border-border/40">
								<div className="flex items-center justify-between">
									<div className="space-y-1">
										<CardTitle className="text-sm font-medium">
											GitOps Destination Repository
										</CardTitle>
										<CardDescription className="text-xs">
											Configure application template and
											destination repositories.
										</CardDescription>
									</div>
									<FormField
										control={form.control}
										name="enable_gitops_destination"
										render={({ field }) => (
											<FormItem>
												<FormControl>
													<Switch
														checked={
															field.value ?? false
														}
														onCheckedChange={
															field.onChange
														}
													/>
												</FormControl>
											</FormItem>
										)}
									/>
								</div>
							</CardHeader>
							{form.watch("enable_gitops_destination") && (
								<CardContent className="space-y-5 pt-6">
									<div className="grid md:grid-cols-2 gap-5">
										<FormField
											control={form.control}
											name="gitops_app_template"
											render={({ field }) => (
												<FormItem className="space-y-1.5">
													<FormLabel
														htmlFor="application_template"
														className="text-xs"
													>
														Application Template
													</FormLabel>
													<FormControl>
														<Input
															id="application_template"
															placeholder="helm-chart-template"
															className="h-9 text-sm border-border/50"
															{...field}
															value={
																field.value ??
																""
															}
														/>
													</FormControl>
													<FormMessage className="text-xs" />
												</FormItem>
											)}
										/>
										<FormField
											control={form.control}
											name="gitops_destinations_repo"
											render={({ field }) => (
												<FormItem className="space-y-1.5">
													<FormControl>
														<RepositorySelector
															label="App Destination Repository"
															placeholder="Select app destination repository"
															value={
																field.value ??
																undefined
															}
															onChange={
																field.onChange
															}
														/>
													</FormControl>
													<FormMessage className="text-xs" />
												</FormItem>
											)}
										/>
										<FormField
											control={form.control}
											name="gitops_infra_destination_repo"
											render={({ field }) => (
												<FormItem className="space-y-1.5">
													<FormControl>
														<RepositorySelector
															label="Infra Destination Repository"
															placeholder="Select infra destination repository"
															value={
																field.value ??
																undefined
															}
															onChange={
																field.onChange
															}
														/>
													</FormControl>
													<FormMessage className="text-xs" />
												</FormItem>
											)}
										/>
										<FormField
											control={form.control}
											name="gitops_app_token"
											render={({ field }) => (
												<FormItem className="space-y-1.5 md:col-span-2">
													<FormLabel
														htmlFor="gitops_application_token"
														className="text-xs"
													>
														ArgoCD Application Token
													</FormLabel>
													<FormControl>
														<Input
															id="gitops_application_token"
															type="password"
															placeholder="Enter ArgoCD application token"
															className="h-9 text-sm border-border/50"
															{...field}
															value={
																field.value ??
																""
															}
														/>
													</FormControl>
													<FormMessage className="text-xs" />
												</FormItem>
											)}
										/>
									</div>
								</CardContent>
							)}
						</Card>
					</div>

					<Separator className="bg-border/60" />

					{/* Network Configuration */}
					<div className="space-y-5">
						<div className="flex items-center gap-2.5 mb-3">
							<div className="p-1.5 bg-muted rounded-md border border-border/50">
								<Shield className="w-4 h-4 text-foreground" />
							</div>
							<h3 className="font-semibold text-sm text-foreground tracking-tight">
								Network Configuration
							</h3>
						</div>

						{/* VPC Configuration */}
						<Card className="border-border/60 shadow-sm">
							<CardHeader className="pb-4 bg-muted/5 border-b border-border/40">
								<div className="flex items-center justify-between">
									<div className="space-y-1">
										<CardTitle className="text-sm font-semibold">
											Create VPC
										</CardTitle>
										<CardDescription className="text-xs">
											Create a new VPC with custom CIDR
											block.
										</CardDescription>
									</div>
									<FormField
										control={form.control}
										name="create_vpc"
										render={({ field }) => (
											<FormItem>
												<FormControl>
													<Switch
														checked={
															field.value ?? false
														}
														onCheckedChange={
															field.onChange
														}
													/>
												</FormControl>
											</FormItem>
										)}
									/>
								</div>
							</CardHeader>
							{form.watch("create_vpc") && (
								<CardContent className="pt-6">
									<FormField
										control={form.control}
										name="vpc_cidr"
										render={({ field }) => (
											<FormItem className="space-y-1.5">
												<FormLabel
													htmlFor="vpc_cidr"
													className="text-xs"
												>
													VPC CIDR Block
												</FormLabel>
												<FormControl>
													<Input
														id="vpc_cidr"
														placeholder="10.0.0.0/16"
														className="h-9 text-sm border-border/50 max-w-md"
														{...field}
														value={
															field.value ?? ""
														}
													/>
												</FormControl>
												<FormMessage className="text-xs" />
											</FormItem>
										)}
									/>
								</CardContent>
							)}
						</Card>

						{/* DNS Configuration */}
						<Card className="border-border/60 shadow-sm">
							<CardHeader className="pb-4 bg-muted/5 border-b border-border/40">
								<div className="flex items-center justify-between">
									<div className="space-y-1">
										<CardTitle className="text-sm font-semibold">
											DNS Configuration
										</CardTitle>
										<CardDescription className="text-xs">
											Configure DNS hosted zone and domain
											name.
										</CardDescription>
									</div>
									<FormField
										control={form.control}
										name="enable_dns"
										render={({ field }) => (
											<FormItem>
												<FormControl>
													<Switch
														checked={
															field.value ?? false
														}
														onCheckedChange={
															field.onChange
														}
													/>
												</FormControl>
											</FormItem>
										)}
									/>
								</div>
							</CardHeader>
							{form.watch("enable_dns") && (
								<CardContent className="space-y-5 pt-6">
									<div className="grid md:grid-cols-2 gap-5">
										<FormField
											control={form.control}
											name="dns_hosted_zone"
											render={({ field }) => (
												<FormItem className="space-y-1.5">
													<FormLabel
														htmlFor="dns_hosted_zone"
														className="text-xs"
													>
														DNS Hosted Zone
													</FormLabel>
													<FormControl>
														<Input
															id="dns_hosted_zone"
															placeholder="Z1234567890ABC"
															className="h-9 text-sm border-border/50"
															{...field}
															value={
																field.value ??
																""
															}
														/>
													</FormControl>
													<FormMessage className="text-xs" />
												</FormItem>
											)}
										/>
										<FormField
											control={form.control}
											name="dns_domain_name"
											render={({ field }) => (
												<FormItem className="space-y-1.5">
													<FormLabel
														htmlFor="dns_domain_name"
														className="text-xs"
													>
														DNS Domain Name
													</FormLabel>
													<FormControl>
														<Input
															id="dns_domain_name"
															placeholder="example.com"
															className="h-9 text-sm border-border/50"
															{...field}
															value={
																field.value ??
																""
															}
														/>
													</FormControl>
													<FormMessage className="text-xs" />
												</FormItem>
											)}
										/>
									</div>
								</CardContent>
							)}
						</Card>
					</div>

					<Separator className="bg-border/60" />

					{/* Database Configuration */}
					<div className="space-y-5">
						<div className="flex items-center justify-between mb-3">
							<div className="flex items-center gap-2.5">
								<div className="p-1.5 bg-muted rounded-md border border-border/50">
									<Database className="w-4 h-4 text-foreground" />
								</div>
								<h3 className="font-semibold text-sm text-foreground tracking-tight">
									Database Configuration
								</h3>
							</div>
							<FormField
								control={form.control}
								name="create_rds"
								render={({ field }) => (
									<FormItem className="flex items-center gap-2 space-y-0">
										<FormLabel className="text-xs">
											Enable Database
										</FormLabel>
										<FormControl>
											<Switch
												checked={field.value ?? false}
												onCheckedChange={field.onChange}
											/>
										</FormControl>
									</FormItem>
								)}
							/>
						</div>

						{form.watch("create_rds") && (
							<div className="grid md:grid-cols-2 gap-5">
								<FormField
									control={form.control}
									name="db_min_capacity"
									render={({ field }) => (
										<FormItem className="space-y-1.5">
											<FormLabel
												htmlFor="db_min_capacity"
												className="text-xs"
											>
												Minimum Capacity
											</FormLabel>
											<FormControl>
												<Input
													id="db_min_capacity"
													type="number"
													min="0.5"
													max="128"
													step="0.5"
													className="h-9 text-sm border-border/50"
													{...field}
													onChange={(e) =>
														field.onChange(
															e.target.value ===
																""
																? null
																: +e.target
																		.value,
														)
													}
													value={field.value ?? ""}
												/>
											</FormControl>
											<FormMessage className="text-xs" />
										</FormItem>
									)}
								/>
								<FormField
									control={form.control}
									name="db_max_capacity"
									render={({ field }) => (
										<FormItem className="space-y-1.5">
											<FormLabel
												htmlFor="db_max_capacity"
												className="text-xs"
											>
												Maximum Capacity
											</FormLabel>
											<FormControl>
												<Input
													id="db_max_capacity"
													type="number"
													min="0.5"
													max="128"
													step="0.5"
													className="h-9 text-sm border-border/50"
													{...field}
													onChange={(e) =>
														field.onChange(
															e.target.value ===
																""
																? null
																: +e.target
																		.value,
														)
													}
													value={field.value ?? ""}
												/>
											</FormControl>
											<FormMessage className="text-xs" />
										</FormItem>
									)}
								/>
							</div>
						)}
					</div>

					<Separator className="bg-border/60" />

					{/* Advanced Configuration */}
					<div className="space-y-5">
						<h3 className="font-semibold text-sm text-foreground tracking-tight mb-3">
							Advanced Configuration
						</h3>

						<div className="space-y-5">
							<FormField
								control={form.control}
								name="eks_cluster_admins"
								render={({ field }) => (
									<FormItem className="space-y-1.5">
										<FormLabel
											htmlFor="eks_cluster_admins"
											className="text-xs"
										>
											EKS Authentication Users (YAML)
										</FormLabel>
										<FormControl>
											<Textarea
												id="eks_cluster_admins"
												rows={8}
												className="font-mono text-xs border-border/50 bg-muted/30 p-4 rounded-md"
												{...field}
												value={field.value ?? ""}
											/>
										</FormControl>
										<FormMessage className="text-xs" />
									</FormItem>
								)}
							/>
							<FormField
								control={form.control}
								name="ses_queues_topics"
								render={({ field }) => (
									<FormItem className="space-y-1.5">
										<FormLabel
											htmlFor="ses_queues_topics"
											className="text-xs"
										>
											SES Queues and Topics (YAML)
										</FormLabel>
										<FormControl>
											<Textarea
												id="ses_queues_topics"
												rows={10}
												className="font-mono text-xs border-border/50 bg-muted/30 p-4 rounded-md"
												{...field}
												value={field.value ?? ""}
											/>
										</FormControl>
										<FormMessage className="text-xs" />
									</FormItem>
								)}
							/>
						</div>

						{/* Additional Options */}
						<div className="space-y-3">
							<div className="flex items-center justify-between p-4 border border-border/60 rounded-lg bg-card shadow-sm">
								<div>
									<h4 className="text-sm font-semibold">
										CloudFront WAF
									</h4>
									<p className="text-[11px] text-muted-foreground mt-0.5">
										Enable CloudFront Web Application
										Firewall.
									</p>
								</div>
								<FormField
									control={form.control}
									name="enable_cloudfront_waf"
									render={({ field }) => (
										<FormItem>
											<FormControl>
												<Switch
													checked={
														field.value ?? false
													}
													onCheckedChange={
														field.onChange
													}
												/>
											</FormControl>
										</FormItem>
									)}
								/>
							</div>

							<div className="flex items-center justify-between p-4 border border-border/60 rounded-lg bg-card shadow-sm">
								<div>
									<h4 className="text-sm font-semibold">
										Elastic Redis
									</h4>
									<p className="text-[11px] text-muted-foreground mt-0.5">
										Create ElastiCache Redis cluster.
									</p>
								</div>
								<FormField
									control={form.control}
									name="enable_redis"
									render={({ field }) => (
										<FormItem>
											<FormControl>
												<Switch
													checked={
														field.value ?? false
													}
													onCheckedChange={
														field.onChange
													}
												/>
											</FormControl>
										</FormItem>
									)}
								/>
							</div>

							{form.watch("enable_redis") && (
								<FormField
									control={form.control}
									name="redis_allowed_cidr_blocks"
									render={({ field }) => (
										<FormItem className="ml-4 space-y-1.5 pt-2">
											<FormLabel
												htmlFor="redis_allowed_cidr_blocks"
												className="text-xs"
											>
												Allowed CIDR Blocks
											</FormLabel>
											<FormControl>
												<Input
													id="redis_allowed_cidr_blocks"
													placeholder="10.0.0.0/16,172.16.0.0/12"
													className="h-9 text-sm border-border/50 max-w-md"
													{...field}
													value={field.value ?? ""}
												/>
											</FormControl>
											<FormMessage className="text-xs" />
										</FormItem>
									)}
								/>
							)}

							<div className="flex items-center justify-between p-4 border border-border/60 rounded-lg bg-card shadow-sm">
								<div>
									<h4 className="text-sm font-semibold">
										Karpenter Auto-Scaling
									</h4>
									<p className="text-[11px] text-muted-foreground mt-0.5">
										Enable dynamic auto-scaling with
										Karpenter.
									</p>
								</div>
								<FormField
									control={form.control}
									name="enable_karpenter"
									render={({ field }) => (
										<FormItem>
											<FormControl>
												<Switch
													checked={
														field.value ?? false
													}
													onCheckedChange={
														field.onChange
													}
												/>
											</FormControl>
										</FormItem>
									)}
								/>
							</div>
						</div>
					</div>

					<Separator className="bg-border/40" />

					{error && (
						<Alert
							variant="destructive"
							className="border-destructive/20 bg-destructive/5 text-destructive"
						>
							<AlertCircle className="h-4 w-4" />
							<AlertTitle className="text-sm font-medium">
								Error
							</AlertTitle>
							<AlertDescription className="text-xs">
								{error}
							</AlertDescription>
						</Alert>
					)}

					<div className="flex justify-end pt-4 pb-8">
						<Button
							type="submit"
							disabled={isLoading}
							className="h-10 px-8 text-sm font-medium"
						>
							{isLoading && (
								<Loader2 className="w-4 h-4 mr-2 animate-spin" />
							)}
							{isLoading
								? "Planting Vine..."
								: "Plant Vine"}
						</Button>
					</div>
				</div>
			</form>
		</Form>
	);
}
