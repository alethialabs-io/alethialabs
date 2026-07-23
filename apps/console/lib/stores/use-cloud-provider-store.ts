// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { create } from "zustand";
import { getCloudIdentityInventory } from "@/app/server/actions/cloud-resources";
import {
	type CloudProviderSlug,
	PROVIDERS,
} from "@/lib/cloud-providers/generated/catalog";
import { CACHE_TTL_HOURS } from "@/lib/cloud-providers/provider-slug";
import type {
	CachedResources,
	GcpCachedResources,
	AzureCachedResources,
	GcpSubnetInfo,
	SubnetInfo,
	VpcInfo,
} from "@/types/jsonb.types";

export type AnyCachedResources =
	| CachedResources
	| GcpCachedResources
	| AzureCachedResources;

/** The normalized inventory shape returned by getCloudIdentityInventory. */
type Inventory = Awaited<ReturnType<typeof getCloudIdentityInventory>>;

/** Adapts the normalized inventory (cloud_networks/subnets/regions, kept fresh server-side) into the
 * legacy per-provider `*CachedResources` shape the canvas reads — so the existing-VPC UI uses LIVE
 * inventory with no consumer change. Replaces the retired `cached_resources` JSONB. Serves both AWS
 * and Alibaba (whose VPC/VSwitch inventory is upserted in the same AWS shape). */
function inventoryToAwsCached(inv: Inventory): CachedResources {
	const nativeByRow = new Map(inv.networks.map((n) => [n.id, n.native_id]));
	const vpcs: Record<string, VpcInfo[]> = {};
	for (const n of inv.networks) {
		(vpcs[n.region ?? ""] ??= []).push({
			ID: n.native_id,
			CIDR: n.cidr_block ?? "",
			Name: n.name ?? "",
			IsDefault: n.is_default ?? false,
		});
	}
	const subnets: Record<string, Record<string, SubnetInfo[]>> = {};
	for (const s of inv.subnets) {
		const vpcNative = s.network_id ? (nativeByRow.get(s.network_id) ?? "") : "";
		((subnets[s.region ?? ""] ??= {})[vpcNative] ??= []).push({
			ID: s.native_id,
			CIDR: s.cidr_block ?? "",
			VpcID: vpcNative,
			AvailabilityZone: s.availability_zone ?? "",
		});
	}
	return { regions: inv.regions, vpcs, subnets, hosted_zones: [] };
}

function inventoryToGcpCached(inv: Inventory): GcpCachedResources {
	const nativeByRow = new Map(inv.networks.map((n) => [n.id, n.native_id]));
	const subnets: Record<string, GcpSubnetInfo[]> = {};
	for (const s of inv.subnets) {
		(subnets[s.region ?? ""] ??= []).push({
			name: s.name ?? "",
			region: s.region ?? "",
			ipCidrRange: s.cidr_block ?? "",
			network: s.network_id ? (nativeByRow.get(s.network_id) ?? "") : "",
		});
	}
	return {
		regions: inv.regions,
		networks: inv.networks.map((n) => ({
			name: n.name ?? "",
			selfLink: n.native_id,
			autoCreateSubnetworks: n.is_default ?? false,
		})),
		subnets,
		managed_zones: [],
	};
}

function inventoryToAzureCached(inv: Inventory): AzureCachedResources {
	const nameByRow = new Map(inv.networks.map((n) => [n.id, n.name ?? ""]));
	const subnets: Record<string, AzureCachedResources["subnets"][string]> = {};
	for (const s of inv.subnets) {
		const vnetName = s.network_id ? (nameByRow.get(s.network_id) ?? "") : "";
		(subnets[vnetName] ??= []).push({
			name: s.name ?? "",
			id: s.native_id,
			addressPrefix: s.cidr_block ?? "",
			vnetName,
		});
	}
	return {
		locations: inv.regions,
		vnets: inv.networks.map((n) => ({
			name: n.name ?? "",
			id: n.native_id,
			location: n.region ?? "",
			addressPrefixes: n.cidr_block ? [n.cidr_block] : [],
		})),
		subnets,
		dns_zones: [],
	};
}

interface CloudProviderStore {
	provider: CloudProviderSlug;
	identityId: string | null;
	cachedResources: AnyCachedResources | null;
	cachedAt: string | null;
	isStale: boolean;
	isLoading: boolean;
	error: string | null;
	_cleanup: (() => void) | null;

	setIdentity: (
		identityId: string,
		provider: CloudProviderSlug,
	) => Promise<void>;
	updateResources: (
		resources: AnyCachedResources | null,
		cachedAt: string,
	) => void;
	subscribe: () => () => void;
}

export const useCloudProviderStore = create<CloudProviderStore>()(
	(set, get) => ({
		provider: "aws",
		identityId: null,
		cachedResources: null,
		cachedAt: null,
		isStale: true,
		isLoading: false,
		error: null,
		_cleanup: null,

		setIdentity: async (identityId, provider) => {
			const prevCleanup = get()._cleanup;
			if (prevCleanup) {
				prevCleanup();
				set({ _cleanup: null });
			}

			set({ identityId, provider, isLoading: true, error: null });

			try {
				// AWS/GCP/Azure/Alibaba read the LIVE normalized inventory (kept fresh by the
				// server-side sweep), adapted to the legacy per-provider shape. Alibaba's VPC/VSwitch
				// inventory is upserted AWS-shaped (see lib/cloud-providers/inventory/alibaba.ts), so
				// it maps through the AWS adapter. Token clouds (no VPCs) keep the old reader.
				let resources: AnyCachedResources | null;
				let cachedAt: string | null;
				if (
					provider === "aws" ||
					provider === "gcp" ||
					provider === "azure" ||
					provider === "alibaba"
				) {
					const inv = await getCloudIdentityInventory(identityId);
					resources =
						provider === "gcp"
							? inventoryToGcpCached(inv)
							: provider === "azure"
								? inventoryToAzureCached(inv)
								: inventoryToAwsCached(inv);
					cachedAt = new Date().toISOString();
				} else {
					// Token clouds (Hetzner; future DigitalOcean/Civo) have no VPCs to reuse.
					resources = null;
					cachedAt = null;
				}
				const isStale = cachedAt
					? Date.now() - new Date(cachedAt).getTime() >
						CACHE_TTL_HOURS * 3600 * 1000
					: true;
				set({
					cachedResources: resources,
					cachedAt,
					isStale,
					isLoading: false,
					error: null,
				});
			} catch (err) {
				set({
					cachedResources: null,
					cachedAt: null,
					isStale: true,
					isLoading: false,
					error: err instanceof Error ? err.message : "Failed to load cloud resources",
				});
			}

			const cleanup = get().subscribe();
			set({ _cleanup: cleanup });
		},

		updateResources: (resources, cachedAt) => {
			const isStale =
				Date.now() - new Date(cachedAt).getTime() >
				CACHE_TTL_HOURS * 3600 * 1000;
			set({ cachedResources: resources, cachedAt, isStale });
		},

		subscribe: () => {
			// AWS inventory is kept fresh server-side (the reconciliation sweep + event ingester);
			// the store re-reads on identity switch. No client live channel needed.
			return () => {};
		},
	}),
);

export function useProviderSlug(): CloudProviderSlug {
	return useCloudProviderStore((s) => s.provider);
}

export function useProviderMeta() {
	const provider = useProviderSlug();
	return PROVIDERS[provider];
}
