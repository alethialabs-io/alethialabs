import yaml from "js-yaml";

type ConfigRecord = Record<string, unknown>;

function parseYamlField(value: unknown): unknown {
	if (typeof value !== "string" || value.trim() === "") {
		return value;
	}

	try {
		return yaml.load(value);
	} catch {
		return value;
	}
}

function asStringArray(value: unknown): string[] {
	if (Array.isArray(value)) {
		return value.filter((item): item is string => typeof item === "string");
	}

	if (typeof value === "string") {
		return value
			.split(",")
			.map((item) => item.trim())
			.filter(Boolean);
	}

	return [];
}

export function stripConfigurationMetadata(config: ConfigRecord): ConfigRecord {
	const {
		id: _id,
		user_id: _userId,
		created_at: _createdAt,
		updated_at: _updatedAt,
		status: _status,
		cluster_id: _clusterId,
		cloud_identity_id: _cloudIdentityId,
		download_count: _downloadCount,
		last_downloaded_at: _lastDownloadedAt,
		full_config: _fullConfig,
		...configData
	} = config;

	void _id;
	void _userId;
	void _createdAt;
	void _updatedAt;
	void _status;
	void _clusterId;
	void _cloudIdentityId;
	void _downloadCount;
	void _lastDownloadedAt;
	void _fullConfig;

	for (const field of [
		"eks_cluster_admins",
		"ses_queues_topics",
		"redis_allowed_cidr_blocks",
	]) {
		configData[field] = parseYamlField(configData[field]);
	}

	return configData;
}

export function formatInstallerConfig(configData: ConfigRecord): ConfigRecord {
	const redisAllowedCidr = asStringArray(
		configData.redis_allowed_cidr_blocks,
	);

	let eksAdmins = configData.eks_cluster_admins || [];
	if (
		eksAdmins &&
		!Array.isArray(eksAdmins) &&
		typeof eksAdmins === "object" &&
		"eks_cluster_admins" in eksAdmins
	) {
		eksAdmins = (eksAdmins as ConfigRecord).eks_cluster_admins || [];
	}

	const isAI = configData.container_platform === "ai-workloads";
	const isStandard = configData.container_platform === "standard";

	const envRepo = "git@github.com:itgix/adp-tf-envtempl-standard.git";
	let envBranch = "v1.2.7";
	let gitopsRepo = "git@github.com:itgix/adp-k8s-templ-argoinfrasvcs.git";
	const gitopsBranch = "main";

	if (isAI) {
		envBranch = "v1.2.3-ai";
		gitopsRepo = "git@github.com:itgix/adp-k8s-aitempl-argoinfra.git";
	} else if (!isStandard) {
		envBranch = "main";
	}

	const result: ConfigRecord = {
		project_name: configData.project_name || "adpminidemo",
		environment: configData.environment_stage || "dev",
		region: configData.aws_region || "eu-west-1",
		aws_account_id: configData.aws_account_id || "791296381042",
		terraform_ver: configData.terraform_version || "1.11.4",

		env_template_repo: envRepo,
		env_template_repo_branch: envBranch,
		env_git_repo:
			configData.env_git_repo ||
			"git@gitlab.itgix.com:rnd/app-platform/demo-environments/demo-ai-tf-test.git",

		gitops_template_repo: gitopsRepo,
		gitops_template_repo_branch: gitopsBranch,
		gitops_destination_repo:
			configData.gitops_destination_repo ||
			"https://gitlab.itgix.com/rnd/app-platform/demo-environments/demo-aiargoinfra-test.git",

		provision_vpc: configData.create_vpc ?? true,
		vpc_cidr: configData.vpc_cidr || "10.56.0.0/16",
		vpc_single_nat_gateway: true,

		dns_hosted_zone:
			configData.dns_hosted_zone || "Z0656101RR1KENJQ3ZYF",
		dns_main_domain: configData.dns_domain_name || "adplab.itgix.eu",
		acm_certificate_enable: configData.enable_dns ?? true,

		create_rds: configData.create_rds ?? false,
		rds_scaling_config: {
			min_capacity: configData.db_min_capacity ?? 0.5,
		},

		eks_cluster_admins: eksAdmins,
		eks_access_entries: {},
		provision_sqs: false,
		application_waf_enabled: false,
		cloudfront_waf_enabled: configData.enable_cloudfront_waf ?? false,
		create_elasticache_redis: configData.enable_redis ?? false,
		redis_allowed_cidr_blocks:
			redisAllowedCidr.length > 0 ? redisAllowedCidr : ["10.56.0.0/16"],
		enable_karpenter: configData.enable_karpenter ?? true,
		provision_ecr: false,
		enable_fluent_bit: true,
		allow_long_names: true,
		enable_devlake: true,
		backstage_enabled: true,
		enable_kyverno: false,
		enable_kyverno_policies: false,
		enable_policy_reporter: false,
		custom_secrets: [
			{
				secret_name: "postgres-password",
				length: 32,
				special: true,
				override_special: "$_+",
			},
		],
		enable_prometheus_stack: true,
		enable_tempo: true,
		enable_loki: true,
		eks_ng_min_size: 3,
		eks_ng_desired_size: 3,
		eks_ng_max_size: 4,
	};

	if (configData.gitops_argocd_token) {
		result.gitops_argo_access_token = configData.gitops_argocd_token;
	}

	if (configData.enable_gitops_destination) {
		result.applications_template_repo =
			configData.applications_template_repo ||
			"git@github.com:itgix/adp-k8s-templ-argoappsdemo.git";
		result.applications_destination_repo =
			configData.applications_destination_repo ||
			"https://gitlab.itgix.com/rnd/app-platform/demo-environments/demo-argocd-services-client.git";

		if (configData.gitops_app_token) {
			result.applications_argo_access_token = configData.gitops_app_token;
		}
	}

	if (configData.ses_queues_topics) {
		result.ses_queues_topics = configData.ses_queues_topics;
	}

	return result;
}

export function configurationToInstallerYaml(config: ConfigRecord): string {
	const configData = stripConfigurationMetadata(config);
	const installerConfig = formatInstallerConfig(configData);

	return yaml
		.dump(installerConfig, {
			noRefs: true,
			lineWidth: -1,
			forceQuotes: true,
			quotingType: '"',
		})
		.replace(/null/g, "")
		.replace(/None/g, "");
}
