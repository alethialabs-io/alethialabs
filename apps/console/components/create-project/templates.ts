// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { CreateProjectInput } from "@/app/server/actions/projects";
import {
	AUTOSCALER,
	DEFAULT_INSTANCE_TYPE,
	DEFAULT_K8S_VERSION,
	DEFAULT_REGION,
	type CloudProviderSlug,
} from "@/lib/cloud-providers";
import type { EnvironmentStage } from "@/lib/db/schema";

/** The quick-create template ids. UI-only — there is no template column in the schema. */
export type TemplateId = "standard" | "ai" | "custom";

/** GPU instance type per provisionable provider, used by the AI Workloads template. */
const GPU_INSTANCE: Record<CloudProviderSlug, string> = {
	aws: "g4dn.xlarge",
	gcp: "a2-highgpu-1g",
	azure: "Standard_NC4as_T4_v3",
	// Hetzner has no GPU instances — the AI template falls back to the default node type.
	hetzner: "",
	alibaba: "ecs.gn6i-c4g1.xlarge",
};

/** Picks the node instance type for a template + provider (GPU for AI, default otherwise). */
function instanceTypeFor(template: TemplateId, provider: CloudProviderSlug): string {
	// A falsy GPU entry (e.g. providers without GPU nodes) falls back to the default type.
	if (template === "ai") return GPU_INSTANCE[provider] || DEFAULT_INSTANCE_TYPE[provider];
	return DEFAULT_INSTANCE_TYPE[provider];
}

/** A quick-create environment row (the rail's Production / Preview entries). */
export interface QuickEnvironment {
	/** Slug-safe environment name (also the tofu state-path segment), e.g. "production". */
	name: string;
	stage: EnvironmentStage;
	region: string;
}

/**
 * Builds the full {@link CreateProjectInput} for a quick-create submission. The form only
 * captures a name, template and cloud; everything else is derived from the chosen template
 * and per-provider presets so the project is valid and immediately designable. The first
 * environment seeds the project's default env (createProject), the rest are added afterwards.
 */
export function buildCreateInput(args: {
	projectName: string;
	template: TemplateId;
	provider: CloudProviderSlug;
	cloudIdentityId: string;
	defaultEnvironment: QuickEnvironment;
}): CreateProjectInput {
	const { projectName, template, provider, cloudIdentityId, defaultEnvironment } = args;
	const autoscalerKey = AUTOSCALER[provider].providerConfigKey;

	return {
		project: {
			project_name: projectName,
			environment_stage: defaultEnvironment.stage,
			region: defaultEnvironment.region,
			cloud_identity_id: cloudIdentityId,
			iac_version: "1.11.4",
		},
		network: {
			provision_network: true,
			cidr_block: "10.0.0.0/16",
			single_nat_gateway: true,
		},
		cluster: {
			cluster_version: DEFAULT_K8S_VERSION[provider],
			instance_types: [instanceTypeFor(template, provider)],
			node_min_size: 2,
			node_max_size: 5,
			node_desired_size: 2,
			cluster_admins: [],
			provider_config: { [autoscalerKey]: true },
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
	};
}

/**
 * Builds a minimal {@link CreateProjectInput} for an EMPTY project — name only, no cloud, no
 * template. `region` is `notNull` so we default it (the cloud + real region are chosen later on
 * the design page). The cluster/network rows exist but carry blank defaults to design from scratch.
 */
export function buildEmptyCreateInput(args: {
	projectName: string;
	defaultEnvironment: QuickEnvironment;
}): CreateProjectInput {
	const { projectName, defaultEnvironment } = args;

	return {
		project: {
			project_name: projectName,
			environment_stage: defaultEnvironment.stage,
			region: defaultEnvironment.region || DEFAULT_REGION.aws,
			cloud_identity_id: null,
			iac_version: "1.11.4",
		},
		network: {
			provision_network: true,
			cidr_block: "10.0.0.0/16",
			single_nat_gateway: true,
		},
		cluster: {
			cluster_version: "1.31",
			instance_types: [],
			node_min_size: 2,
			node_max_size: 5,
			node_desired_size: 2,
			cluster_admins: [],
			provider_config: {},
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
	};
}
