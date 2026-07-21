// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// Azure capability lane (#934). Mocks the managed-identity token + the ARM REST (fetch) + the service-role
// DB, and asserts the tri-state launchable across restrictions[] (not_available_for_subscription /
// sku_restricted), a family usage limit of 0 (quota_zero), and an unrestricted SKU with headroom (launchable).

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CapabilityIdentity } from "@/lib/cloud-providers/capabilities/types";

const h = vi.hoisted(() => ({
	inserted: [] as unknown[],
	softRemoves: [] as string[],
}));

vi.mock("@/lib/cloud-providers/session/azure", () => ({
	assumeAzureIdentity: vi.fn(() => ({
		getToken: vi.fn(async () => ({ token: "tok" })),
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

// ARM REST fixtures, matched by URL substring.
function armResponse(url: string): unknown {
	if (url.includes("/locations?")) {
		return {
			value: [
				{ name: "eastus", metadata: { regionType: "Physical" } },
				{ name: "logicaleast", metadata: { regionType: "Logical" } },
			],
		};
	}
	if (url.includes("/skus?")) {
		return {
			value: [
				{
					resourceType: "virtualMachines",
					name: "Standard_D2s_v5",
					family: "standardDSv5Family",
					locations: ["eastus"],
					capabilities: [
						{ name: "vCPUs", value: "2" },
						{ name: "MemoryGB", value: "8" },
						{ name: "CpuArchitectureType", value: "x64" },
					],
					restrictions: [],
				},
				{
					resourceType: "virtualMachines",
					name: "Standard_NC6",
					family: "standardNCFamily",
					locations: ["eastus"],
					capabilities: [{ name: "vCPUs", value: "6" }],
					restrictions: [
						{
							type: "Location",
							reasonCode: "NotAvailableForSubscription",
							restrictionInfo: { locations: ["eastus"] },
						},
					],
				},
				{
					resourceType: "virtualMachines",
					name: "Standard_E2s_v5",
					family: "standardESv5Family",
					locations: ["eastus"],
					capabilities: [{ name: "vCPUs", value: "2" }],
					restrictions: [],
				},
				// Non-VM SKU — must be filtered out.
				{ resourceType: "disks", name: "Premium_LRS", locations: ["eastus"] },
			],
		};
	}
	if (url.includes("/usages?")) {
		return {
			value: [
				{ name: { value: "standardDSv5Family" }, currentValue: 0, limit: 100 },
				{ name: { value: "standardESv5Family" }, currentValue: 0, limit: 0 }, // quota zero
			],
		};
	}
	return { value: [] };
}

// Tier-1 gate (#938): default every region due, so the verdict assertions below run unchanged.
vi.mock("@/lib/cloud-providers/capabilities/sync-state", () => ({
	hashSource: () => "h",
	regionDue: vi.fn(async () => true),
	recordRegionHashes: vi.fn(async () => {}),
	existingNativeIds: vi.fn(async () => []),
}));

import { syncAzureCapabilities } from "@/lib/cloud-providers/capabilities/azure";

const identity: CapabilityIdentity = {
	id: "ci-1",
	provider: "azure",
	credentials: {
		subscription_id: "sub-1",
		tenant_id: "ten-1",
		client_id: "cli-1",
	},
};

beforeEach(() => {
	h.inserted = [];
	h.softRemoves = [];
	vi.clearAllMocks();
	vi.spyOn(globalThis, "fetch").mockImplementation(async (input: unknown) => {
		const url = String(input);
		return {
			ok: true,
			json: async () => armResponse(url),
		} as unknown as Response;
	});
});

describe("syncAzureCapabilities", () => {
	it("upserts physical regions only (skips Logical) and soft-removes", async () => {
		await syncAzureCapabilities(identity);
		expect(h.inserted).toContainEqual(
			expect.objectContaining({ native_id: "eastus", provider: "azure" }),
		);
		expect(h.inserted).not.toContainEqual(
			expect.objectContaining({ native_id: "logicaleast" }),
		);
		expect(h.softRemoves).toContain("cloud_capability_regions");
		expect(h.softRemoves).toContain("cloud_capability_instance_types");
	});

	it("derives tri-state launchable from restrictions[] and family usage limits", async () => {
		await syncAzureCapabilities(identity);
		const batch = h.inserted.find((v): v is unknown[] => Array.isArray(v));
		expect(batch).toBeDefined();
		// Unrestricted + family limit > 0 → launchable, with specs.
		expect(batch).toContainEqual(
			expect.objectContaining({
				native_id: "Standard_D2s_v5",
				launchable: "launchable",
				launchable_reason: "available",
				vcpu: 2,
				mem_gb: 8,
				family: "standardDSv5Family",
				arch: "x64",
			}),
		);
		// restrictions[] NotAvailableForSubscription → not_launchable.
		expect(batch).toContainEqual(
			expect.objectContaining({
				native_id: "Standard_NC6",
				launchable: "not_launchable",
				launchable_reason: "not_available_for_subscription",
			}),
		);
		// Unrestricted but family usage limit 0 → not_launchable/quota_zero.
		expect(batch).toContainEqual(
			expect.objectContaining({
				native_id: "Standard_E2s_v5",
				launchable: "not_launchable",
				launchable_reason: "quota_zero",
			}),
		);
		// Non-VM SKU filtered out.
		expect(batch).not.toContainEqual(
			expect.objectContaining({ native_id: "Premium_LRS" }),
		);
	});
});
