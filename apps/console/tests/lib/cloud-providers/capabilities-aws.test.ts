// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// AWS capability lane (#933). Establishes the SDK-mock pattern for the capability lanes: mock the keyless
// session assume + the AWS SDK clients (fake `send()` returning fixtures) + the service-role DB (capture
// `.values()`), and assert the tri-state `launchable` verdict across all three outcomes — a Standard type
// with quota (launchable), an accelerator class with quota 0 (not_launchable/quota_zero), and a class
// whose quota code is absent (not_evaluable/quota_unknown — the honest fallback, never a false verdict).

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CapabilityIdentity } from "@/lib/cloud-providers/capabilities/types";

const h = vi.hoisted(() => ({
	inserted: [] as unknown[],
	softRemoves: [] as string[],
}));

vi.mock("@/lib/cloud-providers/session/aws", () => ({
	assumeAwsRole: vi.fn(async () => ({
		credentials: { accessKeyId: "a", secretAccessKey: "b", sessionToken: "c" },
		accountId: "123456789012",
		region: "us-east-1",
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

vi.mock("@aws-sdk/client-ec2", () => {
	class DescribeRegionsCommand {
		_t = "regions";
		constructor(readonly input: unknown) {}
	}
	class DescribeInstanceTypeOfferingsCommand {
		_t = "offerings";
		constructor(readonly input: unknown) {}
	}
	class DescribeInstanceTypesCommand {
		_t = "types";
		constructor(readonly input: unknown) {}
	}
	class EC2Client {
		constructor(readonly cfg: unknown) {}
		async send(cmd: { _t?: string }) {
			if (cmd._t === "regions") {
				return { Regions: [{ RegionName: "us-east-1" }] };
			}
			if (cmd._t === "offerings") {
				return {
					InstanceTypeOfferings: [
						{ InstanceType: "m5.large" },
						{ InstanceType: "p4d.24xlarge" },
						{ InstanceType: "inf1.xlarge" },
					],
					NextToken: undefined,
				};
			}
			if (cmd._t === "types") {
				return {
					InstanceTypes: [
						{
							InstanceType: "m5.large",
							VCpuInfo: { DefaultVCpus: 2 },
							MemoryInfo: { SizeInMiB: 8192 },
							ProcessorInfo: { SupportedArchitectures: ["x86_64"] },
						},
						{
							InstanceType: "p4d.24xlarge",
							VCpuInfo: { DefaultVCpus: 96 },
							MemoryInfo: { SizeInMiB: 1179648 },
							ProcessorInfo: { SupportedArchitectures: ["x86_64"] },
						},
						{
							InstanceType: "inf1.xlarge",
							VCpuInfo: { DefaultVCpus: 4 },
							MemoryInfo: { SizeInMiB: 8192 },
							ProcessorInfo: { SupportedArchitectures: ["x86_64"] },
						},
					],
					NextToken: undefined,
				};
			}
			return {};
		}
	}
	return {
		EC2Client,
		DescribeRegionsCommand,
		DescribeInstanceTypeOfferingsCommand,
		DescribeInstanceTypesCommand,
	};
});

vi.mock("@aws-sdk/client-service-quotas", () => {
	class ListServiceQuotasCommand {
		constructor(readonly input: unknown) {}
	}
	class ServiceQuotasClient {
		constructor(readonly cfg: unknown) {}
		async send() {
			return {
				Quotas: [
					{ QuotaCode: "L-1216C47A", Value: 64 }, // Standard class — has headroom
					{ QuotaCode: "L-417A185B", Value: 0 }, // P class — quota zero
					// Inf class (L-1945791B) intentionally ABSENT → quota_unknown
				],
				NextToken: undefined,
			};
		}
	}
	return { ServiceQuotasClient, ListServiceQuotasCommand };
});

import { syncAwsCapabilities } from "@/lib/cloud-providers/capabilities/aws";

const identity: CapabilityIdentity = {
	id: "ci-1",
	provider: "aws",
	credentials: {},
};

beforeEach(() => {
	h.inserted = [];
	h.softRemoves = [];
	vi.clearAllMocks();
});

describe("syncAwsCapabilities", () => {
	it("upserts enabled regions and soft-removes the unseen", async () => {
		await syncAwsCapabilities(identity);
		expect(h.inserted).toContainEqual(
			expect.objectContaining({ native_id: "us-east-1", provider: "aws" }),
		);
		expect(h.softRemoves).toContain("cloud_capability_regions");
		expect(h.softRemoves).toContain("cloud_capability_instance_types");
	});

	it("derives the tri-state launchable verdict per family-class quota", async () => {
		await syncAwsCapabilities(identity);
		const batch = h.inserted.find((v): v is unknown[] => Array.isArray(v));
		expect(batch).toBeDefined();
		// Standard class with quota → launchable, with full specs.
		expect(batch).toContainEqual(
			expect.objectContaining({
				native_id: "m5.large",
				launchable: "launchable",
				launchable_reason: "available",
				vcpu: 2,
				mem_gb: 8,
				family: "m5",
				arch: "x86_64",
			}),
		);
		// P class with quota 0 → not_launchable.
		expect(batch).toContainEqual(
			expect.objectContaining({
				native_id: "p4d.24xlarge",
				launchable: "not_launchable",
				launchable_reason: "quota_zero",
			}),
		);
		// Inf class quota code absent → honest not_evaluable, never a false verdict.
		expect(batch).toContainEqual(
			expect.objectContaining({
				native_id: "inf1.xlarge",
				launchable: "not_evaluable",
				launchable_reason: "quota_unknown",
			}),
		);
	});
});
