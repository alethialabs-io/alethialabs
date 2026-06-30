// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { CloudProviderSlug } from "./registry";

interface CacheNodeOption {
	value: string;
	label: string;
	memoryGb: number;
	cost: string;
}

/** Cache node type options per provider. */
export const CACHE_NODE_TYPES: Record<CloudProviderSlug, CacheNodeOption[]> = {
	aws: [
		{ value: "cache.t3.micro", label: "t3.micro", memoryGb: 0.5, cost: "~$12/mo" },
		{ value: "cache.t3.small", label: "t3.small", memoryGb: 1.37, cost: "~$18/mo" },
		{ value: "cache.t3.medium", label: "t3.medium", memoryGb: 3.09, cost: "~$25/mo" },
		{ value: "cache.r6g.large", label: "r6g.large", memoryGb: 13.07, cost: "~$108/mo" },
		{ value: "cache.r6g.xlarge", label: "r6g.xlarge", memoryGb: 26.32, cost: "~$216/mo" },
	],
	gcp: [
		{ value: "M1", label: "Basic 1 GB", memoryGb: 1, cost: "~$35/mo" },
		{ value: "M2", label: "Basic 4 GB", memoryGb: 4, cost: "~$100/mo" },
		{ value: "M3", label: "Standard 10 GB", memoryGb: 10, cost: "~$230/mo" },
		{ value: "M4", label: "Standard 35 GB", memoryGb: 35, cost: "~$650/mo" },
	],
	azure: [
		{ value: "C0", label: "Basic C0", memoryGb: 0.25, cost: "~$15/mo" },
		{ value: "C1", label: "Basic C1", memoryGb: 1, cost: "~$35/mo" },
		{ value: "C2", label: "Standard C2", memoryGb: 2.5, cost: "~$80/mo" },
		{ value: "C3", label: "Standard C3", memoryGb: 6, cost: "~$155/mo" },
		{ value: "P1", label: "Premium P1", memoryGb: 6, cost: "~$210/mo" },
	],
};

/** Default cache node type per provider. */
export const DEFAULT_CACHE_NODE: Record<CloudProviderSlug, string> = {
	aws: "cache.t3.medium",
	gcp: "M1",
	azure: "C1",
};

/** Cross-provider cache node mapping for project conversion. */
export const CACHE_NODE_MAP: Record<
	CloudProviderSlug,
	Record<CloudProviderSlug, Record<string, string>>
> = {
	aws: {
		aws: {},
		gcp: {
			"cache.t3.micro": "M1",
			"cache.t3.small": "M1",
			"cache.t3.medium": "M2",
			"cache.r6g.large": "M3",
			"cache.r6g.xlarge": "M4",
		},
		azure: {
			"cache.t3.micro": "C0",
			"cache.t3.small": "C1",
			"cache.t3.medium": "C2",
			"cache.r6g.large": "C3",
			"cache.r6g.xlarge": "P1",
		},
	},
	gcp: {
		gcp: {},
		aws: { M1: "cache.t3.small", M2: "cache.t3.medium", M3: "cache.r6g.large", M4: "cache.r6g.xlarge" },
		azure: { M1: "C1", M2: "C2", M3: "C3", M4: "P1" },
	},
	azure: {
		azure: {},
		aws: { C0: "cache.t3.micro", C1: "cache.t3.small", C2: "cache.t3.medium", C3: "cache.r6g.large", P1: "cache.r6g.xlarge" },
		gcp: { C0: "M1", C1: "M1", C2: "M2", C3: "M3", P1: "M4" },
	},
};
