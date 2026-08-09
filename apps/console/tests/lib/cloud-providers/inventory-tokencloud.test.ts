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

/** A paginated `/v1/networks` answer: hcloud's real shape, `meta.pagination.next_page` included. */
const NETWORKS_PAGED: Record<string, unknown>[] = [
	{
		networks: NETWORKS.networks,
		meta: { pagination: { page: 1, next_page: 2 } },
	},
	{
		networks: [{ id: 9001, name: "page-two-net", ip_range: "10.40.0.0/16" }],
		meta: { pagination: { page: 2, next_page: null } },
	},
];

/** Records every URL fetched and answers the two Hetzner endpoints. When `networkPages` is given,
 *  `/v1/networks` is served page by page off its `page` query param — hcloud-style. */
function stubFetch(urls: string[], networkPages?: Record<string, unknown>[]) {
	vi.stubGlobal(
		"fetch",
		vi.fn((url: string) => {
			urls.push(url);
			let body: unknown;
			if (url.includes("/v1/networks")) {
				if (networkPages) {
					const page = Number(new URL(url).searchParams.get("page") ?? "1");
					body = networkPages[page - 1] ?? { networks: [] };
				} else {
					body = NETWORKS;
				}
			} else if (url.includes("/v1/locations")) {
				body = LOCATIONS;
			} else {
				body = { regions: [], data: [] };
			}
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
		// Paginated, not a bare listing: hcloud defaults to 25/page (50 max), and an unpaginated
		// fetch feeds a page-1-only `seen` into the soft-removal sweep (#1979).
		expect(urls).toContain("https://api.hetzner.cloud/v1/networks?per_page=50&page=1");
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

	it("follows meta.pagination so every page reaches cloud_networks", async () => {
		// #1979. Two pages; the second must be fetched (via meta.pagination.next_page) and land in
		// cloud_networks — before the fix, everything past page 1 was simply never seen.
		const urls: string[] = [];
		stubFetch(urls, NETWORKS_PAGED);

		await syncTokenCloudInventory(identity("hetzner"));

		expect(urls).toContain("https://api.hetzner.cloud/v1/networks?per_page=50&page=1");
		expect(urls).toContain("https://api.hetzner.cloud/v1/networks?per_page=50&page=2");

		const networks = networkRows();
		expect(networks.map((n) => n.values.native_id)).toEqual(["4242", "77", "9001"]);
	});

	it("counts page-2 networks as seen, so the sweep does not soft-remove them", async () => {
		// The sharp edge of #1979: `seen` fed only page 1 into softRemoveUnseen, so every network past
		// the first page was actively soft-removed on each sync — including a network_id a saved
		// project already points at.
		stubFetch([], NETWORKS_PAGED);

		await syncTokenCloudInventory(identity("hetzner"));

		const sweep = softRemovals.find((s) => s.table === "cloud_networks");
		expect(sweep?.seen).toContain("9001");
		expect(sweep?.seen).toEqual(["4242", "77", "9001"]);
	});

	it("stops at a terminal page instead of looping", async () => {
		// A single page whose pagination is exhausted (next_page null) must produce exactly one fetch.
		const urls: string[] = [];
		stubFetch(urls, [
			{ networks: NETWORKS.networks, meta: { pagination: { page: 1, next_page: null } } },
		]);

		await syncTokenCloudInventory(identity("hetzner"));

		expect(urls.filter((u) => u.includes("/v1/networks"))).toHaveLength(1);
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
