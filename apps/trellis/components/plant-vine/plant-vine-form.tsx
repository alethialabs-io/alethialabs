"use client";

import { createVine, type CreateVineInput } from "@/app/server/actions/vines";
import type { CachedAwsResources } from "@/app/server/actions/aws/resources";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { AlertCircle, Loader2, Rocket } from "lucide-react";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
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
import { CostSidebar } from "./cost-sidebar";

interface PlantVineFormProps {
	awsConnected: boolean;
	awsIdentityId?: string;
	awsAccountId?: string;
	initialAwsResources: CachedAwsResources | null;
}

interface DatabaseEntry {
	name: string;
	engine: string;
	min_capacity: number;
	max_capacity: number;
	port: number;
	iam_auth: boolean;
}

interface CacheEntry {
	name: string;
	engine: "redis" | "valkey";
	node_type: string;
	num_cache_nodes: number;
	multi_az: boolean;
}

interface QueueEntry {
	name: string;
	fifo: boolean;
	visibility_timeout: number;
}

interface TopicEntry {
	name: string;
	subscriptions: Array<{ protocol: string; endpoint: string }>;
}

export type { DatabaseEntry, CacheEntry, QueueEntry, TopicEntry };

export function PlantVineForm({
	awsConnected,
	awsIdentityId,
	awsAccountId,
	initialAwsResources,
}: PlantVineFormProps) {
	const router = useRouter();
	const [isLoading, setIsLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [awsResources, setAwsResources] = useState(initialAwsResources);

	// Vine core
	const [projectName, setProjectName] = useState("");
	const [environment, setEnvironment] = useState<string>("development");
	const [vineyardId, setVineyardId] = useState<string | null>(null);

	// AWS
	const [region, setRegion] = useState("");
	const [cloudIdentityId, setCloudIdentityId] = useState<string | null>(
		awsIdentityId || null,
	);
	const [accountId, setAccountId] = useState<string | null>(awsAccountId || null);

	// VPC
	const [provisionVpc, setProvisionVpc] = useState(true);
	const [vpcId, setVpcId] = useState<string | null>(null);
	const [vpcCidr, setVpcCidr] = useState("10.0.0.0/16");
	const [singleNatGateway, setSingleNatGateway] = useState(true);

	// EKS
	const [clusterVersion, setClusterVersion] = useState("1.32");
	const [terraformVersion, setTerraformVersion] = useState("1.11.4");
	const [enableKarpenter, setEnableKarpenter] = useState(true);
	const [platform, setPlatform] = useState("standard");
	const [clusterAdmins, setClusterAdmins] = useState<Array<{ username: string; groups: string[] }>>([]);
	const [instanceTypes, setInstanceTypes] = useState<string[]>(["t3.medium"]);
	const [nodeMinSize, setNodeMinSize] = useState(2);
	const [nodeMaxSize, setNodeMaxSize] = useState(5);
	const [nodeDesiredSize, setNodeDesiredSize] = useState(2);

	// DNS
	const [enableDns, setEnableDns] = useState(false);
	const [hostedZoneId, setHostedZoneId] = useState<string | null>(null);
	const [domainName, setDomainName] = useState<string | null>(null);
	const [acmCertificate, setAcmCertificate] = useState(false);
	const [cloudfrontWaf, setCloudfrontWaf] = useState(false);
	const [applicationWaf, setApplicationWaf] = useState(false);

	// Repositories
	const [envDestinationRepo, setEnvDestinationRepo] = useState<string | null>(null);
	const [gitopsDestinationRepo, setGitopsDestinationRepo] = useState<string | null>(null);
	const [appsDestinationRepo, setAppsDestinationRepo] = useState<string | null>(null);

	// 1:N components
	const [databases, setDatabases] = useState<DatabaseEntry[]>([]);
	const [caches, setCaches] = useState<CacheEntry[]>([]);
	const [queues, setQueues] = useState<QueueEntry[]>([]);
	const [topics, setTopics] = useState<TopicEntry[]>([]);

	const handleSubmit = async (e: React.FormEvent) => {
		e.preventDefault();
		setIsLoading(true);
		setError(null);

		if (!projectName.trim()) {
			setError("Project name is required.");
			setIsLoading(false);
			return;
		}

		if (!cloudIdentityId) {
			setError("Please connect an AWS account first.");
			setIsLoading(false);
			return;
		}

		if (!region) {
			setError("Please select an AWS region.");
			setIsLoading(false);
			return;
		}

		try {
			const gitopsTemplate =
				platform === "ai-workloads"
					? "git@github.com:itgix/adp-k8s-aitempl-argoinfra.git"
					: "git@github.com:itgix/adp-k8s-templ-argoinfrasvcs.git";

			const input: CreateVineInput = {
				vine: {
					project_name: projectName.trim(),
					environment_stage: environment as any,
					aws_region: region,
					aws_account_id: accountId || awsAccountId || null,
					vineyard_id: vineyardId,
					cloud_identity_id: cloudIdentityId,
					terraform_version: terraformVersion,
				},
				vpc: {
					provision_vpc: provisionVpc,
					vpc_id: provisionVpc ? null : vpcId,
					vpc_cidr: provisionVpc ? vpcCidr : null,
					single_nat_gateway: singleNatGateway,
				},
				eks: {
					cluster_version: clusterVersion,
					enable_karpenter: enableKarpenter,
					cluster_admins: clusterAdmins,
					instance_types: instanceTypes,
					node_min_size: nodeMinSize,
					node_max_size: nodeMaxSize,
					node_desired_size: nodeDesiredSize,
				},
				dns: {
					enabled: enableDns,
					hosted_zone_id: enableDns ? hostedZoneId : null,
					domain_name: enableDns ? domainName : null,
					acm_certificate: acmCertificate,
					cloudfront_waf: cloudfrontWaf,
					application_waf: applicationWaf,
				},
				repositories: {
					gitops_template_repo: gitopsTemplate,
					env_destination_repo: envDestinationRepo,
					gitops_destination_repo: gitopsDestinationRepo,
					apps_destination_repo: appsDestinationRepo,
				},
				databases: databases.length > 0 ? databases : undefined,
				caches: caches.length > 0 ? caches : undefined,
				queues: queues.length > 0 ? queues : undefined,
				topics: topics.length > 0 ? topics : undefined,
			};

			const { vine } = await createVine(input);
			toast.success("Vine planted successfully!");

			if (vine.vineyard_id) {
				router.push(`/dashboard/vineyards/${vine.vineyard_id}`);
			} else {
				router.push("/dashboard/vines");
			}
		} catch (err) {
			console.error("Error planting vine:", err);
			setError(
				err instanceof Error ? err.message : "An unexpected error occurred",
			);
			setIsLoading(false);
		}
	};

	return (
		<form onSubmit={handleSubmit} className="flex gap-6">
			<div className="flex-1 space-y-6 min-w-0">
				<SectionProjectBasics
					projectName={projectName}
					onProjectNameChange={setProjectName}
					environment={environment}
					onEnvironmentChange={setEnvironment}
					vineyardId={vineyardId}
					onVineyardIdChange={setVineyardId}
				/>

				<SectionAwsRegion
					awsConnected={awsConnected}
					cloudIdentityId={cloudIdentityId}
					onCloudIdentityChange={(id, acctId) => {
						setCloudIdentityId(id);
						if (acctId) setAccountId(acctId);
					}}
					region={region}
					onRegionChange={setRegion}
					awsResources={awsResources}
					onAwsResourcesChange={setAwsResources}
				/>

				<SectionVpc
					provisionVpc={provisionVpc}
					onProvisionVpcChange={setProvisionVpc}
					vpcId={vpcId}
					onVpcIdChange={setVpcId}
					vpcCidr={vpcCidr}
					onVpcCidrChange={setVpcCidr}
					singleNatGateway={singleNatGateway}
					onSingleNatGatewayChange={setSingleNatGateway}
					region={region}
					awsResources={awsResources}
				/>

				<SectionEks
					clusterVersion={clusterVersion}
					onClusterVersionChange={setClusterVersion}
					terraformVersion={terraformVersion}
					onTerraformVersionChange={setTerraformVersion}
					enableKarpenter={enableKarpenter}
					onEnableKarpenterChange={setEnableKarpenter}
					platform={platform}
					onPlatformChange={setPlatform}
					clusterAdmins={clusterAdmins}
					onClusterAdminsChange={setClusterAdmins}
					instanceTypes={instanceTypes}
					onInstanceTypesChange={setInstanceTypes}
					nodeMinSize={nodeMinSize}
					onNodeMinSizeChange={setNodeMinSize}
					nodeMaxSize={nodeMaxSize}
					onNodeMaxSizeChange={setNodeMaxSize}
					nodeDesiredSize={nodeDesiredSize}
					onNodeDesiredSizeChange={setNodeDesiredSize}
				/>

				<SectionRepositories
					platform={platform}
					envDestinationRepo={envDestinationRepo}
					onEnvDestinationRepoChange={setEnvDestinationRepo}
					gitopsDestinationRepo={gitopsDestinationRepo}
					onGitopsDestinationRepoChange={setGitopsDestinationRepo}
					appsDestinationRepo={appsDestinationRepo}
					onAppsDestinationRepoChange={setAppsDestinationRepo}
				/>

				<SectionDatabases
					databases={databases}
					onDatabasesChange={setDatabases}
				/>

				<SectionCaches
					caches={caches}
					onCachesChange={setCaches}
				/>

				<SectionDns
					enabled={enableDns}
					onEnabledChange={setEnableDns}
					hostedZoneId={hostedZoneId}
					onHostedZoneIdChange={setHostedZoneId}
					domainName={domainName}
					onDomainNameChange={setDomainName}
					acmCertificate={acmCertificate}
					onAcmCertificateChange={setAcmCertificate}
					cloudfrontWaf={cloudfrontWaf}
					onCloudfrontWafChange={setCloudfrontWaf}
					applicationWaf={applicationWaf}
					onApplicationWafChange={setApplicationWaf}
					awsResources={awsResources}
				/>

				<SectionMessaging
					queues={queues}
					onQueuesChange={setQueues}
					topics={topics}
					onTopicsChange={setTopics}
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
						disabled={isLoading || !awsConnected}
						className="min-w-[160px]"
						title={!awsConnected ? "Connect your AWS account first" : undefined}
					>
						{isLoading ? (
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
				<CostSidebar
					databases={databases}
					caches={caches}
					enableDns={enableDns}
					cloudfrontWaf={cloudfrontWaf}
					applicationWaf={applicationWaf}
					enableKarpenter={enableKarpenter}
					region={region}
					instanceTypes={instanceTypes}
					nodeDesiredSize={nodeDesiredSize}
					singleNatGateway={singleNatGateway}
				/>
			</div>
		</form>
	);
}
