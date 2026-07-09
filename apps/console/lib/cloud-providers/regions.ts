// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { CloudProviderSlug } from "./registry";

interface RegionMeta {
	label: string;
	group: string;
}

/** Human-readable region labels and geographic groupings per provider. */
export const REGION_LABELS: Record<
	CloudProviderSlug,
	Record<string, RegionMeta>
> = {
	aws: {
		"us-east-1": { label: "N. Virginia", group: "United States" },
		"us-east-2": { label: "Ohio", group: "United States" },
		"us-west-1": { label: "N. California", group: "United States" },
		"us-west-2": { label: "Oregon", group: "United States" },
		"eu-west-1": { label: "Ireland", group: "Europe" },
		"eu-west-2": { label: "London", group: "Europe" },
		"eu-west-3": { label: "Paris", group: "Europe" },
		"eu-central-1": { label: "Frankfurt", group: "Europe" },
		"eu-central-2": { label: "Zurich", group: "Europe" },
		"eu-north-1": { label: "Stockholm", group: "Europe" },
		"eu-south-1": { label: "Milan", group: "Europe" },
		"ap-southeast-1": { label: "Singapore", group: "Asia Pacific" },
		"ap-southeast-2": { label: "Sydney", group: "Asia Pacific" },
		"ap-northeast-1": { label: "Tokyo", group: "Asia Pacific" },
		"ap-northeast-2": { label: "Seoul", group: "Asia Pacific" },
		"ap-south-1": { label: "Mumbai", group: "Asia Pacific" },
		"sa-east-1": { label: "São Paulo", group: "South America" },
	},
	gcp: {
		"us-central1": { label: "Iowa", group: "United States" },
		"us-east1": { label: "South Carolina", group: "United States" },
		"us-east4": { label: "N. Virginia", group: "United States" },
		"us-west1": { label: "Oregon", group: "United States" },
		"us-west2": { label: "Los Angeles", group: "United States" },
		"us-west4": { label: "Las Vegas", group: "United States" },
		"europe-west1": { label: "Belgium", group: "Europe" },
		"europe-west2": { label: "London", group: "Europe" },
		"europe-west3": { label: "Frankfurt", group: "Europe" },
		"europe-west4": { label: "Netherlands", group: "Europe" },
		"europe-west6": { label: "Zurich", group: "Europe" },
		"europe-north1": { label: "Finland", group: "Europe" },
		"asia-southeast1": { label: "Singapore", group: "Asia Pacific" },
		"asia-east1": { label: "Taiwan", group: "Asia Pacific" },
		"asia-northeast1": { label: "Tokyo", group: "Asia Pacific" },
		"asia-northeast2": { label: "Osaka", group: "Asia Pacific" },
		"asia-south1": { label: "Mumbai", group: "Asia Pacific" },
		"southamerica-east1": { label: "São Paulo", group: "South America" },
	},
	azure: {
		eastus: { label: "East US", group: "United States" },
		eastus2: { label: "East US 2", group: "United States" },
		centralus: { label: "Central US", group: "United States" },
		westus: { label: "West US", group: "United States" },
		westus2: { label: "West US 2", group: "United States" },
		westus3: { label: "West US 3", group: "United States" },
		westeurope: { label: "West Europe", group: "Europe" },
		northeurope: { label: "North Europe", group: "Europe" },
		uksouth: { label: "UK South", group: "Europe" },
		ukwest: { label: "UK West", group: "Europe" },
		germanywestcentral: { label: "Germany West Central", group: "Europe" },
		swedencentral: { label: "Sweden Central", group: "Europe" },
		francecentral: { label: "France Central", group: "Europe" },
		switzerlandnorth: { label: "Switzerland North", group: "Europe" },
		southeastasia: { label: "Southeast Asia", group: "Asia Pacific" },
		eastasia: { label: "East Asia", group: "Asia Pacific" },
		japaneast: { label: "Japan East", group: "Asia Pacific" },
		koreacentral: { label: "Korea Central", group: "Asia Pacific" },
		centralindia: { label: "Central India", group: "Asia Pacific" },
		brazilsouth: { label: "Brazil South", group: "South America" },
	},
	hetzner: {
		fsn1: { label: "Falkenstein, Germany", group: "Europe" },
		nbg1: { label: "Nuremberg, Germany", group: "Europe" },
		hel1: { label: "Helsinki, Finland", group: "Europe" },
		ash: { label: "Ashburn, VA", group: "United States" },
		hil: { label: "Hillsboro, OR", group: "United States" },
		sin: { label: "Singapore", group: "Asia Pacific" },
	},
};

/** Groups region codes into geographic sections using the registry labels. */
export function groupRegions(codes: string[], provider: CloudProviderSlug) {
	const labels = REGION_LABELS[provider] ?? {};
	const grouped = new Map<string, Array<{ value: string; label: string }>>();
	for (const code of codes) {
		const meta = labels[code];
		const group = meta?.group ?? "Other";
		const label = meta?.label ?? code;
		if (!grouped.has(group)) grouped.set(group, []);
		grouped.get(group)!.push({ value: code, label });
	}
	return Array.from(grouped.entries()).map(([group, regions]) => ({
		group,
		regions: regions.sort((a, b) => a.label.localeCompare(b.label)),
	}));
}

/** Default region per provider (used when no cached regions are available). */
export const DEFAULT_REGION: Record<CloudProviderSlug, string> = {
	aws: "eu-west-1",
	gcp: "europe-west1",
	azure: "westeurope",
	hetzner: "fsn1",
};

/** Cross-provider region mapping for project conversion. */
export const REGION_MAP: Record<
	CloudProviderSlug,
	Record<CloudProviderSlug, Record<string, string>>
> = {
	aws: {
		aws: {},
		gcp: {
			"us-east-1": "us-east4",
			"us-east-2": "us-central1",
			"us-west-1": "us-west1",
			"us-west-2": "us-west1",
			"eu-west-1": "europe-west1",
			"eu-west-2": "europe-west2",
			"eu-west-3": "europe-west1",
			"eu-central-1": "europe-west3",
			"eu-north-1": "europe-north1",
			"ap-southeast-1": "asia-southeast1",
			"ap-northeast-1": "asia-northeast1",
			"ap-south-1": "asia-south1",
			"sa-east-1": "southamerica-east1",
		},
		azure: {
			"us-east-1": "eastus",
			"us-east-2": "eastus2",
			"us-west-1": "westus",
			"us-west-2": "westus2",
			"eu-west-1": "westeurope",
			"eu-west-2": "uksouth",
			"eu-central-1": "germanywestcentral",
			"eu-north-1": "swedencentral",
			"ap-southeast-1": "southeastasia",
			"ap-northeast-1": "japaneast",
			"ap-south-1": "centralindia",
			"sa-east-1": "brazilsouth",
		},
		hetzner: {
			"us-east-1": "ash",
			"us-east-2": "ash",
			"us-west-1": "hil",
			"us-west-2": "hil",
			"eu-west-1": "fsn1",
			"eu-west-2": "fsn1",
			"eu-west-3": "fsn1",
			"eu-central-1": "fsn1",
			"eu-north-1": "hel1",
			"ap-southeast-1": "sin",
			"ap-northeast-1": "sin",
			"ap-south-1": "sin",
			"sa-east-1": "ash",
		},
	},
	gcp: {
		gcp: {},
		aws: {
			"us-east4": "us-east-1",
			"us-central1": "us-east-2",
			"us-west1": "us-west-2",
			"europe-west1": "eu-west-1",
			"europe-west2": "eu-west-2",
			"europe-west3": "eu-central-1",
			"europe-north1": "eu-north-1",
			"asia-southeast1": "ap-southeast-1",
			"asia-northeast1": "ap-northeast-1",
			"asia-south1": "ap-south-1",
			"southamerica-east1": "sa-east-1",
		},
		azure: {
			"us-east4": "eastus",
			"us-central1": "centralus",
			"us-west1": "westus2",
			"europe-west1": "westeurope",
			"europe-west2": "uksouth",
			"europe-west3": "germanywestcentral",
			"europe-north1": "swedencentral",
			"asia-southeast1": "southeastasia",
			"asia-northeast1": "japaneast",
			"asia-south1": "centralindia",
			"southamerica-east1": "brazilsouth",
		},
		hetzner: {
			"us-east4": "ash",
			"us-central1": "ash",
			"us-west1": "hil",
			"europe-west1": "fsn1",
			"europe-west2": "fsn1",
			"europe-west3": "fsn1",
			"europe-north1": "hel1",
			"asia-southeast1": "sin",
			"asia-northeast1": "sin",
			"asia-south1": "sin",
			"southamerica-east1": "ash",
		},
	},
	azure: {
		azure: {},
		aws: {
			eastus: "us-east-1",
			eastus2: "us-east-2",
			centralus: "us-east-2",
			westus: "us-west-1",
			westus2: "us-west-2",
			westeurope: "eu-west-1",
			northeurope: "eu-west-1",
			uksouth: "eu-west-2",
			germanywestcentral: "eu-central-1",
			swedencentral: "eu-north-1",
			southeastasia: "ap-southeast-1",
			japaneast: "ap-northeast-1",
			centralindia: "ap-south-1",
			brazilsouth: "sa-east-1",
		},
		gcp: {
			eastus: "us-east4",
			eastus2: "us-central1",
			centralus: "us-central1",
			westus: "us-west1",
			westus2: "us-west1",
			westeurope: "europe-west1",
			northeurope: "europe-north1",
			uksouth: "europe-west2",
			germanywestcentral: "europe-west3",
			swedencentral: "europe-north1",
			southeastasia: "asia-southeast1",
			japaneast: "asia-northeast1",
			centralindia: "asia-south1",
			brazilsouth: "southamerica-east1",
		},
		hetzner: {
			eastus: "ash",
			eastus2: "ash",
			centralus: "ash",
			westus: "hil",
			westus2: "hil",
			westeurope: "fsn1",
			northeurope: "hel1",
			uksouth: "fsn1",
			germanywestcentral: "fsn1",
			swedencentral: "hel1",
			southeastasia: "sin",
			japaneast: "sin",
			centralindia: "sin",
			brazilsouth: "ash",
		},
	},
	hetzner: {
		hetzner: {},
		aws: {
			fsn1: "eu-central-1",
			nbg1: "eu-central-1",
			hel1: "eu-north-1",
			ash: "us-east-1",
			hil: "us-west-2",
			sin: "ap-southeast-1",
		},
		gcp: {
			fsn1: "europe-west3",
			nbg1: "europe-west3",
			hel1: "europe-north1",
			ash: "us-east4",
			hil: "us-west1",
			sin: "asia-southeast1",
		},
		azure: {
			fsn1: "germanywestcentral",
			nbg1: "germanywestcentral",
			hel1: "swedencentral",
			ash: "eastus",
			hil: "westus2",
			sin: "southeastasia",
		},
	},
};
