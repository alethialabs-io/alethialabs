// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Unit tests for the cloud-provider store's live-inventory branch (setIdentity). AWS/GCP/
// Azure/Alibaba read the normalized server-side inventory and adapt it to the legacy
// per-provider cached shape — Alibaba's VPC/VSwitch rows are upserted AWS-shaped, so it maps
// through the AWS adapter. Token clouds (Hetzner) have no VPCs and stay resource-less.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/app/server/actions/cloud-resources", () => ({
	getCloudIdentityInventory: vi.fn(),
}));

import { getCloudIdentityInventory } from "@/app/server/actions/cloud-resources";
import { useCloudProviderStore } from "@/lib/stores/use-cloud-provider-store";

/** A minimal normalized inventory (one VPC + one VSwitch in cn-hangzhou). */
const INVENTORY = {
	networks: [
		{
			id: "row-net-1",
			native_id: "vpc-abc",
			region: "cn-hangzhou",
			name: "main",
			cidr_block: "10.0.0.0/16",
			is_default: false,
		},
	],
	subnets: [
		{
			id: "row-sub-1",
			native_id: "vsw-1",
			network_id: "row-net-1",
			region: "cn-hangzhou",
			name: "vsw-a",
			cidr_block: "10.0.1.0/24",
			availability_zone: "cn-hangzhou-a",
		},
	],
	regions: ["cn-hangzhou", "eu-central-1"],
};

const INITIAL = {
	provider: "aws",
	identityId: null,
	cachedResources: null,
	cachedAt: null,
	isStale: true,
	isLoading: false,
	error: null,
	_cleanup: null,
} as const;

beforeEach(() => {
	vi.clearAllMocks();
	useCloudProviderStore.setState({ ...INITIAL } as never, false);
	vi.mocked(getCloudIdentityInventory).mockResolvedValue(INVENTORY as never);
});

describe("useCloudProviderStore.setIdentity — live inventory", () => {
	it("populates AWS-shaped cachedResources for an alibaba identity", async () => {
		await useCloudProviderStore.getState().setIdentity("ci-ali", "alibaba");

		expect(getCloudIdentityInventory).toHaveBeenCalledWith("ci-ali");
		const s = useCloudProviderStore.getState();
		expect(s.provider).toBe("alibaba");
		expect(s.isLoading).toBe(false);
		expect(s.isStale).toBe(false);
		expect(s.error).toBeNull();
		expect(s.cachedResources).toEqual({
			regions: ["cn-hangzhou", "eu-central-1"],
			vpcs: {
				"cn-hangzhou": [
					{ ID: "vpc-abc", CIDR: "10.0.0.0/16", Name: "main", IsDefault: false },
				],
			},
			subnets: {
				"cn-hangzhou": {
					"vpc-abc": [
						{
							ID: "vsw-1",
							CIDR: "10.0.1.0/24",
							VpcID: "vpc-abc",
							AvailabilityZone: "cn-hangzhou-a",
						},
					],
				},
			},
			hosted_zones: [],
		});
	});

	it("still reads the inventory for aws (mapped through the same adapter)", async () => {
		await useCloudProviderStore.getState().setIdentity("ci-aws", "aws");

		expect(getCloudIdentityInventory).toHaveBeenCalledWith("ci-aws");
		expect(useCloudProviderStore.getState().cachedResources).not.toBeNull();
	});

	it("keeps hetzner resource-less (token cloud — no inventory call)", async () => {
		await useCloudProviderStore.getState().setIdentity("ci-hetzner", "hetzner");

		expect(getCloudIdentityInventory).not.toHaveBeenCalled();
		const s = useCloudProviderStore.getState();
		expect(s.cachedResources).toBeNull();
		expect(s.cachedAt).toBeNull();
		expect(s.isStale).toBe(true);
		expect(s.error).toBeNull();
	});

	it("surfaces an inventory failure as error with null resources", async () => {
		vi.mocked(getCloudIdentityInventory).mockRejectedValueOnce(
			new Error("boom"),
		);

		await useCloudProviderStore.getState().setIdentity("ci-ali", "alibaba");

		const s = useCloudProviderStore.getState();
		expect(s.cachedResources).toBeNull();
		expect(s.error).toBe("boom");
		expect(s.isLoading).toBe(false);
	});
});
