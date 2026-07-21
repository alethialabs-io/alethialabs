// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// Alibaba capability lane (#936). Mocks the STS assume + the ECS SDK (fake client methods returning
// fixtures) + the service-role DB, and asserts the tri-state launchable: an Available type with vCPU
// quota (launchable), a SoldOut type (not_launchable/sold_out), and a region whose postpaid vCPU max is 0
// (not_launchable/quota_zero — Alibaba quota IS obtainable, so this is populated, not not_evaluable).

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CapabilityIdentity } from "@/lib/cloud-providers/capabilities/types";

const h = vi.hoisted(() => ({
	inserted: [] as unknown[],
	softRemoves: [] as string[],
}));

vi.mock("@/lib/cloud-providers/session/alibaba", () => ({
	assumeAlibabaRole: vi.fn(async () => ({
		accountId: "1234567890",
		credentials: {
			accessKeyId: "ak",
			accessKeySecret: "sk",
			securityToken: "st",
			expiration: null,
		},
	})),
}));

vi.mock("@/lib/cloud-providers/inventory/upsert", () => ({
	softRemoveUnseen: vi.fn(async (table: string) => {
		h.softRemoves.push(table);
	}),
}));

vi.mock("@/lib/db", () => {
	const chain = () => {
		const c: Record<string, unknown> = {};
		Object.assign(c, {
			values: (v: unknown) => {
				h.inserted.push(v);
				return c;
			},
			onConflictDoUpdate: () => c,
			then: (res: (v: unknown) => unknown) => res(undefined),
		});
		return c;
	};
	return { getServiceDb: () => ({ insert: () => chain() }) };
});

vi.mock("@alicloud/openapi-client", () => ({
	Config: class {
		constructor(readonly input: unknown) {}
	},
}));

vi.mock("@alicloud/ecs20140526", () => {
	class Req {
		constructor(readonly input: Record<string, unknown>) {}
	}
	class EcsClient {
		constructor(readonly cfg: unknown) {}
		async describeRegions() {
			return {
				body: {
					regions: {
						region: [{ regionId: "cn-hangzhou" }, { regionId: "cn-beijing" }],
					},
				},
			};
		}
		async describeInstanceTypes() {
			return {
				body: {
					instanceTypes: {
						instanceType: [
							{
								instanceTypeId: "ecs.g6.large",
								cpuCoreCount: 2,
								memorySize: 8,
								instanceTypeFamily: "ecs.g6",
								cpuArchitecture: "X86",
							},
							{
								instanceTypeId: "ecs.g7.large",
								cpuCoreCount: 2,
								memorySize: 8,
								instanceTypeFamily: "ecs.g7",
								cpuArchitecture: "X86",
							},
						],
					},
				},
			};
		}
		async describeAvailableResource() {
			return {
				body: {
					availableZones: {
						availableZone: [
							{
								availableResources: {
									availableResource: [
										{
											type: "InstanceType",
											supportedResources: {
												supportedResource: [
													{ value: "ecs.g6.large", status: "Available" },
													{ value: "ecs.g7.large", status: "SoldOut" },
												],
											},
										},
									],
								},
							},
						],
					},
				},
			};
		}
		async describeAccountAttributes(req: Req) {
			// cn-beijing has zero postpaid vCPU quota; cn-hangzhou has headroom.
			const max = req.input.regionId === "cn-beijing" ? "0" : "100";
			return {
				body: {
					accountAttributeItems: {
						accountAttributeItem: [
							{
								attributeName: "max-postpaid-instance-vcpu-count",
								attributeValues: { valueItem: [{ value: max }] },
							},
						],
					},
				},
			};
		}
	}
	return {
		default: EcsClient,
		DescribeRegionsRequest: Req,
		DescribeInstanceTypesRequest: Req,
		DescribeAvailableResourceRequest: Req,
		DescribeAccountAttributesRequest: Req,
	};
});

// Tier-1 gate (#938): default every region due, so the verdict assertions below run unchanged.
vi.mock("@/lib/cloud-providers/capabilities/sync-state", () => ({
	hashSource: () => "h",
	regionDue: vi.fn(async () => true),
	recordRegionHashes: vi.fn(async () => {}),
	existingNativeIds: vi.fn(async () => []),
}));

import { syncAlibabaCapabilities } from "@/lib/cloud-providers/capabilities/alibaba";

const identity: CapabilityIdentity = {
	id: "ci-1",
	provider: "alibaba",
	credentials: { role_arn: "acs:ram::1:role/x", oidc_provider_arn: "acs:ram::1:oidc-provider/y" },
};

function rowsFor(region: string): Record<string, unknown>[] {
	const batches = h.inserted.filter((v): v is Record<string, unknown>[] =>
		Array.isArray(v),
	);
	return batches.flat().filter((r) => r.region === region);
}

beforeEach(() => {
	h.inserted = [];
	h.softRemoves = [];
	vi.clearAllMocks();
});

describe("syncAlibabaCapabilities", () => {
	it("upserts regions and soft-removes", async () => {
		await syncAlibabaCapabilities(identity);
		expect(h.inserted).toContainEqual(
			expect.objectContaining({ native_id: "cn-hangzhou", provider: "alibaba" }),
		);
		expect(h.softRemoves).toContain("cloud_capability_regions");
		expect(h.softRemoves).toContain("cloud_capability_instance_types");
	});

	it("derives tri-state launchable from stock status AND region vCPU quota", async () => {
		await syncAlibabaCapabilities(identity);
		const hz = rowsFor("cn-hangzhou");
		// Available + region vCPU max 100 → launchable, with specs.
		expect(hz).toContainEqual(
			expect.objectContaining({
				native_id: "ecs.g6.large",
				launchable: "launchable",
				launchable_reason: "available",
				vcpu: 2,
				mem_gb: 8,
				family: "ecs.g6",
				arch: "X86",
			}),
		);
		// SoldOut → not_launchable/sold_out.
		expect(hz).toContainEqual(
			expect.objectContaining({
				native_id: "ecs.g7.large",
				launchable: "not_launchable",
				launchable_reason: "sold_out",
			}),
		);
		// cn-beijing region vCPU max 0 → quota_zero for the whole region.
		expect(rowsFor("cn-beijing")).toContainEqual(
			expect.objectContaining({
				native_id: "ecs.g6.large",
				launchable: "not_launchable",
				launchable_reason: "quota_zero",
			}),
		);
	});
});
