// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// Hetzner capability lane (#937). Mocks the token decrypt + the hcloud API (fetch) + the service-role DB,
// and asserts the tri-state launchable from /datacenters: a type in server_types.available → launchable, a
// type in supported-but-not-available → not_launchable/capacity_blocked. Availability is the launch signal
// (Hetzner has no queryable quota).

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CapabilityIdentity } from "@/lib/cloud-providers/capabilities/types";

const h = vi.hoisted(() => ({
	inserted: [] as unknown[],
	softRemoves: [] as string[],
}));

vi.mock("@/lib/crypto/secrets", () => ({
	decryptSecret: vi.fn(() => ({ api_token: "tok" })),
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

function hcloudResponse(url: string): unknown {
	const noNext = { meta: { pagination: { next_page: null } } };
	if (url.includes("/datacenters")) {
		return {
			datacenters: [
				{
					location: { name: "fsn1" },
					server_types: { available: [1], supported: [1, 2] },
				},
			],
			...noNext,
		};
	}
	if (url.includes("/server_types")) {
		return {
			server_types: [
				{ id: 1, name: "cax21", cores: 4, memory: 8, architecture: "arm" },
				{ id: 2, name: "cx23", cores: 2, memory: 4, architecture: "x86" },
			],
			...noNext,
		};
	}
	if (url.includes("/locations")) {
		return { locations: [{ name: "fsn1" }, { name: "nbg1" }], ...noNext };
	}
	return { ...noNext };
}

// Tier-1 gate (#938): default every region due, so the verdict assertions below run unchanged.
vi.mock("@/lib/cloud-providers/capabilities/sync-state", () => ({
	hashSource: () => "h",
	regionDue: vi.fn(async () => true),
	recordRegionHashes: vi.fn(async () => {}),
	existingNativeIds: vi.fn(async () => []),
}));

import { syncHetznerCapabilities } from "@/lib/cloud-providers/capabilities/hetzner";

const identity: CapabilityIdentity = {
	id: "ci-1",
	provider: "hetzner",
	credentials: { token: { v: 0, iv: "iv", tag: "tag", data: "data" } },
};

function rowsFor(region: string): Record<string, unknown>[] {
	return h.inserted
		.filter((v): v is Record<string, unknown>[] => Array.isArray(v))
		.flat()
		.filter((r) => r.region === region);
}

beforeEach(() => {
	h.inserted = [];
	h.softRemoves = [];
	vi.clearAllMocks();
	vi.spyOn(globalThis, "fetch").mockImplementation(async (input: unknown) => {
		return {
			ok: true,
			json: async () => hcloudResponse(String(input)),
		} as unknown as Response;
	});
});

describe("syncHetznerCapabilities", () => {
	it("upserts locations as regions and soft-removes", async () => {
		await syncHetznerCapabilities(identity);
		expect(h.inserted).toContainEqual(
			expect.objectContaining({ native_id: "fsn1", provider: "hetzner" }),
		);
		expect(h.inserted).toContainEqual(
			expect.objectContaining({ native_id: "nbg1", provider: "hetzner" }),
		);
		expect(h.softRemoves).toContain("cloud_capability_regions");
		expect(h.softRemoves).toContain("cloud_capability_instance_types");
	});

	it("derives launchable from /datacenters available vs supported", async () => {
		await syncHetznerCapabilities(identity);
		const fsn1 = rowsFor("fsn1");
		// In available[] → launchable, with specs.
		expect(fsn1).toContainEqual(
			expect.objectContaining({
				native_id: "cax21",
				launchable: "launchable",
				launchable_reason: "available",
				vcpu: 4,
				mem_gb: 8,
				family: "cax",
				arch: "arm",
			}),
		);
		// Supported but not available → capacity_blocked.
		expect(fsn1).toContainEqual(
			expect.objectContaining({
				native_id: "cx23",
				launchable: "not_launchable",
				launchable_reason: "capacity_blocked",
			}),
		);
	});
});
