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
	hetzner: [
		{ value: "cax11", label: "CAX11 (Arm)", vcpu: 2, memoryGb: 4, cost: "~€4/mo" },
		{ value: "cax21", label: "CAX21 (Arm)", vcpu: 4, memoryGb: 8, cost: "~€8/mo" },
		{ value: "cax31", label: "CAX31 (Arm)", vcpu: 8, memoryGb: 16, cost: "~€21/mo" },
		{ value: "cx23", label: "CX23 (x86)", vcpu: 2, memoryGb: 4, cost: "~€5/mo" },
		{ value: "cx33", label: "CX33 (x86)", vcpu: 4, memoryGb: 8, cost: "~€8/mo" },
	],
	alibaba: [
		{ value: "ecs.c6.large", label: "c6.large", vcpu: 2, memoryGb: 4, cost: "~$35/mo" },
		{ value: "ecs.g6.large", label: "g6.large", vcpu: 2, memoryGb: 8, cost: "~$50/mo" },
		{ value: "ecs.g6.xlarge", label: "g6.xlarge", vcpu: 4, memoryGb: 16, cost: "~$100/mo" },
		{ value: "ecs.c6.xlarge", label: "c6.xlarge", vcpu: 4, memoryGb: 8, cost: "~$70/mo" },
		{ value: "ecs.r6.large", label: "r6.large", vcpu: 2, memoryGb: 16, cost: "~$75/mo" },
		{ value: "ecs.g6.2xlarge", label: "g6.2xlarge", vcpu: 8, memoryGb: 32, cost: "~$200/mo" },
	],
};

/**
 * Supported Kubernetes versions per provider (latest first). Mirrors the catalog SSOT
 * (packages/core/catalog/catalog.json → k8s_versions); keep in lockstep — bump there.
 */
export const K8S_VERSIONS: Record<CloudProviderSlug, string[]> = {
	aws: ["1.35", "1.34", "1.33"],
	gcp: ["1.35", "1.34", "1.33"],
	azure: ["1.35", "1.34", "1.33"],
	// Single validated version: Hetzner's k8s is coupled to the pinned Talos release
	// (v1.13.6 → k8s 1.35), so we expose only what that Talos ships/validates, not a
	// free 3-minor range the provisioner can't map to concrete Talos patches (#879).
	hetzner: ["1.35"],
	alibaba: ["1.35", "1.34", "1.33"],
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
	hetzner: {
		providerConfigKey: "enable_cluster_autoscaler",
		label: "Cluster Autoscaler",
		description: "hcloud autoscaler adds/removes nodes based on pending pods",
	},
	alibaba: {
		providerConfigKey: "enable_cluster_autoscaler",
		label: "Cluster Autoscaler",
		description: "ACK auto-scales node pools by pending pods",
	},
};

/** Default instance type per provider (used for new project forms). */
export const DEFAULT_INSTANCE_TYPE: Record<CloudProviderSlug, string> = {
	aws: "t3.medium",
	gcp: "e2-medium",
	azure: "Standard_D2s_v5",
	hetzner: "cax11",
	alibaba: "ecs.g6.large",
};

/**
 * Default K8s version per provider (new-project form seed). Source of truth is the catalog
 * (packages/core/catalog/catalog.json → default_k8s_version); the provisioning path resolves
 * from it directly (resolveK8sVersion). Keep these in lockstep with the catalog — bump there.
 * Hetzner reached 1.35 with the Talos v1.13.6 bump (#879); its Talos release couples the two.
 */
export const DEFAULT_K8S_VERSION: Record<CloudProviderSlug, string> = {
	aws: "1.35",
	gcp: "1.35",
	azure: "1.35",
	hetzner: "1.35",
	alibaba: "1.35",
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
		hetzner: {
			"t3.medium": "cax11",
			"t3.large": "cax21",
			"t3.xlarge": "cax31",
			"m5a.large": "cax11",
			"m5a.xlarge": "cax11",
			"c5.large": "cax11",
			"c5.xlarge": "cax11",
			"r5.large": "cax11",
			"g4dn.xlarge": "cax11",
		},
		alibaba: {
			"t3.medium": "ecs.g6.large",
			"t3.large": "ecs.g6.large",
			"t3.xlarge": "ecs.g6.xlarge",
			"m5a.large": "ecs.g6.large",
			"m5a.xlarge": "ecs.g6.xlarge",
			"c5.large": "ecs.c6.large",
			"c5.xlarge": "ecs.c6.xlarge",
			"r5.large": "ecs.r6.large",
			"g4dn.xlarge": "ecs.g6.2xlarge",
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
		hetzner: {
			"e2-medium": "cax11",
			"e2-standard-2": "cax21",
			"e2-standard-4": "cax31",
			"n2-standard-2": "cax21",
			"n2-standard-4": "cax31",
			"c2-standard-4": "cax31",
			"n2-highmem-2": "cax11",
			"n1-standard-1": "cax11",
		},
		alibaba: {
			"e2-medium": "ecs.g6.large",
			"e2-standard-2": "ecs.g6.large",
			"e2-standard-4": "ecs.g6.xlarge",
			"n2-standard-2": "ecs.g6.large",
			"n2-standard-4": "ecs.g6.xlarge",
			"c2-standard-4": "ecs.c6.xlarge",
			"n2-highmem-2": "ecs.r6.large",
			"n1-standard-1": "ecs.c6.large",
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
		hetzner: {
			"Standard_D2s_v5": "cax11",
			"Standard_D4s_v5": "cax21",
			"Standard_D8s_v5": "cax31",
			"Standard_D2as_v5": "cax11",
			"Standard_D4as_v5": "cax21",
			"Standard_F2s_v2": "cax11",
			"Standard_E2s_v5": "cax11",
			"Standard_NC4as_T4_v3": "cax11",
		},
		alibaba: {
			"Standard_D2s_v5": "ecs.g6.large",
			"Standard_D4s_v5": "ecs.g6.xlarge",
			"Standard_D8s_v5": "ecs.g6.2xlarge",
			"Standard_D2as_v5": "ecs.g6.large",
			"Standard_D4as_v5": "ecs.g6.xlarge",
			"Standard_F2s_v2": "ecs.c6.large",
			"Standard_E2s_v5": "ecs.r6.large",
			"Standard_NC4as_T4_v3": "ecs.g6.2xlarge",
		},
	},
	hetzner: {
		hetzner: {},
		aws: {
			cax11: "t3.medium",
			cax21: "t3.large",
			cax31: "t3.xlarge",
			cx23: "t3.medium",
			cx33: "t3.large",
		},
		gcp: {
			cax11: "e2-medium",
			cax21: "e2-standard-2",
			cax31: "e2-standard-4",
			cx23: "e2-medium",
			cx33: "e2-standard-2",
		},
		azure: {
			cax11: "Standard_D2s_v5",
			cax21: "Standard_D4s_v5",
			cax31: "Standard_D8s_v5",
			cx23: "Standard_D2s_v5",
			cx33: "Standard_D4s_v5",
		},
		alibaba: {
			cax11: "ecs.g6.large",
			cax21: "ecs.g6.xlarge",
			cax31: "ecs.g6.2xlarge",
			cx23: "ecs.g6.large",
			cx33: "ecs.g6.xlarge",
		},
	},
	alibaba: {
		alibaba: {},
		hetzner: {
			"ecs.c6.large": "cx23",
			"ecs.g6.large": "cax11",
			"ecs.g6.xlarge": "cax21",
			"ecs.c6.xlarge": "cx33",
			"ecs.r6.large": "cax21",
			"ecs.g6.2xlarge": "cax31",
		},
		aws: {
			"ecs.c6.large": "c5.large",
			"ecs.g6.large": "t3.large",
			"ecs.g6.xlarge": "t3.xlarge",
			"ecs.c6.xlarge": "c5.xlarge",
			"ecs.r6.large": "r5.large",
			"ecs.g6.2xlarge": "m5a.xlarge",
		},
		gcp: {
			"ecs.c6.large": "c2-standard-4",
			"ecs.g6.large": "e2-standard-2",
			"ecs.g6.xlarge": "e2-standard-4",
			"ecs.c6.xlarge": "c2-standard-4",
			"ecs.r6.large": "n2-highmem-2",
			"ecs.g6.2xlarge": "n2-standard-4",
		},
		azure: {
			"ecs.c6.large": "Standard_F2s_v2",
			"ecs.g6.large": "Standard_D2s_v5",
			"ecs.g6.xlarge": "Standard_D4s_v5",
			"ecs.c6.xlarge": "Standard_F2s_v2",
			"ecs.r6.large": "Standard_E2s_v5",
			"ecs.g6.2xlarge": "Standard_D8s_v5",
		},
	},
};
