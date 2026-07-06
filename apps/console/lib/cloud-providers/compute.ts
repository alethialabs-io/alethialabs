// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { ClusterProviderConfig } from "@/types/jsonb.types";
import type { CloudProviderSlug } from "./registry";

interface InstanceTypeOption {
	value: string;
	label: string;
	vcpu: number;
	memoryGb: number;
	cost: string;
}

/** Instance/machine type options per provider. */
export const INSTANCE_TYPES: Record<CloudProviderSlug, InstanceTypeOption[]> = {
	aws: [
		{ value: "t3.medium", label: "t3.medium", vcpu: 2, memoryGb: 4, cost: "~$30/mo" },
		{ value: "t3.large", label: "t3.large", vcpu: 2, memoryGb: 8, cost: "~$60/mo" },
		{ value: "t3.xlarge", label: "t3.xlarge", vcpu: 4, memoryGb: 16, cost: "~$121/mo" },
		{ value: "m5a.large", label: "m5a.large", vcpu: 2, memoryGb: 8, cost: "~$63/mo" },
		{ value: "m5a.xlarge", label: "m5a.xlarge", vcpu: 4, memoryGb: 16, cost: "~$125/mo" },
		{ value: "c5.large", label: "c5.large", vcpu: 2, memoryGb: 4, cost: "~$62/mo" },
		{ value: "c5.xlarge", label: "c5.xlarge", vcpu: 4, memoryGb: 8, cost: "~$124/mo" },
		{ value: "r5.large", label: "r5.large", vcpu: 2, memoryGb: 16, cost: "~$91/mo" },
		{ value: "g4dn.xlarge", label: "g4dn.xlarge (GPU)", vcpu: 4, memoryGb: 16, cost: "~$381/mo" },
	],
	gcp: [
		{ value: "e2-medium", label: "e2-medium", vcpu: 2, memoryGb: 4, cost: "~$25/mo" },
		{ value: "e2-standard-2", label: "e2-standard-2", vcpu: 2, memoryGb: 8, cost: "~$49/mo" },
		{ value: "e2-standard-4", label: "e2-standard-4", vcpu: 4, memoryGb: 16, cost: "~$98/mo" },
		{ value: "n2-standard-2", label: "n2-standard-2", vcpu: 2, memoryGb: 8, cost: "~$55/mo" },
		{ value: "n2-standard-4", label: "n2-standard-4", vcpu: 4, memoryGb: 16, cost: "~$110/mo" },
		{ value: "c2-standard-4", label: "c2-standard-4", vcpu: 4, memoryGb: 16, cost: "~$121/mo" },
		{ value: "n2-highmem-2", label: "n2-highmem-2", vcpu: 2, memoryGb: 16, cost: "~$73/mo" },
		{ value: "n1-standard-1", label: "n1-standard-1", vcpu: 1, memoryGb: 3.75, cost: "~$25/mo" },
		{ value: "a2-highgpu-1g", label: "a2-highgpu-1g (GPU)", vcpu: 12, memoryGb: 85, cost: "~$2523/mo" },
	],
	azure: [
		{ value: "Standard_D2s_v5", label: "D2s v5", vcpu: 2, memoryGb: 8, cost: "~$70/mo" },
		{ value: "Standard_D4s_v5", label: "D4s v5", vcpu: 4, memoryGb: 16, cost: "~$140/mo" },
		{ value: "Standard_D8s_v5", label: "D8s v5", vcpu: 8, memoryGb: 32, cost: "~$281/mo" },
		{ value: "Standard_D2as_v5", label: "D2as v5 (AMD)", vcpu: 2, memoryGb: 8, cost: "~$63/mo" },
		{ value: "Standard_D4as_v5", label: "D4as v5 (AMD)", vcpu: 4, memoryGb: 16, cost: "~$125/mo" },
		{ value: "Standard_F2s_v2", label: "F2s v2 (Compute)", vcpu: 2, memoryGb: 4, cost: "~$62/mo" },
		{ value: "Standard_E2s_v5", label: "E2s v5 (Memory)", vcpu: 2, memoryGb: 16, cost: "~$91/mo" },
		{ value: "Standard_NC4as_T4_v3", label: "NC4as T4 v3 (GPU)", vcpu: 4, memoryGb: 28, cost: "~$384/mo" },
	],
};

/** Supported Kubernetes versions per provider (latest first). */
export const K8S_VERSIONS: Record<CloudProviderSlug, string[]> = {
	aws: ["1.32", "1.31", "1.30", "1.29"],
	gcp: ["1.31", "1.30", "1.29", "1.28"],
	azure: ["1.31", "1.30", "1.29", "1.28"],
};

interface AutoscalerMeta {
	providerConfigKey: keyof ClusterProviderConfig;
	label: string;
	description: string;
}

/** Provider-specific cluster autoscaler configuration. */
export const AUTOSCALER: Record<CloudProviderSlug, AutoscalerMeta> = {
	aws: {
		providerConfigKey: "enable_karpenter",
		label: "Karpenter",
		description: "Just-in-time node provisioning based on pending pod requirements",
	},
	gcp: {
		providerConfigKey: "enable_autopilot",
		label: "Autopilot",
		description: "Fully managed node auto-provisioning by GKE",
	},
	azure: {
		providerConfigKey: "enable_cluster_autoscaler",
		label: "Cluster Autoscaler",
		description: "Automatic node pool scaling based on resource requests",
	},
};

/** Default instance type per provider (used for new project forms). */
export const DEFAULT_INSTANCE_TYPE: Record<CloudProviderSlug, string> = {
	aws: "t3.medium",
	gcp: "e2-medium",
	azure: "Standard_D2s_v5",
};

/** Default K8s version per provider. */
export const DEFAULT_K8S_VERSION: Record<CloudProviderSlug, string> = {
	aws: "1.32",
	gcp: "1.31",
	azure: "1.31",
};

/** Cross-provider instance type mapping for project conversion. */
export const INSTANCE_TYPE_MAP: Record<
	CloudProviderSlug,
	Record<CloudProviderSlug, Record<string, string>>
> = {
	aws: {
		aws: {},
		gcp: {
			"t3.medium": "e2-medium",
			"t3.large": "e2-standard-2",
			"t3.xlarge": "e2-standard-4",
			"m5a.large": "n2-standard-2",
			"m5a.xlarge": "n2-standard-4",
			"c5.large": "c2-standard-4",
			"c5.xlarge": "c2-standard-4",
			"r5.large": "n2-highmem-2",
			"g4dn.xlarge": "a2-highgpu-1g",
		},
		azure: {
			"t3.medium": "Standard_D2s_v5",
			"t3.large": "Standard_D2s_v5",
			"t3.xlarge": "Standard_D4s_v5",
			"m5a.large": "Standard_D2as_v5",
			"m5a.xlarge": "Standard_D4as_v5",
			"c5.large": "Standard_F2s_v2",
			"c5.xlarge": "Standard_F2s_v2",
			"r5.large": "Standard_E2s_v5",
			"g4dn.xlarge": "Standard_NC4as_T4_v3",
		},
	},
	gcp: {
		gcp: {},
		aws: {
			"e2-medium": "t3.medium",
			"e2-standard-2": "t3.large",
			"e2-standard-4": "t3.xlarge",
			"n2-standard-2": "m5a.large",
			"n2-standard-4": "m5a.xlarge",
			"c2-standard-4": "c5.xlarge",
			"n2-highmem-2": "r5.large",
			"n1-standard-1": "t3.medium",
		},
		azure: {
			"e2-medium": "Standard_D2s_v5",
			"e2-standard-2": "Standard_D2s_v5",
			"e2-standard-4": "Standard_D4s_v5",
			"n2-standard-2": "Standard_D2as_v5",
			"n2-standard-4": "Standard_D4as_v5",
			"c2-standard-4": "Standard_F2s_v2",
			"n2-highmem-2": "Standard_E2s_v5",
		},
	},
	azure: {
		azure: {},
		aws: {
			"Standard_D2s_v5": "t3.large",
			"Standard_D4s_v5": "t3.xlarge",
			"Standard_D8s_v5": "m5a.xlarge",
			"Standard_D2as_v5": "m5a.large",
			"Standard_D4as_v5": "m5a.xlarge",
			"Standard_F2s_v2": "c5.large",
			"Standard_E2s_v5": "r5.large",
			"Standard_NC4as_T4_v3": "g4dn.xlarge",
		},
		gcp: {
			"Standard_D2s_v5": "e2-standard-2",
			"Standard_D4s_v5": "e2-standard-4",
			"Standard_D8s_v5": "n2-standard-4",
			"Standard_D2as_v5": "n2-standard-2",
			"Standard_D4as_v5": "n2-standard-4",
			"Standard_F2s_v2": "c2-standard-4",
			"Standard_E2s_v5": "n2-highmem-2",
			"Standard_NC4as_T4_v3": "a2-highgpu-1g",
		},
	},
};
