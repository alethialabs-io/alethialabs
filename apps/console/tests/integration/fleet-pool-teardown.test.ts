// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Integration (real Postgres): the fleet-pool TEARDOWN reconcile end-to-end — the fix for the
// cost-leak where deleting/pausing a managed pool orphaned its VMs and left the runners'
// runner_usage_sessions open (billed forever). Proves, against a real DB:
//   1. deleteFleetPool is a SOFT delete — the row STAYS with deleting=true (not physically gone),
//      and loadFleetPools now returns it as a teardown target (previously it vanished).
//   2. THE LEAK, shown non-vacuously first: while a managed runner's usage session is OPEN,
//      provisionedHoursByProvider keeps growing with the window end `to` — i.e. it bills forever.
//   3. THE FIX: driving one teardown reconcile (fake provider holding the VM + REAL makeDbDeps)
//      destroys the VM and retires the runner → its session's ended_at is set → the provisioned
//      hours FREEZE at the real duration regardless of `to`.
//   4. reapDeletedPools only removes the pool row once its VMs are gone AND no managed runner row
//      still maps to it (guards the list-race) — physically deleting the drained row at the end.
//   5. Pausing a live pool (enabled=false) likewise maps to a teardown target.
// The `fleet_pools` unique-per-provider index is partial (deleting=false), so this suite needs the
// `deleting` column migrated. Once the orchestrator generates the migration this runs under the
// normal `pnpm test:integration`; until then an ephemeral-PG harness applies the column manually.

import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { getServiceDb } from "@/lib/db";
import {
	type CloudProvider,
	fleetPools,
	runners,
	runnerUsageSessions,
} from "@/lib/db/schema";
import { reconcilePool } from "@/lib/fleet/controller";
import { makeDbDeps } from "@/lib/fleet/db-deps";
import { loadFleetPools, reapDeletedPools, rowToProject } from "@/lib/fleet/pools-db";
import type { FleetProvider, FleetTarget, ProviderInstance } from "@/lib/fleet/types";
import { provisionedHoursByProvider } from "@/lib/queries/runner-usage";
import { describeIfDb } from "./db";

// Self-managed so the fleet actions are operable; auth is mocked (this suite runs no auth flow).
process.env.ALETHIA_DEPLOYMENT_MODE ||= "self-managed";
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/authz/guard", () => ({ authorize: vi.fn(async () => undefined) }));
vi.mock("@/lib/authz", () => ({
	getPdp: () => ({ can: async () => ({ allowed: true }) }),
}));

// Imported AFTER the auth mocks so the action's guard calls resolve to the stubs.
const { deleteFleetPool } = await import("@/app/server/actions/fleet");

// A less-common provider, scoped + cleaned so a populated dev DB isn't perturbed.
const PROVIDER: CloudProvider = "digitalocean";
const RUNNER_ID = randomUUID();
const SRV = `it-srv-${RUNNER_ID.slice(0, 8)}`;
const STARTED_AT = new Date(Date.now() - 3600_000); // session opened ~1h ago

/** A minimal in-memory FleetProvider: holds a set of instance ids, records destroys. */
class MemProvider implements FleetProvider {
	private readonly ids: Set<string>;
	readonly destroyed: string[] = [];
	constructor(ids: string[]) {
		this.ids = new Set(ids);
	}
	async list(_project: FleetTarget): Promise<ProviderInstance[]> {
		return [...this.ids].map((id) => ({
			instanceId: id,
			location: "fra1",
			version: "1.2.3",
			ageSeconds: 3600,
		}));
	}
	async create(): Promise<void> {
		throw new Error("teardown must never create");
	}
	async destroy(instanceId: string): Promise<void> {
		this.ids.delete(instanceId);
		this.destroyed.push(instanceId);
	}
}

/** Provisioned hours attributed to our provider over [STARTED_AT-1m, to). */
async function providerHours(to: Date): Promise<number> {
	const rows = await provisionedHoursByProvider(getServiceDb(), {
		from: new Date(STARTED_AT.getTime() - 60_000),
		to,
	});
	return rows.find((r) => r.provider === PROVIDER)?.provisioned_hours ?? 0;
}

describeIfDb("fleet pool teardown (cost-leak fix)", () => {
	beforeAll(async () => {
		const db = getServiceDb();
		await db.delete(fleetPools).where(eq(fleetPools.provider, PROVIDER));
		await db.delete(runners).where(eq(runners.id, RUNNER_ID));

		await db.insert(fleetPools).values({
			provider: PROVIDER,
			name: "do-teardown-pool",
			warm_min: 1,
			max: 3,
			enabled: true,
		});
		// A managed runner that IS the pool's warm VM: ONLINE, idle, carrying the cloud instance id.
		await db.insert(runners).values({
			id: RUNNER_ID,
			name: `it-teardown-${RUNNER_ID.slice(0, 8)}`,
			operator: "managed",
			token_hash: `h-${RUNNER_ID}`,
			status: "ONLINE",
			supported_providers: [PROVIDER],
			location: "fra1",
			version: "1.2.3",
			metadata: { cloud_instance_id: SRV },
		});
		// Its OPEN metered usage session (ended_at NULL) — the thing that bills forever if orphaned.
		await db.insert(runnerUsageSessions).values({
			runner_id: RUNNER_ID,
			operator: "managed",
			started_at: STARTED_AT,
		});
	});

	afterAll(async () => {
		const db = getServiceDb();
		await db.delete(runners).where(eq(runners.id, RUNNER_ID)); // sessions cascade
		await db.delete(fleetPools).where(eq(fleetPools.provider, PROVIDER));
	});

	it("soft-deletes the pool (row stays, deleting=true) and loadFleetPools returns a teardown target", async () => {
		const [before] = await getServiceDb()
			.select()
			.from(fleetPools)
			.where(eq(fleetPools.provider, PROVIDER));
		expect(before.deleting).toBe(false);

		await deleteFleetPool(before.id);

		// The row must STILL EXIST (soft delete), now flagged deleting — a hard delete would strand
		// the VM + session with no controller left to reap them.
		const [after] = await getServiceDb()
			.select()
			.from(fleetPools)
			.where(eq(fleetPools.provider, PROVIDER));
		expect(after).toBeDefined();
		expect(after.deleting).toBe(true);
		expect(after.enabled).toBe(false);

		const target = (await loadFleetPools()).find((p) => p.provider === PROVIDER);
		expect(target?.teardown).toBe(true); // previously this returned [] (pool vanished)
	});

	it("LEAK then FIX: an open session bills forever; the teardown reconcile closes it and freezes the hours", async () => {
		// LEAK — while the session is OPEN, provisioned hours grow with the window end `to`: the
		// meter keeps billing the orphaned runner indefinitely.
		const openTo2h = await providerHours(new Date(Date.now() + 2 * 3600_000));
		const openTo4h = await providerHours(new Date(Date.now() + 4 * 3600_000));
		expect(openTo4h).toBeGreaterThan(openTo2h + 1.5); // ~2h more billed just by moving `to`

		// FIX — one teardown reconcile: the fake provider holds the VM, deps are REAL (so retire =
		// the real retireRunner that closes the session). Idle online instance → destroy → retire.
		const provider = new MemProvider([SRV]);
		const teardownTarget: FleetTarget = {
			...rowToProject(
				(
					await getServiceDb().select().from(fleetPools).where(eq(fleetPools.provider, PROVIDER))
				)[0],
			),
			teardown: true,
		};
		const acted = await reconcilePool(teardownTarget, provider, makeDbDeps(), new Map());
		expect(acted).toBe(1);
		expect(provider.destroyed).toEqual([SRV]); // the VM was destroyed (no orphan)

		// The session is now closed (ended_at set) — billing stops.
		const [session] = await getServiceDb()
			.select()
			.from(runnerUsageSessions)
			.where(eq(runnerUsageSessions.runner_id, RUNNER_ID));
		expect(session.ended_at).not.toBeNull();

		// Provisioned hours are now FROZEN at the real ~1h duration, independent of `to`.
		const closedTo2h = await providerHours(new Date(Date.now() + 2 * 3600_000));
		const closedTo4h = await providerHours(new Date(Date.now() + 4 * 3600_000));
		expect(closedTo4h).toBeCloseTo(closedTo2h, 5); // no longer grows with `to`
		expect(closedTo2h).toBeLessThan(openTo2h); // strictly less than the still-open bill
		expect(closedTo2h).toBeGreaterThan(0.9); // ~1h really elapsed
		expect(closedTo2h).toBeLessThan(1.2);
	});

	it("reapDeletedPools waits for the runner to be gone, then physically removes the drained row", async () => {
		const db = getServiceDb();
		// Provider is now empty (VM destroyed). But the retired runner row still carries the cloud
		// instance id, so the list-race guard must KEEP the pool (don't reap yet).
		await reapDeletedPools(new MemProvider([]));
		const stillThere = await db
			.select()
			.from(fleetPools)
			.where(eq(fleetPools.provider, PROVIDER));
		expect(stillThere).toHaveLength(1); // guarded: a runner row still maps to it

		// Once the offline runner row is pruned (the runner-row GC), the empty pool is reaped.
		await db.delete(runners).where(eq(runners.id, RUNNER_ID));
		await reapDeletedPools(new MemProvider([]));
		const gone = await db.select().from(fleetPools).where(eq(fleetPools.provider, PROVIDER));
		expect(gone).toHaveLength(0); // pool row physically removed
	});

	it("pausing a live pool (enabled=false) also maps to a teardown target", async () => {
		const db = getServiceDb();
		const paused: CloudProvider = "civo";
		await db.delete(fleetPools).where(eq(fleetPools.provider, paused));
		await db.insert(fleetPools).values({ provider: paused, warm_min: 1, enabled: false });
		try {
			const target = (await loadFleetPools()).find((p) => p.provider === paused);
			expect(target?.teardown).toBe(true);
		} finally {
			await db.delete(fleetPools).where(eq(fleetPools.provider, paused));
		}
	});
});
