// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import {
	AUTOSCALER,
	DEFAULT_INSTANCE_TYPE,
	DEFAULT_K8S_VERSION,
	type CloudProviderSlug,
} from "@/lib/cloud-providers";
import type { ProjectFormData } from "@/lib/validations/project-form.schema";

/** A project loaded as the canvas source (its config + the cloud it was authored on). */
export interface SourceProjectData {
	formData: ProjectFormData;
	provider: CloudProviderSlug;
}

/**
 * Default config values for a fresh project (or the source project being loaded). Used to
 * seed the canvas store's graph via `formToGraph`. The shape mirrors `ProjectFormData` so
 * the graph⇄form round-trip + zod validation keep working.
 */
export function buildDefaultFormValues(
	sourceProject?: SourceProjectData,
): ProjectFormData {
	return (
		sourceProject?.formData ?? {
			project: {
				project_name: "",
				environment_stage: "development",
				region: "",
				cloud_identity_id: "",
				iac_version: "1.11.4",
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
			},
			dns: {
				enabled: false,
				managed_certificate: false,
				waf_enabled: false,
				provider_config: {},
			},
			repositories: {},
			source_repos: [],
			databases: [],
			caches: [],
			queues: [],
			topics: [],
			nosql_tables: [],
			secrets: [],
		}
	);
}
