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

function nestDict(data: Record<string, unknown>): Record<string, unknown> {
	const nested: Record<string, unknown> = {};

	for (const [key, value] of Object.entries(data)) {
		if (value === undefined || value === null || value === "") continue;

		const keys = key.split("_");
		let current: Record<string, unknown> = nested;

		for (let i = 0; i < keys.length - 1; i++) {
			if (!current[keys[i]]) {
				current[keys[i]] = {};
			}
			current = current[keys[i]] as Record<string, unknown>;
		}

		current[keys[keys.length - 1]] = value;
	}

	return nested;
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
		const nestedData = nestDict(configData);

		// Generate YAML
		let yamlContent = yaml.dump(nestedData, {
			noRefs: true,
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
		const nestedData = nestDict(configData);

		// Generate YAML
		let yamlContent = yaml.dump(nestedData, {
			noRefs: true,
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
