"use server";

import fs from "fs";
import yaml from "js-yaml";
import JSZip from "jszip";
import path from "path";
import { createClient } from "@/lib/supabase/server";
import { PublicConfigurationsInsert } from "@/lib/validations/db.schemas";
import { Database } from "@/types/database.types";
import { QueryData, SupabaseClient } from "@supabase/supabase-js";

// Helper function to extract types for export without executing queries
const getQueryTypes = (supabase: SupabaseClient<Database>) => {
	const getConfigurationsQuery = supabase
		.from("configurations")
		.select("*")
		.order("created_at", { ascending: false });

	const createConfigurationQuery = supabase
		.from("configurations")
		.insert({} as any)
		.select()
		.single();

	const getConfigurationByIdQuery = supabase
		.from("configurations")
		.select("*")
		.eq("id", "dummy")
		.single();

	const updateConfigurationQuery = supabase
		.from("configurations")
		.update({} as any)
		.eq("id", "dummy")
		.select()
		.single();

	const getConfigurationStatsQuery = supabase
		.rpc("get_configuration_stats")
		.single();

	return {
		getConfigurationsQuery,
		createConfigurationQuery,
		getConfigurationByIdQuery,
		updateConfigurationQuery,
		getConfigurationStatsQuery,
	};
};

export type GetConfigurationsData = QueryData<
	ReturnType<typeof getQueryTypes>["getConfigurationsQuery"]
>;
export type CreateConfigurationData = QueryData<
	ReturnType<typeof getQueryTypes>["createConfigurationQuery"]
>;
export type GetConfigurationByIdData = QueryData<
	ReturnType<typeof getQueryTypes>["getConfigurationByIdQuery"]
>;
export type UpdateConfigurationData = QueryData<
	ReturnType<typeof getQueryTypes>["updateConfigurationQuery"]
>;
export type GetConfigurationStatsData = QueryData<
	ReturnType<typeof getQueryTypes>["getConfigurationStatsQuery"]
>;

export async function getConfigurations(options?: {
	status?: string;
	limit?: number;
	offset?: number;
}) {
	try {
		const supabase = await createClient();

		let getConfigurationsQuery = supabase
			.from("configurations")
			.select("*")
			.order("created_at", { ascending: false });

		if (options?.status) {
			getConfigurationsQuery = getConfigurationsQuery.eq(
				"status",
				options.status,
			);
		}

		if (options?.limit) {
			getConfigurationsQuery = getConfigurationsQuery.limit(
				options.limit,
			);
		}

		if (options?.offset) {
			getConfigurationsQuery = getConfigurationsQuery.range(
				options.offset,
				options.offset + (options.limit ? options.limit : 10) - 1,
			);
		}

		const { data, error } = await getConfigurationsQuery;

		if (error) {
			console.error("Error fetching configurations:", error);
			throw new Error(error.message);
		}

		const configurations: GetConfigurationsData = data;
		return { configurations };
	} catch (error) {
		console.error("Unexpected error:", error);
		throw error;
	}
}

export async function createConfiguration(body: PublicConfigurationsInsert) {
	try {
		const supabase = await createClient();

		const {
			data: { user },
		} = await supabase.auth.getUser();

		if (!user) {
			throw new Error("Unauthorized");
		}

		// Ensure user_id is set to the authenticated user and clean up empty strings for UUIDs
		const payload = {
			...body,
			user_id: user.id,
			cluster_id: body.cluster_id === "" ? null : body.cluster_id,
			cloud_identity_id:
				body.cloud_identity_id === "" ? null : body.cloud_identity_id,
		};

		const createConfigurationQuery = supabase
			.from("configurations")
			.insert(payload)
			.select()
			.single();

		const { data, error } = await createConfigurationQuery;

		if (error) {
			console.error("Error creating configuration:", error);
			throw new Error(error.message);
		}

		const configuration: CreateConfigurationData = data;
		return { configuration };
	} catch (error) {
		console.error("Unexpected error:", error);
		throw error;
	}
}

export async function getConfigurationById(id: string) {
	try {
		const supabase = await createClient();

		const getConfigurationByIdQuery = supabase
			.from("configurations")
			.select("*")
			.eq("id", id)
			.single();

		const { data, error } = await getConfigurationByIdQuery;

		if (error) {
			throw new Error(error.message);
		}

		const configuration: GetConfigurationByIdData = data;
		return { configuration };
	} catch (error) {
		console.error("Unexpected error:", error);
		throw error;
	}
}

export async function updateConfiguration(id: string, body: any) {
	try {
		const supabase = await createClient();

		const updateConfigurationQuery = supabase
			.from("configurations")
			.update(body)
			.eq("id", id)
			.select()
			.single();

		const { data, error } = await updateConfigurationQuery;

		if (error) {
			throw new Error(error.message);
		}

		const configuration: UpdateConfigurationData = data;
		return { configuration };
	} catch (error) {
		console.error("Unexpected error:", error);
		throw error;
	}
}

export async function deleteConfiguration(id: string) {
	try {
		const supabase = await createClient();

		const deleteConfigurationQuery = supabase
			.from("configurations")
			.delete()
			.eq("id", id);

		const { error } = await deleteConfigurationQuery;

		if (error) {
			throw new Error(error.message);
		}

		return { success: true };
	} catch (error) {
		console.error("Unexpected error:", error);
		throw error;
	}
}

export async function getConfigurationStats() {
	try {
		const supabase = await createClient();

		const getConfigurationStatsQuery = supabase
			.rpc("get_configuration_stats")
			.single();

		const { data, error } = await getConfigurationStatsQuery;

		if (error) {
			throw new Error(error.message);
		}

		const stats: GetConfigurationStatsData = data;

		return { stats };
	} catch (error) {
		console.error("Unexpected error:", error);
		throw error;
	}
}

function formatInstallerConfig(configData: Record<string, any>): Record<string, any> {
        let redisAllowedCidr: string[] = [];
        if (Array.isArray(configData.redis_allowed_cidr_blocks)) {
                redisAllowedCidr = configData.redis_allowed_cidr_blocks;
        } else if (typeof configData.redis_allowed_cidr_blocks === "string") {
                redisAllowedCidr = configData.redis_allowed_cidr_blocks.split(',').map((s: string) => s.trim()).filter(Boolean);
        }

        let eksAdmins = configData.eks_cluster_admins || [];
        if (eksAdmins && !Array.isArray(eksAdmins) && eksAdmins.eks_cluster_admins) {
                eksAdmins = eksAdmins.eks_cluster_admins;
        }

	const isAI = configData.container_platform === "ai-workloads";
	const isStandard = configData.container_platform === "standard";

	let envRepo = "git@github.com:itgix/adp-tf-envtempl-standard.git";
	let envBranch = "v1.2.7";
	let gitopsRepo = "git@github.com:itgix/adp-k8s-templ-argoinfrasvcs.git";
	let gitopsBranch = "main";

	if (isAI) {
		envBranch = "v1.2.3-ai";
		gitopsRepo = "git@github.com:itgix/adp-k8s-aitempl-argoinfra.git";
	} else if (!isStandard) {
		envBranch = "main";
	}

        const result: Record<string, any> = {
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
		...(configData.gitops_argocd_token ? { gitops_argo_access_token: configData.gitops_argocd_token } : {}),

		...(configData.enable_gitops_destination ? {
			applications_template_repo:
				configData.applications_template_repo ||
				"git@github.com:itgix/adp-k8s-templ-argoappsdemo.git",
			applications_destination_repo:
				configData.applications_destination_repo ||
				"https://gitlab.itgix.com/rnd/app-platform/demo-environments/demo-argocd-services-client.git",
			...(configData.gitops_app_token ? { applications_argo_access_token: configData.gitops_app_token } : {})
		} : {}),

                provision_vpc: configData.create_vpc ?? true,
                vpc_cidr: configData.vpc_cidr || "10.56.0.0/16",
                vpc_single_nat_gateway: true,

                dns_hosted_zone: configData.dns_hosted_zone || "Z0656101RR1KENJQ3ZYF",
                dns_main_domain: configData.dns_domain_name || "adplab.itgix.eu",
                acm_certificate_enable: configData.enable_dns ?? true,

                create_rds: configData.create_rds ?? false,
                rds_scaling_config: {
                        min_capacity: configData.db_min_capacity ?? 0.5
                },

                eks_cluster_admins: eksAdmins,

                eks_access_entries: {},

                provision_sqs: false,
                application_waf_enabled: false,
                cloudfront_waf_enabled: configData.enable_cloudfront_waf ?? false,

                create_elasticache_redis: configData.enable_redis ?? false,
                redis_allowed_cidr_blocks: redisAllowedCidr.length > 0 ? redisAllowedCidr : ["10.56.0.0/16"],

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
                        { secret_name: "postgres-password", length: 32, special: true, override_special: "$_+" },
                ],

                enable_prometheus_stack: true,
                enable_tempo: true,
                enable_loki: true,

                eks_ng_min_size: 3,
                eks_ng_desired_size: 3,
                eks_ng_max_size: 4
        };

        if (configData.ses_queues_topics) {
                result.ses_queues_topics = configData.ses_queues_topics;
        }

        return result;
}
// Helper to recursively read directory
function addFilesToZip(dirPath: string, zip: JSZip, basePath: string) {
	if (!fs.existsSync(dirPath)) return;
	const files = fs.readdirSync(dirPath);
	for (const file of files) {
		// skip .git
		if (file.startsWith(".git")) continue;
		
		const fullPath = path.join(dirPath, file);
		const relativePath = path.relative(basePath, fullPath);
		
		const stat = fs.statSync(fullPath);
		if (stat.isDirectory()) {
			// recursively add directory
			addFilesToZip(fullPath, zip, basePath);
		} else {
			// add file
			const content = fs.readFileSync(fullPath);
			zip.file(relativePath, content);
		}
	}
}

export async function downloadConfigurationYaml(id: string) {
	try {
		const supabase = await createClient();
		const {
			data: { user },
		} = await supabase.auth.getUser();

		if (!user) {
			throw new Error("Unauthorized");
		}

		const { data: config, error: fetchError } = await supabase
			.from("configurations")
			.select("*")
			.eq("id", id)
			.eq("user_id", user.id)
			.single();

		if (fetchError || !config) {
			throw new Error("Configuration not found");
		}

		// Update download count
		await supabase
			.from("configurations")
			.update({
				download_count: (config.download_count || 0) + 1,
				last_downloaded_at: new Date().toISOString(),
			})
			.eq("id", id);

		// Remove internal Supabase fields
		const {
			id: _id,
			user_id: _user_id,
			created_at: _created_at,
			updated_at: _updated_at,
			status: _status,
			cluster_id: _cluster_id,
			cloud_identity_id: _cloud_identity_id,
			download_count: _download_count,
			last_downloaded_at: _last_downloaded_at,
			full_config: _full_config,
			...configData
		} = config as Record<string, any>;

		// Parse YAML fields
		const yamlFields = [
			"eks_cluster_admins",
			"ses_queues_topics",
			"redis_allowed_cidr_blocks",
		];

		for (const field of yamlFields) {
			if (typeof configData[field] === "string" && configData[field].trim() !== "") {
				try {
					configData[field] = yaml.load(configData[field]);
				} catch {
					console.warn(`Failed to parse YAML field: ${field}`);
				}
			}
		}

		// Convert and nest the data
		const nestedData = formatInstallerConfig(configData);

		// Generate YAML
		let yamlContent = yaml.dump(nestedData, {
			noRefs: true,
			lineWidth: -1,
			forceQuotes: true,
			quotingType: '"',
		});

		yamlContent = yamlContent.replace(/null/g, "").replace(/None/g, "");

		return {
			content: yamlContent,
			filename: `${config.project_name || 'output'}-config.yaml`
		};
	} catch (error) {
		console.error("Config generation error:", error);
		throw new Error("Failed to generate configuration file");
	}
}

export async function downloadConfigurationZip(id: string) {
	try {
		const supabase = await createClient();
		const {
			data: { user },
		} = await supabase.auth.getUser();

		if (!user) {
			throw new Error("Unauthorized");
		}

		const { data: config, error: fetchError } = await supabase
			.from("configurations")
			.select("*")
			.eq("id", id)
			.eq("user_id", user.id)
			.single();

		if (fetchError || !config) {
			throw new Error("Configuration not found");
		}

		// Update download count
		await supabase
			.from("configurations")
			.update({
				download_count: (config.download_count || 0) + 1,
				last_downloaded_at: new Date().toISOString(),
			})
			.eq("id", id);

		// Remove internal Supabase fields
		const {
			id: _id,
			user_id: _user_id,
			created_at: _created_at,
			updated_at: _updated_at,
			status: _status,
			cluster_id: _cluster_id,
			cloud_identity_id: _cloud_identity_id,
			download_count: _download_count,
			last_downloaded_at: _last_downloaded_at,
			full_config: _full_config,
			...configData
		} = config as Record<string, any>;

		// Parse YAML fields
		const yamlFields = [
			"eks_cluster_admins",
			"ses_queues_topics",
			"redis_allowed_cidr_blocks",
		];

		for (const field of yamlFields) {
			if (typeof configData[field] === "string" && configData[field].trim() !== "") {
				try {
					configData[field] = yaml.load(configData[field]);
				} catch {
					console.warn(`Failed to parse YAML field: ${field}`);
				}
			}
		}

		// Convert and nest the data
		const nestedData = formatInstallerConfig(configData);

		// Generate YAML
		let yamlContent = yaml.dump(nestedData, {
			noRefs: true,
			lineWidth: -1,
			forceQuotes: true,
			quotingType: '"',
		});

		yamlContent = yamlContent.replace(/null/g, "").replace(/None/g, "");

		// Create ZIP file
		const zip = new JSZip();
		const version = "1.0.0"; 

		let idpInstallerPath = path.join(process.cwd(), "../../idp-installer");
		
		if (!fs.existsSync(idpInstallerPath)) {
			idpInstallerPath = path.join(process.cwd(), "idp-installer");
		}
		
		if (fs.existsSync(idpInstallerPath)) {
			const folderName = `idp-installer-v${version}`;
			const zipFolder = zip.folder(folderName);
			if (zipFolder) {
				addFilesToZip(idpInstallerPath, zipFolder, idpInstallerPath);
				zipFolder.file("config/output-file.yaml", yamlContent); 
			}
		} else {
			zip.file(`idp-installer-v${version}/output-file.yaml`, yamlContent);
			zip.file(
				`idp-installer-v${version}/install.sh`,
				`#!/bin/bash
# ItGix Application Development Platform Installer
# Version ${version}

echo "Installing ItGix ADP..."
echo "Configuration file: output-file.yaml"

terraform init
terraform plan -var-file="output-file.yaml"
terraform apply -var-file="output-file.yaml"

echo "Installation complete!"
`
			);
			zip.file(
				`idp-installer-v${version}/README.md`,
				`# ItGix Application Development Platform

## Installation Guide
1. Extract this ZIP file
2. Review the output-file.yaml configuration
3. Run ./install.sh to deploy your infrastructure
`
			);
		}

		const zipBuffer = await zip.generateAsync({ type: "nodebuffer" });

		return {
			content: zipBuffer.toString("base64"),
			filename: `idp-installer-v${version}.zip`
		};
	} catch (error) {
		console.error("ZIP generation error:", error);
		throw new Error("Failed to generate ZIP file");
	}
}
