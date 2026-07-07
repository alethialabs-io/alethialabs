// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Integration: the DB-backed fleet-pool config against real Postgres — loadFleetPools' enabled
// WHERE-filter + the row→FleetTarget mapping (version-pin-wins-over-channel) that mocks can't
// verify, plus that a live enabled-toggle (CRUD UPDATE) is reflected on the next load. The
// `fleet_pools` table is GLOBAL (no org_id) with a unique index on `provider`, so the suite uses
// a fixed set of providers, clears any pre-existing rows for exactly those providers, and cleans
// up the same set afterwards — assertions are scoped to those providers (never raw totals).

import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import { getServiceDb } from "@/lib/db";
import { type CloudProvider, fleetPools, type NewFleetPool } from "@/lib/db/schema";
import { loadFleetPools, rowToProject } from "@/lib/fleet/pools-db";
import { describeIfDb } from "./db";

// Less-common providers, unlikely to clash with anything a dev/CI box has actually seeded.
const ENABLED_A: CloudProvider = "civo";
const ENABLED_B: CloudProvider = "alibaba";
const DISABLED: CloudProvider = "digitalocean";
const MINE: CloudProvider[] = [ENABLED_A, ENABLED_B, DISABLED];

const seed: NewFleetPool[] = [
	{
		// version pin set → mapping must prefer it and null out channel.
		provider: ENABLED_A,
		name: "civo-pool",
		warm_min: 2,
		max: 12,
		slots_per_runner: 3,
		locations: ["lon1", "nyc1"],
		min_per_location: 1,
		surge: 2,
		buffer: 2,
		scale_down_grace_ticks: 7,
		version: "v1.2.3",
		channel: "stable", // present but must be ignored because version wins
		enabled: true,
	},
	{
		// no version pin → mapping must keep the channel and leave targetVersion null.
		provider: ENABLED_B,
		name: "alibaba-pool",
		warm_min: 3,
		max: 20,
		slots_per_runner: 4,
		locations: ["fra1", "ams3"],
		min_per_location: 2,
		surge: 3,
		buffer: 1,
		scale_down_grace_ticks: 9,
		version: null,
		channel: "beta",
		enabled: true,
	},
	{
		// disabled → must never appear in loadFleetPools().
		provider: DISABLED,
		name: "do-pool",
		warm_min: 5,
		max: 5,
		enabled: false,
	},
];

describeIfDb("fleet pools DB config", () => {
	beforeAll(async () => {
		const db = getServiceDb();
		// Clear any pre-existing rows for exactly our providers (unique-per-provider index).
		await db.delete(fleetPools).where(inArray(fleetPools.provider, MINE));
		await db.insert(fleetPools).values(seed);
	});

	afterAll(async () => {
		await getServiceDb().delete(fleetPools).where(inArray(fleetPools.provider, MINE));
	});

	it("loads only enabled pools (the disabled one is filtered out)", async () => {
		const all = await loadFleetPools();
		const mine = all.filter((p) => MINE.includes(p.provider));
		const providers = mine.map((p) => p.provider).sort();
		expect(providers).toEqual([ENABLED_B, ENABLED_A].sort()); // civo + alibaba, NOT digitalocean
		expect(mine.some((p) => p.provider === DISABLED)).toBe(false);
	});

	it("maps every column 1:1 onto the FleetTarget shape", async () => {
		const all = await loadFleetPools();
		const civo = all.find((p) => p.provider === ENABLED_A);
		expect(civo).toEqual({
			provider: "civo",
			warmMin: 2,
			max: 12,
			slotsPerRunner: 3,
			locations: ["lon1", "nyc1"],
			minPerLocation: 1,
			surge: 2,
			buffer: 2,
			scaleDownGraceTicks: 7,
			targetVersion: "v1.2.3",
			channel: null, // version pin wins → channel nulled
		});
	});

	it("keeps the channel (targetVersion null) when no version is pinned", async () => {
		const all = await loadFleetPools();
		const ali = all.find((p) => p.provider === ENABLED_B);
		expect(ali?.targetVersion).toBeNull();
		expect(ali?.channel).toBe("beta");
		expect(ali?.locations).toEqual(["fra1", "ams3"]);
	});

	it("reflects a live enabled-toggle (CRUD update) on the next load", async () => {
		const db = getServiceDb();
		// Pause civo → it should drop out of the load.
		await db.update(fleetPools).set({ enabled: false }).where(eq(fleetPools.provider, ENABLED_A));
		let mine = (await loadFleetPools()).filter((p) => MINE.includes(p.provider));
		expect(mine.map((p) => p.provider)).toEqual([ENABLED_B]);

		// Resume civo → it returns.
		await db.update(fleetPools).set({ enabled: true }).where(eq(fleetPools.provider, ENABLED_A));
		mine = (await loadFleetPools()).filter((p) => MINE.includes(p.provider));
		expect(mine.map((p) => p.provider).sort()).toEqual([ENABLED_B, ENABLED_A].sort());
	});

	it("applies schema column defaults for the sparsely-seeded disabled row", async () => {
		// rowToProject over the raw row proves the DB defaults (warm floor etc.) round-trip.
		const [row] = await getServiceDb()
			.select()
			.from(fleetPools)
			.where(eq(fleetPools.provider, DISABLED));
		const target = rowToProject(row);
		expect(target.provider).toBe("digitalocean");
		expect(target.slotsPerRunner).toBe(1); // schema default
		expect(target.locations).toEqual(["fsn1"]); // schema default
		expect(target.minPerLocation).toBe(0);
		expect(target.surge).toBe(1);
		expect(target.buffer).toBe(1);
		expect(target.scaleDownGraceTicks).toBe(5);
		expect(target.targetVersion).toBeNull();
		expect(target.channel).toBeNull();
	});
});
