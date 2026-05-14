"use server";

import JSZip from "jszip";
import { configurationToInstallerYaml } from "@/lib/configurations/installer-config";
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

		const yamlContent = configurationToInstallerYaml(config);

		return {
			content: yamlContent,
			filename: `${config.project_name || 'output'}-config.yaml`
		};
	} catch (error) {
		console.error("Config generation error:", error);
		throw new Error("Failed to generate configuration file");
	}
}

const IDP_INSTALLER_VERSION = "1.2.6";
const IDP_INSTALLER_BUCKET = "installers";
const IDP_INSTALLER_PATH = `idp-installer-v${IDP_INSTALLER_VERSION}.zip`;

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

		await supabase
			.from("configurations")
			.update({
				download_count: (config.download_count || 0) + 1,
				last_downloaded_at: new Date().toISOString(),
			})
			.eq("id", id);

		const yamlContent = configurationToInstallerYaml(config);
		const configFilename = `${config.project_name || "output-file"}.yml`;

		const { data: downloadData, error: downloadError } = await supabase.storage
			.from(IDP_INSTALLER_BUCKET)
			.download(IDP_INSTALLER_PATH);

		if (downloadError || !downloadData) {
			throw new Error(
				`Failed to fetch installer archive: ${downloadError?.message}`,
			);
		}
		const installerBuffer = Buffer.from(await downloadData.arrayBuffer());

		const zip = await JSZip.loadAsync(installerBuffer);

		const rootFolder = `idp-installer-v${IDP_INSTALLER_VERSION}`;
		zip.file(`${rootFolder}/config/${configFilename}`, yamlContent);

		const zipBuffer = await zip.generateAsync({ type: "nodebuffer" });

		return {
			content: zipBuffer.toString("base64"),
			filename: `idp-installer-v${IDP_INSTALLER_VERSION}.zip`,
		};
	} catch (error) {
		console.error("ZIP generation error:", error);
		throw new Error("Failed to generate installer package");
	}
}
