// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// #1816. The canvas's "Existing network" control is a SELECT over synced inventory, so a cloud that
// syncs no networks has an empty picker and `provision_network = false` cannot be chosen at all —
// however well the template honors it. Hetzner listed regions only, which is what made the network
// half of #1816 unreachable from the product rather than merely unfinished.
//
// DigitalOcean and Civo stay regions-only, and that is asserted too: a sweep that listed networks
// for them would soft-remove rows on a table they never populate.

import { beforeEach, describe, expect, it, vi } from "vitest";

const inserts: Array<{ table: unknown; values: Record<string, unknown> }> = [];
const softRemovals: Array<{ table: string; seen: string[] }> = [];

vi.mock("@/lib/db", () => ({
	getServiceDb: () => ({
		insert: (table: unknown) => ({
			values: (values: Record<string, unknown>) => ({
				onConflictDoUpdate: () => {
					inserts.push({ table, values });
					return Promise.resolve();
				},
			}),
		}),
	}),
}));

vi.mock("@/lib/crypto/secrets", () => ({
	decryptSecret: () => ({ api_token: "hcloud-token" }),
}));

vi.mock("@/lib/cloud-providers/inventory/upsert", () => ({
	sealSensitive: (attrs: Record<string, string | undefined>) => JSON.stringify(attrs),
	softRemoveUnseen: (table: string, _id: string, seen: string[]) => {
		softRemovals.push({ table, seen });
		return Promise.resolve();
	},
}));

import { type CloudIdentity, type CloudProvider, cloudNetworks } from "@/lib/db/schema";
import { syncTokenCloudInventory } from "@/lib/cloud-providers/inventory/tokencloud";

/** Rows this sync wrote to cloud_networks, by table identity rather than by name. */
const networkRows = () => inserts.filter((i) => i.table === cloudNetworks);

const LOCATIONS = { locations: [{ name: "fsn1" }, { name: "hel1" }] };
const NETWORKS = {
	networks: [
		{ id: 4242, name: "shared-prod-net", ip_range: "10.20.0.0/16" },
		{ id: 77, name: "legacy", ip_range: "10.30.0.0/16" },
	],
};

/** Records every URL fetched and answers the two Hetzner endpoints. */
function stubFetch(urls: string[]) {
	vi.stubGlobal(
		"fetch",
		vi.fn((url: string) => {
			urls.push(url);
			const body = url.includes("/v1/networks")
				? NETWORKS
				: url.includes("/v1/locations")
					? LOCATIONS
					: { regions: [], data: [] };
			return Promise.resolve({ ok: true, json: () => Promise.resolve(body) });
		}),
	);
}

/** The slice of a cloud identity `syncTokenCloudInventory` actually reads. Typed rather than cast:
 *  `as` is a rule violation here, and the lint gate is right — a cast would also have hidden a
 *  provider slug that no longer exists. */
const identity = (
	provider: CloudProvider,
): Pick<CloudIdentity, "id" | "provider" | "credentials"> => ({
	id: "identity-1",
	// Never actually decrypted — `decryptSecret` is mocked. The envelope only has to be the shape
	// the column declares, so a change to it fails here rather than at runtime.
	provider,
	credentials: { token: { v: 1, iv: "y", tag: "z", data: "x" } },
});

describe("syncTokenCloudInventory — Hetzner networks", () => {
	beforeEach(() => {
		inserts.length = 0;
		softRemovals.length = 0;
		vi.unstubAllGlobals();
	});

	it("lists networks as well as regions", async () => {
		const urls: string[] = [];
		stubFetch(urls);

		await syncTokenCloudInventory(identity("hetzner"));

		expect(urls).toContain("https://api.hetzner.cloud/v1/locations");
		expect(urls).toContain("https://api.hetzner.cloud/v1/networks");
	});

	it("stores the numeric hcloud id as native_id, because that is what the template reads", async () => {
		stubFetch([]);
		await syncTokenCloudInventory(identity("hetzner"));

		const networks = networkRows();
		expect(networks).toHaveLength(2);

		const shared = networks.find((n) => n.values.name === "shared-prod-net");
		// A string, not a number: `native_id` is text, and `local.existing_network_is_id` in the
		// Hetzner template decides id-vs-name by whether it parses as a number.
		expect(shared?.values.native_id).toBe("4242");
		// An hcloud network spans network zones rather than living in one location — claiming a
		// region would filter it out of the picker everywhere else.
		expect(shared?.values.region).toBeNull();
	});

	it("seals the CIDR rather than storing it in the clear", async () => {
		stubFetch([]);
		await syncTokenCloudInventory(identity("hetzner"));

		const shared = networkRows().find((n) => n.values.name === "shared-prod-net");
		// sealSensitive is mocked to JSON — the point is that the range went THROUGH it and did not
		// land in a plain column of its own.
		expect(shared?.values.sensitive).toContain("10.20.0.0/16");
		expect(Object.keys(shared?.values ?? {})).not.toContain("cidr_block");
	});

	it("reconciles networks it no longer sees", async () => {
		stubFetch([]);
		await syncTokenCloudInventory(identity("hetzner"));

		const sweep = softRemovals.find((s) => s.table === "cloud_networks");
		expect(sweep?.seen).toEqual(["4242", "77"]);
	});

	it("leaves the other token clouds on regions only", async () => {
		for (const provider of ["digitalocean", "civo"] as const) {
			inserts.length = 0;
			softRemovals.length = 0;
			const urls: string[] = [];
			stubFetch(urls);

			await syncTokenCloudInventory(identity(provider));

			expect(urls.some((u) => u.includes("/networks"))).toBe(false);
			expect(networkRows()).toHaveLength(0);
			expect(softRemovals.some((s) => s.table === "cloud_networks")).toBe(false);
		}
	});
});
