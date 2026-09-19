// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import {
	AUTOSCALER,
	DEFAULT_INSTANCE_TYPE,
	DEFAULT_K8S_VERSION,
	type CloudProviderSlug,
} from "@/lib/cloud-providers";
import { designRevision } from "@/lib/canvas/design-revision";
import type { ProjectFormData } from "@/lib/validations/project-form.schema";

/** A project loaded as the canvas source (its config + the cloud it was authored on). */
export interface SourceProjectData {
	formData: ProjectFormData;
	provider: CloudProviderSlug;
	/**
	 * The design's content hash (`designRevision(formData)`). A producer that already knows it
	 * may pass it; when absent, `sourceRevision` derives it from `formData` — so the page that
	 * hands `getProjectAsFormData`'s result straight through needs no change.
	 */
	revision?: string;
}

/**
 * The revision the canvas seeds `source` under: the producer's when it gave one, else a hash of
 * the form data it carries. Two renders of the same design hand the store the same revision, so
 * a re-render is not a re-seed.
 */
export function sourceRevision(source: SourceProjectData): string {
	return source.revision ?? designRevision(buildDefaultFormValues(source));
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
			storage_buckets: [],
			container_registries: [],
			helm_registries: [],
			services: [],
		}
	);
}
