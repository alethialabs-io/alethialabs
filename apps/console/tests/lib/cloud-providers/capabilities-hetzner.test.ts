// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// Hetzner capability lane (#937). Mocks the token decrypt + the hcloud API (fetch) + the service-role DB,
// and asserts the tri-state launchable from /server_types `locations[]`: a location with available=true →
// launchable, a listed location with available=false → not_launchable/capacity_blocked. Availability is the
// launch signal (Hetzner has no queryable quota). The stub answers /datacenters with 410 Gone, exactly as
// Hetzner has since 2026-10-01, so a regression to the removed endpoint fails the sync.

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

/** The fixture hcloud API: the 2026-10 server_types shape, and /datacenters REFUSED with 410 Gone. */
function hcloudResponse(url: string): { status: number; body: unknown } {
	const noNext = { meta: { pagination: { next_page: null } } };
	if (url.includes("/datacenters")) {
		return { status: 410, body: { error: { code: "gone", message: "endpoint removed" } } };
	}
	if (url.includes("/server_types")) {
		return {
			status: 200,
			body: {
				server_types: [
					{
						id: 1,
						name: "cax21",
						cores: 4,
						memory: 8,
						architecture: "arm",
						locations: [
							{ id: 1, name: "fsn1", recommended: false, available: true, deprecation: null },
						],
					},
					{
						id: 2,
						name: "cx23",
						cores: 2,
						memory: 4,
						architecture: "x86",
						locations: [
							{ id: 1, name: "fsn1", recommended: false, available: false, deprecation: null },
							{ id: 2, name: "nbg1", recommended: true, available: true, deprecation: null },
						],
					},
				],
				...noNext,
			},
		};
	}
	if (url.includes("/locations")) {
		return { status: 200, body: { locations: [{ name: "fsn1" }, { name: "nbg1" }], ...noNext } };
	}
	return { status: 200, body: { ...noNext } };
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
		const { status, body } = hcloudResponse(String(input));
		return new Response(JSON.stringify(body), {
			status,
			headers: { "Content-Type": "application/json" },
		});
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

	it("never calls the removed /datacenters endpoint", async () => {
		await syncHetznerCapabilities(identity);
		const urls = vi.mocked(globalThis.fetch).mock.calls.map((c) => String(c[0]));
		expect(urls.some((u) => u.includes("/server_types"))).toBe(true);
		expect(urls.filter((u) => u.includes("/datacenters"))).toEqual([]);
	});

	it("derives launchable from /server_types locations[].available", async () => {
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
		// The same type is available in another location → launchable there, per location.
		expect(rowsFor("nbg1")).toContainEqual(
			expect.objectContaining({
				native_id: "cx23",
				launchable: "launchable",
				launchable_reason: "available",
			}),
		);
		// A type not listed for a location yields no row there at all.
		expect(rowsFor("nbg1").map((r) => r.native_id)).not.toContain("cax21");
	});
});
