// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Integration: the fleet-controller leader LEASE (tryBecomeFleetLeader) against real Postgres — the
// atomic upsert that makes exactly one console replica reconcile per tick. Proves: an empty lease is
// seized, a live lease is NOT stolen by another replica, the holder renews its own lease, and an
// EXPIRED lease is seized by whoever ticks next. fleet_leader is a single global row, so the test
// saves + restores any pre-existing row around its assertions.

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { getServiceDb } from "@/lib/db";
import { fleetLeader } from "@/lib/db/schema";
import type { FleetLeaderRow } from "@/lib/db/schema/fleet";
import { tryBecomeFleetLeader } from "@/lib/fleet/queue";
import { describeIfDb } from "./db";

const REPLICA_A = randomUUID();
const REPLICA_B = randomUUID();
const TTL = 90;

let prior: FleetLeaderRow | undefined;

describeIfDb("tryBecomeFleetLeader — single-replica reconcile lease", () => {
	beforeAll(async () => {
		const db = getServiceDb();
		[prior] = await db.select().from(fleetLeader);
		await db.delete(fleetLeader); // start from an empty lease
	});

	afterAll(async () => {
		const db = getServiceDb();
		await db.delete(fleetLeader);
		if (prior) await db.insert(fleetLeader).values(prior);
	});

	it("seizes an unheld lease, refuses a live one, renews its own, and seizes an expired one", async () => {
		const db = getServiceDb();

		// (1) Empty lease → A seizes it.
		expect(await tryBecomeFleetLeader(REPLICA_A, TTL)).toBe(true);

		// (2) A holds a fresh lease → B is refused (a live leader is never stolen).
		expect(await tryBecomeFleetLeader(REPLICA_B, TTL)).toBe(false);

		// (3) A renews its own lease every tick it wins.
		expect(await tryBecomeFleetLeader(REPLICA_A, TTL)).toBe(true);

		// (4) Force the lease to look expired (leader crashed mid-hold) → B seizes it next tick.
		await db.update(fleetLeader).set({ expires_at: new Date(Date.now() - 1000) });
		expect(await tryBecomeFleetLeader(REPLICA_B, TTL)).toBe(true);

		// …and now B holds it, so A is refused.
		expect(await tryBecomeFleetLeader(REPLICA_A, TTL)).toBe(false);
	});
});
