// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import {
	reconcilePool,
	type ControllerDeps,
	type RunnerState,
	type SurplusState,
} from "@/lib/fleet/controller";
import { FakeFleet } from "@/lib/fleet/fake-provider";
import { targetCount } from "@/lib/fleet/plan";
import type { FleetProvider, FleetTarget, ProviderInstance } from "@/lib/fleet/types";
import { describe, expect, it, vi } from "vitest";

function project(over: Partial<FleetTarget> = {}): FleetTarget {
	return {
		provider: "aws",
		warmMin: 2,
		max: 10,
		slotsPerRunner: 1,
		locations: ["fsn1", "nbg1"],
		minPerLocation: 1,
		surge: 1,
		buffer: 0,
		scaleDownGraceTicks: 3,
		targetVersion: "v2",
		channel: null,
		...over,
	};
}

/** Run reconcile→boot ticks until settled (or fail); optionally assert the warmMin
 *  invariant on every tick (for an already-running fleet). */
async function drive(
	fake: FakeFleet,
	s: FleetTarget,
	opts: { assertInvariant?: boolean; maxTicks?: number } = {},
): Promise<void> {
	const surplus: SurplusState = new Map();
	const target = targetCount(s, fake.backlog, fake.recentPeak);
	const resolvedTarget = s.targetVersion ?? (s.channel ? fake.channelVersion : null);
	for (let t = 0; t < (opts.maxTicks ?? 40); t++) {
		if (opts.assertInvariant) {
			expect(fake.online().length).toBeGreaterThanOrEqual(s.warmMin);
		}
		const acted = await reconcilePool(s, fake, fake.deps(), surplus);
		const online = fake.online();
		const settled =
			acted === 0 &&
			online.length === target &&
			online.every((i) => i.version === resolvedTarget);
		if (settled) return;
		fake.tick(); // booting → online, age advances
	}
	throw new Error("did not converge");
}

describe("controller — convergence against the fake fleet", () => {
	it("cold start ramps to target, one per location", async () => {
		const fake = new FakeFleet();
		await drive(fake, project());
		const online = fake.online();
		expect(online).toHaveLength(2);
		expect(new Set(online.map((i) => i.location))).toEqual(new Set(["fsn1", "nbg1"]));
		expect(online.every((i) => i.version === "v2")).toBe(true);
		// the controller writes each correlated runner's observed placement back (Phase 2 cockpit)
		for (const i of online) {
			expect(fake.persisted.get(i.runnerId as string)).toEqual({
				location: i.location,
				version: i.version,
			});
		}
	});

	it("rolls v1 → v2 without ever dropping online below warmMin", async () => {
		const fake = new FakeFleet();
		fake.seed({ version: "v1", location: "fsn1" });
		fake.seed({ version: "v1", location: "nbg1" });
		await drive(fake, project(), { assertInvariant: true });
		const online = fake.online();
		expect(online).toHaveLength(2);
		expect(online.every((i) => i.version === "v2")).toBe(true);
	});

	it("replaces a crashed instance (self-heal)", async () => {
		const fake = new FakeFleet();
		const a = fake.seed({ version: "v2", location: "fsn1" });
		fake.seed({ version: "v2", location: "nbg1" });
		// steady first
		const surplus: SurplusState = new Map();
		await reconcilePool(project(), fake, fake.deps(), surplus);
		expect(fake.online()).toHaveLength(2);
		// crash one → controller reaps + replaces
		fake.crash(a);
		await drive(fake, project());
		expect(fake.online()).toHaveLength(2);
		expect(fake.all().some((i) => i.instanceId === a)).toBe(false); // dead one reaped
	});

	it("resolves a channel to the latest version and rolls to it", async () => {
		const fake = new FakeFleet();
		fake.channelVersion = "v5";
		fake.seed({ version: "v4", location: "fsn1" });
		fake.seed({ version: "v4", location: "nbg1" });
		await drive(fake, project({ targetVersion: null, channel: "stable" }), { assertInvariant: true });
		expect(fake.online().every((i) => i.version === "v5")).toBe(true);
	});

	it("auto-grows the warm floor to recent peak, then scales back down", async () => {
		const fake = new FakeFleet();
		fake.seed({ version: "v2", location: "fsn1" });
		fake.seed({ version: "v2", location: "nbg1" });
		fake.recentPeak = 5; // load spike → target 5 (+buffer 0)
		await drive(fake, project({ buffer: 0 }));
		expect(fake.online().length).toBe(5);
		// spike subsides → scales back to warmMin after the grace window
		fake.recentPeak = 0;
		await drive(fake, project({ buffer: 0 }));
		expect(fake.online().length).toBe(2);
	});
});

// Focused reconcilePool tests with hand-built deps/provider, targeting the correlation + apply +
// hysteresis branches the happy-path convergence sim doesn't exercise (the mutation survivors).
function mkProvider(instances: ProviderInstance[]): FleetProvider {
	return { list: async () => instances, create: vi.fn(async () => {}), destroy: vi.fn(async () => {}) };
}
function mkDeps(over: Partial<ControllerDeps> = {}): ControllerDeps {
	return {
		runnerMap: async () => new Map<string, RunnerState>(),
		backlog: async () => 0,
		recentPeak: async () => 0,
		resolveChannel: vi.fn(async () => null),
		drain: vi.fn(async () => {}),
		retire: vi.fn(async () => {}),
		persistObserved: vi.fn(async () => {}),
		bootGraceSeconds: 120,
		mintBootstrapToken: vi.fn(async () => "boot-tok"),
		...over,
	};
}
const pi = (over: Partial<ProviderInstance> = {}): ProviderInstance => ({
	instanceId: "i",
	location: "fsn1",
	version: "v2",
	ageSeconds: 300,
	...over,
});
const solo = (over: Partial<FleetTarget> = {}): FleetTarget =>
	project({ warmMin: 0, minPerLocation: 0, locations: ["fsn1"], buffer: 0, ...over });

describe("reconcilePool — correlation, apply + hysteresis edges (mutation hardening)", () => {
	it("leaves an uncorrelated YOUNG instance booting, reaps an uncorrelated OLD one", async () => {
		const young = mkProvider([pi({ instanceId: "y", ageSeconds: 10 })]); // < bootGrace
		await reconcilePool(solo(), young, mkDeps(), new Map());
		expect(young.destroy).not.toHaveBeenCalled(); // booting, not dead

		const old = mkProvider([pi({ instanceId: "o", ageSeconds: 600 })]); // > bootGrace, no runner
		await reconcilePool(solo(), old, mkDeps(), new Map());
		expect(old.destroy).toHaveBeenCalledWith("o"); // dead → reaped
	});

	it("retires the correlated runner when its instance is destroyed", async () => {
		const prov = mkProvider([pi({ instanceId: "i1", ageSeconds: 600 })]);
		const deps = mkDeps({
			runnerMap: async () =>
				new Map([["i1", { runnerId: "r1", status: "offline", version: "v2", busy: false }]]),
		});
		await reconcilePool(solo(), prov, deps, new Map());
		expect(prov.destroy).toHaveBeenCalledWith("i1");
		expect(deps.retire).toHaveBeenCalledWith("r1"); // correlated runner closed out
	});

	it("persists observed placement only for correlated instances", async () => {
		const prov = mkProvider([
			pi({ instanceId: "c" }), // correlated
			pi({ instanceId: "u", ageSeconds: 10 }), // uncorrelated (young → kept)
		]);
		const deps = mkDeps({
			runnerMap: async () =>
				new Map([["c", { runnerId: "rc", status: "online", version: "v2", busy: false }]]),
		});
		await reconcilePool(solo({ warmMin: 1 }), prov, deps, new Map());
		expect(deps.persistObserved).toHaveBeenCalledTimes(1);
		expect(deps.persistObserved).toHaveBeenCalledWith("rc", { location: "fsn1", version: "v2" });
	});

	it("resolves the channel to a version only when no explicit version is pinned", async () => {
		const prov = mkProvider([]);
		const deps = mkDeps({ resolveChannel: vi.fn(async () => "v9") });
		await reconcilePool(solo({ targetVersion: null, channel: "stable", warmMin: 1 }), prov, deps, new Map());
		expect(deps.resolveChannel).toHaveBeenCalledWith("stable");
		expect(prov.create).toHaveBeenCalledWith(expect.anything(), {
			location: "fsn1",
			version: "v9",
			bootstrapToken: "boot-tok",
		});
	});

	it("accrues surplus ticks while over target and resets when not", async () => {
		const onlinePair = mkProvider([pi({ instanceId: "a" }), pi({ instanceId: "b" })]);
		const correlated = mkDeps({
			runnerMap: async () =>
				new Map([
					["a", { runnerId: "ra", status: "online", version: "v2", busy: false }],
					["b", { runnerId: "rb", status: "online", version: "v2", busy: false }],
				]),
		});
		// target 0 (warmMin 0), 2 online → over target → counter climbs each tick.
		const surplus: SurplusState = new Map();
		await reconcilePool(solo(), onlinePair, correlated, surplus);
		expect(surplus.get("aws")).toBe(1);
		await reconcilePool(solo(), onlinePair, correlated, surplus);
		expect(surplus.get("aws")).toBe(2);
		// target 2 (warmMin 2), 2 online → NOT over target → reset to 0.
		await reconcilePool(solo({ warmMin: 2 }), onlinePair, correlated, surplus);
		expect(surplus.get("aws")).toBe(0);
	});
});
