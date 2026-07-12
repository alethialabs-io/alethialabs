// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Fleet controller loop host (lib/fleet/scaler.ts) — a setInterval host like jobs/recovery. Capture
// the registered tick to drive it directly; assert the idempotency/DB-URL guards, that the tick
// reconciles loaded pools, and that wakeFleetScaler only fires once the loop is started.
//
// Plus the P1 re-entrancy proof (audit #12): overlapping wakes must NOT each read a stale instance
// list and double-create VMs. The serializer describe block drives the REAL controller + REAL
// planner over a latency-gated FakeFleet, so two wakes fired inside one hcloud round-trip window
// reproduce the race — and prove the coalescing serializer collapses them to a single follow-up.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/fleet/controller", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/lib/fleet/controller")>();
	// Spy by default (a no-op for the guard tests); the serializer block swaps in the REAL impl.
	return { ...actual, reconcileAll: vi.fn(async () => {}) };
});
vi.mock("@/lib/fleet/db-deps", () => ({ makeDbDeps: vi.fn(() => ({ deps: true })) }));
vi.mock("@/lib/fleet/pools-db", () => ({ loadFleetPools: vi.fn(async () => []) }));
vi.mock("@/lib/fleet/provider", () => ({ getFleetProvider: vi.fn(() => ({ provider: true })) }));
// The tick also GC's bootstrap tokens (real → DB); stub it so the loop stays hermetic in tests.
vi.mock("@/lib/runners/bootstrap-token", () => ({ sweepBootstrapTokens: vi.fn(async () => {}) }));

import { startFleetScaler, wakeFleetScaler } from "@/lib/fleet/scaler";
import { reconcileAll } from "@/lib/fleet/controller";
import { makeDbDeps } from "@/lib/fleet/db-deps";
import { loadFleetPools } from "@/lib/fleet/pools-db";
import { getFleetProvider } from "@/lib/fleet/provider";
import { FakeFleet } from "@/lib/fleet/fake-provider";
import type { FleetProvider, FleetTarget, ProviderInstance } from "@/lib/fleet/types";
import type { ControllerDeps } from "@/lib/fleet/controller";

/** The serializer state the scaler stashes on globalThis (mirrors lib/fleet/scaler.ts). */
const G = globalThis as unknown as {
	__alethiaFleetScaler?: unknown;
	__alethiaFleetTickInFlight?: Promise<void> | null;
	__alethiaFleetTickQueued?: boolean;
};
const ORIGINAL_URL = process.env.ALETHIA_DATABASE_URL;

let tick: (() => void) | null;
let intervalCalls: number;
beforeEach(() => {
	vi.clearAllMocks();
	delete G.__alethiaFleetScaler;
	G.__alethiaFleetTickInFlight = null;
	G.__alethiaFleetTickQueued = false;
	process.env.ALETHIA_DATABASE_URL = "postgres://x";
	tick = null;
	intervalCalls = 0;
	vi.stubGlobal("setInterval", (fn: () => void) => {
		intervalCalls++;
		tick = fn;
		return 1 as unknown as ReturnType<typeof setInterval>;
	});
});
afterEach(() => {
	vi.unstubAllGlobals();
	if (ORIGINAL_URL === undefined) delete process.env.ALETHIA_DATABASE_URL;
	else process.env.ALETHIA_DATABASE_URL = ORIGINAL_URL;
});

describe("startFleetScaler — guards", () => {
	it("registers one interval and is idempotent", () => {
		startFleetScaler();
		startFleetScaler();
		expect(intervalCalls).toBe(1);
	});

	it("does nothing without a database URL", () => {
		delete process.env.ALETHIA_DATABASE_URL;
		startFleetScaler();
		expect(intervalCalls).toBe(0);
	});
});

describe("tick / wakeFleetScaler", () => {
	it("reconciles the loaded pools on each tick", async () => {
		startFleetScaler();
		tick!();
		await new Promise((r) => setTimeout(r, 0));
		expect(loadFleetPools).toHaveBeenCalledTimes(1);
		expect(reconcileAll).toHaveBeenCalledWith([], { provider: true }, { deps: true }, expect.any(Map));
	});

	it("wakeFleetScaler is a no-op until the loop is started", async () => {
		wakeFleetScaler(); // not started yet
		await new Promise((r) => setTimeout(r, 0));
		expect(loadFleetPools).not.toHaveBeenCalled();

		startFleetScaler();
		wakeFleetScaler(); // now started → immediate reconcile
		await new Promise((r) => setTimeout(r, 0));
		expect(loadFleetPools).toHaveBeenCalledTimes(1);
	});
});

// ── P1 re-entrancy proof (audit #12) ─────────────────────────────────────────
// Drives the REAL reconcileAll + REAL planner (no controller mock) so a stale-read double-create is
// physically possible. The FakeFleet is latency-gated: list() and create() await a short delay,
// modelling the hcloud round-trip window during which a second wake would otherwise read the same
// empty snapshot and create a duplicate VM.

/** A FakeFleet whose primitives take real (awaitable) time, and which records the peak number of
 *  reconcile passes that were ever inside `list()` at once — max 1 proves the passes ran serially. */
class SlowFakeFleet extends FakeFleet {
	private readonly delayMs: number;
	/** Passes currently inside list() (a proxy for "ticks running right now"). */
	private listActive = 0;
	/** Peak of `listActive` — 1 = serialized, 2+ = re-entrant race. */
	maxListConcurrency = 0;

	/** @param delayMs latency each primitive awaits, opening the overlap window a race needs. */
	constructor(delayMs = 5) {
		super();
		this.delayMs = delayMs;
	}

	/** List instances after a latency gate, tracking concurrent entries to detect overlapping passes. */
	async list(project: FleetTarget): Promise<ProviderInstance[]> {
		this.listActive += 1;
		this.maxListConcurrency = Math.max(this.maxListConcurrency, this.listActive);
		try {
			await new Promise((r) => setTimeout(r, this.delayMs));
			return await super.list(project);
		} finally {
			this.listActive -= 1;
		}
	}

	/** Create an instance after a latency gate (so a racing pass's list() lands before create resolves). */
	async create(
		project: FleetTarget,
		opts: { location: string; version: string | null; bootstrapToken?: string },
	): Promise<void> {
		await new Promise((r) => setTimeout(r, this.delayMs));
		return super.create(project, opts);
	}
}

/** One pool whose target resolves to exactly 1 VM (warmMin 0, buffer 0, backlog 1, 1 slot). */
const ONE_VM_POOL: FleetTarget = {
	provider: "hetzner",
	warmMin: 0,
	buffer: 0,
	max: 2,
	surge: 0,
	slotsPerRunner: 1,
	minPerLocation: 0,
	locations: ["nbg1"],
	scaleDownGraceTicks: 99,
	targetVersion: null,
	channel: null,
};

/** Wait until the serializer's in-flight chain (incl. any coalesced follow-up) has fully drained. */
async function settleScaler(): Promise<void> {
	for (let i = 0; i < 2000; i++) {
		const inFlight = G.__alethiaFleetTickInFlight;
		if (!inFlight && !G.__alethiaFleetTickQueued) return;
		if (inFlight) await inFlight;
		else await new Promise((r) => setTimeout(r, 1));
	}
	throw new Error("scaler never settled");
}

describe("fleet scaler serializer — audit #12 (no re-entrant double-provision)", () => {
	let fake: SlowFakeFleet;

	beforeEach(async () => {
		// Swap the default no-op reconcileAll spy for the REAL controller (so a stale read can
		// actually double-create), and point the scaler's injected seams at the slow fake world.
		const actual = await vi.importActual<typeof import("@/lib/fleet/controller")>(
			"@/lib/fleet/controller",
		);
		vi.mocked(reconcileAll).mockImplementation(actual.reconcileAll);

		fake = new SlowFakeFleet();
		fake.backlog = 1; // targetCount(pool, backlog=1, peak=0) === 1
		vi.mocked(getFleetProvider).mockReturnValue(fake as unknown as FleetProvider);
		vi.mocked(makeDbDeps).mockReturnValue(fake.deps() as unknown as ControllerDeps);
		vi.mocked(loadFleetPools).mockResolvedValue([ONE_VM_POOL]);
	});

	afterEach(() => {
		vi.mocked(reconcileAll).mockImplementation(async () => {});
	});

	it("two wakes fired inside one round-trip create exactly ONE VM (not two) and never overlap", async () => {
		startFleetScaler();

		// Both wakes land before the first pass's list() resolves — the exact re-entrancy trigger.
		wakeFleetScaler();
		wakeFleetScaler();
		await settleScaler();

		// The race would create 2 VMs off the same empty snapshot; serialized → the follow-up sees
		// the first VM booting and creates none.
		expect(fake.all().length).toBe(1);
		// Direct proof the two passes never ran concurrently.
		expect(fake.maxListConcurrency).toBe(1);
		// The mid-pass wake was COALESCED into exactly one follow-up (not dropped, not duplicated).
		expect(loadFleetPools).toHaveBeenCalledTimes(2);
	});

	it("a burst of N wakes collapses to a single follow-up (converges to 1 VM, one extra pass)", async () => {
		startFleetScaler();

		for (let i = 0; i < 5; i++) wakeFleetScaler();
		await settleScaler();

		expect(fake.all().length).toBe(1);
		expect(fake.maxListConcurrency).toBe(1);
		// 1 running pass + exactly 1 coalesced follow-up, no matter how many wakes piled up.
		expect(loadFleetPools).toHaveBeenCalledTimes(2);
	});

	it("a wake arriving mid-pass is not dropped — it still triggers a follow-up pass", async () => {
		startFleetScaler();

		wakeFleetScaler(); // pass A starts
		// Let A get past its list() (inside create's latency window) before the next wake arrives.
		await new Promise((r) => setTimeout(r, 6));
		wakeFleetScaler(); // arrives mid-pass → must schedule exactly one follow-up
		await settleScaler();

		expect(loadFleetPools).toHaveBeenCalledTimes(2); // A + the follow-up (signal preserved)
		expect(fake.maxListConcurrency).toBe(1);
		expect(fake.all().length).toBe(1);
	});
});
