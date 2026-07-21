// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// GCP capability lane (#935). Mocks the WIF token client + Compute REST (fetch) + the service-role DB, and
// asserts the tri-state launchable: a classic family with quota (launchable), a classic family with a
// region quota of 0 (quota_zero), and a modern family whose metric isn't in regions.quotas[] (not_evaluable/
// quota_unknown — the honest fallback). Also that machine types are deduped per region across zones.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CapabilityIdentity } from "@/lib/cloud-providers/capabilities/types";

const h = vi.hoisted(() => ({
	inserted: [] as unknown[],
	softRemoves: [] as string[],
}));

vi.mock("@/lib/cloud-providers/session/gcp", () => ({
	externalAccountClientFromWif: vi.fn(() => ({
		getAccessToken: vi.fn(async () => ({ token: "tok" })),
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

function computeResponse(url: string): unknown {
	if (url.endsWith("/regions")) {
		return {
			items: [
				{
					name: "us-central1",
					status: "UP",
					quotas: [
						{ metric: "CPUS", limit: 72 }, // e2/n1 shared → launchable
						{ metric: "C2_CPUS", limit: 0 }, // c2 → quota_zero
					],
				},
			],
		};
	}
	if (url.includes("/aggregated/machineTypes")) {
		return {
			items: {
				"zones/us-central1-a": {
					machineTypes: [
						{ name: "e2-medium", guestCpus: 2, memoryMb: 4096, zone: "https://www.googleapis.com/.../zones/us-central1-a" },
						{ name: "c2-standard-4", guestCpus: 4, memoryMb: 16384, zone: "zones/us-central1-a" },
						{ name: "n4-standard-2", guestCpus: 2, memoryMb: 8192, zone: "zones/us-central1-a" },
					],
				},
				// Same region, another zone — e2-medium repeats and must dedup to one row.
				"zones/us-central1-b": {
					machineTypes: [
						{ name: "e2-medium", guestCpus: 2, memoryMb: 4096, zone: "zones/us-central1-b" },
					],
				},
			},
		};
	}
	return {};
}

import { syncGcpCapabilities } from "@/lib/cloud-providers/capabilities/gcp";

const identity: CapabilityIdentity = {
	id: "ci-1",
	provider: "gcp",
	credentials: { project_id: "proj-1", wif_config: {} },
};

beforeEach(() => {
	h.inserted = [];
	h.softRemoves = [];
	vi.clearAllMocks();
	vi.spyOn(globalThis, "fetch").mockImplementation(async (input: unknown) => {
		return {
			ok: true,
			json: async () => computeResponse(String(input)),
		} as unknown as Response;
	});
});

describe("syncGcpCapabilities", () => {
	it("upserts regions and soft-removes", async () => {
		await syncGcpCapabilities(identity);
		expect(h.inserted).toContainEqual(
			expect.objectContaining({ native_id: "us-central1", provider: "gcp" }),
		);
		expect(h.softRemoves).toContain("cloud_capability_regions");
		expect(h.softRemoves).toContain("cloud_capability_instance_types");
	});

	it("derives tri-state launchable per classic family metric and dedups zones", async () => {
		await syncGcpCapabilities(identity);
		const batch = h.inserted.find((v): v is unknown[] => Array.isArray(v));
		expect(batch).toBeDefined();
		// e2 → CPUS metric 72 > 0 → launchable, with specs; deduped to a single row despite 2 zones.
		const e2 = (batch ?? []).filter(
			(r): r is Record<string, unknown> =>
				typeof r === "object" && r !== null && "native_id" in r && r.native_id === "e2-medium",
		);
		expect(e2).toHaveLength(1);
		expect(e2[0]).toMatchObject({
			launchable: "launchable",
			launchable_reason: "available",
			vcpu: 2,
			mem_gb: 4,
			family: "e2",
			region: "us-central1",
		});
		// c2 → C2_CPUS metric 0 → not_launchable/quota_zero.
		expect(batch).toContainEqual(
			expect.objectContaining({
				native_id: "c2-standard-4",
				launchable: "not_launchable",
				launchable_reason: "quota_zero",
			}),
		);
		// n4 (modern) → no classic metric → not_evaluable/quota_unknown.
		expect(batch).toContainEqual(
			expect.objectContaining({
				native_id: "n4-standard-2",
				launchable: "not_evaluable",
				launchable_reason: "quota_unknown",
			}),
		);
	});
});
