// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Integration: the DB-backed fleet-pool config against real Postgres — loadFleetPools now loads
// EVERY pool (no enabled WHERE-filter) and maps disabled/deleting rows to a TEARDOWN target so the
// controller can drain their VMs + close sessions instead of orphaning them; plus the
// row→FleetTarget mapping (version-pin-wins-over-channel) that mocks can't verify, and that a live
// enabled-toggle (CRUD UPDATE) flips the teardown flag on the next load. The
// `fleet_pools` table is GLOBAL (no org_id) with a unique index on `provider`, so the suite uses
// a fixed set of providers, clears any pre-existing rows for exactly those providers, and cleans
// up the same set afterwards — assertions are scoped to those providers (never raw totals).

import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { getServiceDb } from "@/lib/db";
import { type CloudProvider, fleetPools, type NewFleetPool } from "@/lib/db/schema";
import { loadFleetPools, rowToProject, upsertFleetPool } from "@/lib/fleet/pools-db";
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
		locations: ["fsn1", "nbg1"],
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
		locations: ["hel1", "ash"],
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

	it("loads ALL pools and maps a disabled (paused) row to a teardown target (no longer filtered out)", async () => {
		const all = await loadFleetPools();
		const mine = all.filter((p) => MINE.includes(p.provider));
		const providers = mine.map((p) => p.provider).sort();
		// digitalocean (disabled) is now PRESENT — as a teardown target, so its VMs drain to zero.
		expect(providers).toEqual([ENABLED_A, ENABLED_B, DISABLED].sort());
		expect(mine.find((p) => p.provider === ENABLED_A)?.teardown).toBeUndefined(); // enabled → normal
		expect(mine.find((p) => p.provider === ENABLED_B)?.teardown).toBeUndefined();
		expect(mine.find((p) => p.provider === DISABLED)?.teardown).toBe(true); // paused → drain
	});

	it("maps every column 1:1 onto the FleetTarget shape", async () => {
		const all = await loadFleetPools();
		const civo = all.find((p) => p.provider === ENABLED_A);
		expect(civo).toEqual({
			provider: "civo",
			warmMin: 2,
			max: 12,
			slotsPerRunner: 3,
			locations: ["fsn1", "nbg1"],
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
		expect(ali?.locations).toEqual(["hel1", "ash"]);
	});

	it("flips a live enabled-toggle to the teardown flag on the next load (pause = drain, not drop)", async () => {
		const db = getServiceDb();
		// Pause civo → it STAYS in the load but as a teardown target (drains to zero), rather than
		// vanishing (which previously orphaned its VMs + left their sessions billing).
		await db.update(fleetPools).set({ enabled: false }).where(eq(fleetPools.provider, ENABLED_A));
		let civo = (await loadFleetPools()).find((p) => p.provider === ENABLED_A);
		expect(civo?.teardown).toBe(true);

		// Resume civo → back to a normal (non-teardown) target.
		await db.update(fleetPools).set({ enabled: true }).where(eq(fleetPools.provider, ENABLED_A));
		civo = (await loadFleetPools()).find((p) => p.provider === ENABLED_A);
		expect(civo?.teardown).toBeUndefined();
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

// upsertFleetPool is the pool BIRTH path (the console/CLI `fleet set`): without it an empty
// fleet_pools table — the state when FLEET_POOLS never seeded — could never gain a pool without a
// redeploy. Verifies create-with-defaults, partial-field update, and the partial-unique-index
// handling that lets a fresh pool be born alongside a still-draining one for the same provider.
describeIfDb("fleet pool upsert (create-or-update via upsertFleetPool)", () => {
	// Test-owned providers (the suite already treats these as clobberable).
	const NEW_PROVIDER: CloudProvider = "civo";
	const EXISTING: CloudProvider = "alibaba";
	const UP: CloudProvider[] = [NEW_PROVIDER, EXISTING];

	beforeEach(async () => {
		await getServiceDb().delete(fleetPools).where(inArray(fleetPools.provider, UP));
	});
	afterAll(async () => {
		await getServiceDb().delete(fleetPools).where(inArray(fleetPools.provider, UP));
	});

	it("CREATES a pool for a provider that has none, applying the passed fields and schema defaults for the rest", async () => {
		const row = await upsertFleetPool(NEW_PROVIDER, { warm_min: 2, enabled: true });
		expect(row.provider).toBe(NEW_PROVIDER);
		expect(row.warm_min).toBe(2); // provided
		expect(row.max).toBe(10); // schema default
		expect(row.slots_per_runner).toBe(1); // schema default
		expect(row.locations).toEqual(["fsn1"]); // schema default
		expect(row.enabled).toBe(true);
		expect(row.deleting).toBe(false);
		// The controller can now see it.
		const loaded = (await loadFleetPools()).find((p) => p.provider === NEW_PROVIDER);
		expect(loaded).toBeDefined();
	});

	it("UPDATES only the provided fields on an existing live pool, leaving the rest intact", async () => {
		await getServiceDb().insert(fleetPools).values({
			provider: EXISTING,
			warm_min: 3,
			max: 20,
			slots_per_runner: 4,
			channel: "beta",
		});
		const row = await upsertFleetPool(EXISTING, { max: 25 });
		expect(row.max).toBe(25); // changed
		expect(row.warm_min).toBe(3); // untouched
		expect(row.slots_per_runner).toBe(4); // untouched
		expect(row.channel).toBe("beta"); // untouched
	});

	it("is born ALONGSIDE a still-draining pool for the same provider — no ON CONFLICT collision (partial unique index)", async () => {
		// A pool mid-teardown (deleting = true) sits outside the `deleting = false` partial index…
		await getServiceDb()
			.insert(fleetPools)
			.values({ provider: NEW_PROVIDER, deleting: true, warm_min: 9 });
		// …so creating a fresh LIVE pool must succeed (not error, not overwrite the draining row).
		const fresh = await upsertFleetPool(NEW_PROVIDER, { warm_min: 1, enabled: true });
		expect(fresh.deleting).toBe(false);
		expect(fresh.warm_min).toBe(1);
		const rows = await getServiceDb()
			.select()
			.from(fleetPools)
			.where(eq(fleetPools.provider, NEW_PROVIDER));
		expect(rows.length).toBe(2); // draining + fresh coexist
		expect(rows.filter((r) => !r.deleting)).toHaveLength(1); // exactly one LIVE pool
	});
});
