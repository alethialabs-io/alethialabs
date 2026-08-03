// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// Token-cloud inventory sync (#1896). Hetzner's bring-your-own-network was unreachable from the
// canvas because `cloud_networks` had no Hetzner rows to offer; this covers the sync that fills it.
// Mocks the token decrypt, the seal, `softRemoveUnseen` and the service-role DB, and routes fetch by
// URL substring so /v1/locations and /v1/networks can be driven independently.
//
// The load-bearing assertions: the CIDR is SEALED (there is no plaintext cidr_block column, so a raw
// range here would both hide the CIDR from the picker and write plaintext where ciphertext is
// expected), pagination follows past the first page, and a failing /v1/networks still leaves the
// regions sync — the thing every token cloud depends on — intact.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudIdentity } from "@/lib/db/schema";

const h = vi.hoisted(() => ({
	inserted: [] as Record<string, unknown>[],
	softRemoves: [] as string[],
	sealed: [] as unknown[],
}));

vi.mock("@/lib/crypto/secrets", () => ({
	decryptSecret: vi.fn(() => ({ api_token: "tok" })),
}));

vi.mock("@/lib/cloud-providers/inventory/upsert", () => ({
	softRemoveUnseen: vi.fn(async (table: string) => {
		h.softRemoves.push(table);
	}),
	sealSensitive: vi.fn((attrs: Record<string, string | undefined>) => {
		h.sealed.push(attrs);
		return attrs.cidr_block ? `sealed:${attrs.cidr_block}` : null;
	}),
}));

vi.mock("@/lib/db", () => {
	const chain = () => {
		const c: Record<string, unknown> = {};
		Object.assign(c, {
			values: (v: Record<string, unknown>) => {
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

import { syncTokenCloudInventory } from "@/lib/cloud-providers/inventory/tokencloud";

const identity: Pick<CloudIdentity, "id" | "provider" | "credentials"> = {
	id: "ci-1",
	provider: "hetzner",
	credentials: { token: { v: 0, iv: "iv", tag: "tag", data: "data" } },
};

/** Two pages of networks, so the pagination cursor has somewhere to go. */
function networksPage(url: string): unknown {
	if (url.includes("page=2")) {
		return {
			networks: [{ id: 77, name: "second-page", ip_range: "10.9.0.0/16" }],
			meta: { pagination: { next_page: null } },
		};
	}
	return {
		networks: [
			{ id: 42, name: "prod-net", ip_range: "10.0.0.0/16" },
			{ id: 43, name: "no-range" },
		],
		meta: { pagination: { next_page: 2 } },
	};
}

/** Installs a fetch stub; `networksFails` makes only /v1/networks reject. */
function stubFetch(networksFails = false): void {
	vi.spyOn(globalThis, "fetch").mockImplementation(async (input: unknown) => {
		const url = String(input);
		if (url.includes("/v1/networks")) {
			if (networksFails) return { ok: false, status: 403 } as unknown as Response;
			return {
				ok: true,
				json: async () => networksPage(url),
			} as unknown as Response;
		}
		return {
			ok: true,
			json: async () => ({ locations: [{ name: "fsn1" }, { name: "nbg1" }] }),
		} as unknown as Response;
	});
}

/** Rows written to a given inventory table, identified by the column only that table's rows carry. */
function networkRows(): Record<string, unknown>[] {
	return h.inserted.filter((r) => "is_default" in r);
}
function regionRows(): Record<string, unknown>[] {
	return h.inserted.filter((r) => !("is_default" in r));
}

beforeEach(() => {
	h.inserted = [];
	h.softRemoves = [];
	h.sealed = [];
	vi.clearAllMocks();
	stubFetch();
});

describe("syncTokenCloudInventory — hetzner networks", () => {
	it("still syncs regions", async () => {
		await syncTokenCloudInventory(identity);
		expect(regionRows()).toContainEqual(
			expect.objectContaining({ native_id: "fsn1", provider: "hetzner", region: "fsn1" }),
		);
		expect(h.softRemoves).toContain("cloud_regions");
	});

	it("upserts each network on the numeric id, project-global (no region)", async () => {
		await syncTokenCloudInventory(identity);
		expect(networkRows()).toContainEqual(
			expect.objectContaining({
				cloud_identity_id: "ci-1",
				provider: "hetzner",
				native_id: "42",
				name: "prod-net",
				region: null,
			}),
		);
		expect(h.softRemoves).toContain("cloud_networks");
	});

	it("seals the CIDR instead of storing it in plaintext", async () => {
		await syncTokenCloudInventory(identity);
		const row = networkRows().find((r) => r.native_id === "42");
		expect(h.sealed).toContainEqual({ cidr_block: "10.0.0.0/16" });
		expect(row?.sensitive).toBe("sealed:10.0.0.0/16");
		// The range must not appear as a column of its own anywhere on the row.
		expect(JSON.stringify(row)).not.toContain('"10.0.0.0/16"');
	});

	it("keeps a network whose ip_range is absent, with no sealed blob", async () => {
		await syncTokenCloudInventory(identity);
		expect(networkRows()).toContainEqual(
			expect.objectContaining({ native_id: "43", sensitive: null }),
		);
	});

	it("follows pagination past the first page", async () => {
		await syncTokenCloudInventory(identity);
		expect(networkRows().map((r) => r.native_id)).toEqual(["42", "43", "77"]);
	});

	it("leaves the regions sync intact when /v1/networks fails", async () => {
		stubFetch(true);
		await expect(syncTokenCloudInventory(identity)).resolves.toBeUndefined();
		expect(regionRows().map((r) => r.native_id)).toEqual(["fsn1", "nbg1"]);
		expect(h.softRemoves).toContain("cloud_regions");
		expect(networkRows()).toEqual([]);
		expect(h.softRemoves).not.toContain("cloud_networks");
	});

	it("does not touch cloud_networks for a token cloud with no network lane", async () => {
		await syncTokenCloudInventory({ ...identity, provider: "civo" });
		expect(networkRows()).toEqual([]);
		expect(h.softRemoves).not.toContain("cloud_networks");
	});
});
