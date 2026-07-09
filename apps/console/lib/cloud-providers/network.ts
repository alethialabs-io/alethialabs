// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { CloudProviderSlug } from "./registry";

interface NetworkConfig {
	networkLabel: string;
	createLabel: string;
	existingLabel: string;
	cidrLabel: string;
	natLabel: string;
	natSingleLabel: string;
	natMultiLabel: string;
}

/** Network/VPC terminology and labels per provider. */
export const NETWORK: Record<CloudProviderSlug, NetworkConfig> = {
	aws: {
		networkLabel: "VPC",
		createLabel: "Create New VPC",
		existingLabel: "Use Existing VPC",
		cidrLabel: "VPC CIDR Block",
		natLabel: "NAT Gateway",
		natSingleLabel: "Single (cost-effective)",
		natMultiLabel: "Per-AZ (high availability)",
	},
	gcp: {
		networkLabel: "VPC Network",
		createLabel: "Create New VPC Network",
		existingLabel: "Use Existing VPC Network",
		cidrLabel: "Subnet CIDR Range",
		natLabel: "Cloud NAT",
		natSingleLabel: "Single (cost-effective)",
		natMultiLabel: "Per-Region (high availability)",
	},
	azure: {
		networkLabel: "VNet",
		createLabel: "Create New VNet",
		existingLabel: "Use Existing VNet",
		cidrLabel: "Address Space",
		natLabel: "NAT Gateway",
		natSingleLabel: "Single (cost-effective)",
		natMultiLabel: "Per-Subnet (high availability)",
	},
	hetzner: {
		networkLabel: "Hetzner Network",
		createLabel: "Create a new private network",
		existingLabel: "Use an existing network",
		cidrLabel: "Network CIDR",
		natLabel: "NAT",
		natSingleLabel: "Single NAT",
		natMultiLabel: "NAT per zone",
	},
};
