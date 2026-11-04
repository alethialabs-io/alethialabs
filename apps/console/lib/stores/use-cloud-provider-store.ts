// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The cloud-provider selection, and the selected identity's live network inventory.
//
// SPLIT (ADR 0005 D5, #6119). WHICH identity and provider are selected is UI state and stays in this
// Zustand store. The identity's INVENTORY is server state: it is the `canvas.cloudInventory` GET
// procedure, read through the query cache by `useCloudProviderResources()`. The store used to fetch
// it itself, with its own loading flag, error slot and staleness clock — a hand-rolled query.

import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { create } from "zustand";
import type { getCloudIdentityInventory } from "@/app/server/actions/cloud-resources";
import { orpc } from "@/lib/rpc/client";
import {
	type CloudProviderSlug,
	PROVIDERS,
} from "@/lib/cloud-providers/generated/catalog";
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

/** The clouds whose identities carry a VPC/subnet inventory. Token clouds (Hetzner, …) have none. */
const INVENTORY_PROVIDERS: ReadonlySet<CloudProviderSlug> = new Set(["aws", "gcp", "azure", "alibaba"]);

/**
 * Adapts an identity's normalized inventory into the per-provider `*CachedResources` shape the
 * consumers read. Alibaba's VPC/VSwitch inventory is upserted in the AWS shape
 * (lib/cloud-providers/inventory/alibaba.ts), so it maps through the AWS adapter. Null for a token
 * cloud, which has no VPCs to reuse.
 */
export function adaptInventory(
	provider: CloudProviderSlug,
	inv: Inventory,
): AnyCachedResources | null {
	if (!INVENTORY_PROVIDERS.has(provider)) return null;
	if (provider === "gcp") return inventoryToGcpCached(inv);
	if (provider === "azure") return inventoryToAzureCached(inv);
	return inventoryToAwsCached(inv);
}

interface CloudProviderStore {
	provider: CloudProviderSlug;
	identityId: string | null;
	/** Selects an identity (and its provider); its inventory is then read by the query below. */
	setIdentity: (identityId: string, provider: CloudProviderSlug) => void;
}

/** The selected cloud identity and provider — UI state only. */
export const useCloudProviderStore = create<CloudProviderStore>()((set) => ({
	provider: "aws",
	identityId: null,
	setIdentity: (identityId, provider) => set({ identityId, provider }),
}));

/** The selected identity's resources, as its consumers read them. */
export interface CloudProviderResources {
	provider: CloudProviderSlug;
	identityId: string | null;
	/** The adapted inventory; null before an identity is selected, for a token cloud, or on error. */
	cachedResources: AnyCachedResources | null;
	isLoading: boolean;
	/** A human sentence when the read failed, else null. */
	error: string | null;
}

/**
 * The selected identity's live inventory, through the query cache. Only the clouds that carry an
 * inventory issue the read; a token cloud answers null without a request.
 */
export function useCloudProviderResources(): CloudProviderResources {
	const provider = useCloudProviderStore((s) => s.provider);
	const identityId = useCloudProviderStore((s) => s.identityId);
	const enabled = identityId !== null && INVENTORY_PROVIDERS.has(provider);
	const query = useQuery({
		...orpc.canvas.cloudInventory.queryOptions({ input: { identityId: identityId ?? "" } }),
		enabled,
	});
	const { data } = query;
	const cachedResources = useMemo(
		() => (data ? adaptInventory(provider, data) : null),
		[provider, data],
	);
	return {
		provider,
		identityId,
		cachedResources,
		isLoading: enabled && query.isPending,
		error: query.isError ? "Failed to load cloud resources" : null,
	};
}

/** The selected provider's slug. */
export function useProviderSlug(): CloudProviderSlug {
	return useCloudProviderStore((s) => s.provider);
}

/** The selected provider's catalog metadata. */
export function useProviderMeta() {
	const provider = useProviderSlug();
	return PROVIDERS[provider];
}
