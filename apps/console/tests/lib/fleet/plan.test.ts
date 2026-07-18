// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { plan, targetCount } from "@/lib/fleet/plan";
import type { FleetAction, FleetTarget, Observed, ObservedInstance } from "@/lib/fleet/types";
import { describe, expect, it } from "vitest";

function project(over: Partial<FleetTarget> = {}): FleetTarget {
	return {
		provider: "aws",
		warmMin: 2,
		max: 10,
		slotsPerRunner: 1,
		locations: ["fsn1", "nbg1"],
		minPerLocation: 1,
		surge: 1,
		buffer: 1,
		scaleDownGraceTicks: 3,
		targetVersion: "v2",
		channel: null,
		...over,
	};
}

let seq = 0;
function inst(over: Partial<ObservedInstance> = {}): ObservedInstance {
	const id = over.instanceId ?? `i${seq++}`;
	return {
		instanceId: id,
		location: "fsn1",
		version: "v2",
		ageSeconds: 300,
		runnerId: id,
		status: "online",
		busy: false,
		...over,
	};
}

function obs(instances: ObservedInstance[], over: Partial<Observed> = {}): Observed {
	return { instances, backlog: 0, recentPeak: 0, bootGraceSeconds: 120, surplusTicks: 0, ...over };
}

const creates = (a: FleetAction[]) => a.filter((x) => x.type === "create");
const drains = (a: FleetAction[]) => a.filter((x) => x.type === "drain");
const destroys = (a: FleetAction[]) => a.filter((x) => x.type === "destroy");

describe("targetCount", () => {
	it("floors at warmMin, lifts by demand + buffer, clamps to max", () => {
		expect(targetCount(project(), 0, 0)).toBe(2); // warmMin
		expect(targetCount(project(), 5, 0)).toBe(6); // ceil(5/1)+buffer
		expect(targetCount(project(), 0, 4)).toBe(5); // peak+buffer
		expect(targetCount(project(), 1000, 0)).toBe(10); // max clamp
	});

	it("divides backlog by slotsPerRunner and rounds UP (ceil)", () => {
		// 5 jobs / 2 slots = 2.5 → ceil 3 demand; +buffer 1 = 4 (floor would give 3).
		expect(targetCount(project({ slotsPerRunner: 2, warmMin: 0, buffer: 1 }), 5, 0)).toBe(4);
		// 4 jobs / 2 slots = exactly 2; +buffer 1 = 3.
		expect(targetCount(project({ slotsPerRunner: 2, warmMin: 0, buffer: 1 }), 4, 0)).toBe(3);
	});

	it("treats slotsPerRunner < 1 as 1 (no divide-by-zero blow-up)", () => {
		// slots 0 → max(1,0)=1 → 3 jobs / 1 = 3 demand; +buffer 1 = 4.
		expect(targetCount(project({ slotsPerRunner: 0, warmMin: 0, buffer: 1 }), 3, 0)).toBe(4);
	});

	it("takes the MAX of recent peak and backlog-derived demand", () => {
		// peak 4 dominates backlog-demand 3 (3 jobs/1 slot); +buffer 1 = 5.
		expect(targetCount(project({ warmMin: 0, buffer: 1 }), 3, 4)).toBe(5);
		// backlog-demand 8 dominates peak 2; +buffer 1 = 9.
		expect(targetCount(project({ warmMin: 0, buffer: 1 }), 8, 2)).toBe(9);
	});

	it("clamps negative backlog to zero demand", () => {
		// max(0, -5) → 0 demand, so warmMin 2 floors it (not a negative result).
		expect(targetCount(project({ buffer: 0 }), -5, 0)).toBe(2);
	});
});

describe("plan — count + placement", () => {
	it("cold start creates to target, one per location (minPerLocation)", () => {
		const a = plan(project(), obs([]));
		expect(creates(a)).toHaveLength(2);
		expect(new Set(creates(a).map((c) => c.type === "create" && c.location))).toEqual(
			new Set(["fsn1", "nbg1"]),
		);
	});

	it("scales up on backlog", () => {
		const a = plan(project(), obs([], { backlog: 5 })); // target 6
		expect(creates(a)).toHaveLength(6);
	});

	it("enforces minPerLocation even when the count target is met", () => {
		// 2 online both in fsn1 → count met (target 2) but nbg1 below min → 1 create in nbg1
		const a = plan(project(), obs([inst({ location: "fsn1" }), inst({ location: "fsn1" })]));
		const c = creates(a);
		expect(c).toHaveLength(1);
		expect(c[0].type === "create" && c[0].location).toBe("nbg1");
	});
});

describe("plan — health", () => {
	it("reaps a dead (offline) instance and replaces it", () => {
		const a = plan(
			project(),
			obs([
				inst({ location: "fsn1" }),
				inst({ location: "nbg1", status: "offline", runnerId: "r" }),
			]),
		);
		expect(destroys(a)).toHaveLength(1); // reap the offline one
		expect(creates(a).length).toBeGreaterThanOrEqual(1); // online (1) < target (2) → recreate
	});

	it("treats an unregistered young instance as booting (not dead)", () => {
		const a = plan(
			project({ warmMin: 1, minPerLocation: 0, locations: ["fsn1"] }),
			obs([inst({ status: "none", runnerId: null, ageSeconds: 10 })], { bootGraceSeconds: 120 }),
		);
		expect(destroys(a)).toHaveLength(0); // still booting → leave it
	});

	it("reaps an unregistered instance past the boot grace", () => {
		const a = plan(
			project({ warmMin: 0, minPerLocation: 0, locations: ["fsn1"], buffer: 0 }),
			obs([inst({ status: "none", runnerId: null, ageSeconds: 600 })], { bootGraceSeconds: 120 }),
		);
		expect(destroys(a)).toHaveLength(1);
	});
});

describe("plan — version rollout", () => {
	it("surges a replacement before draining when at target", () => {
		// 2 outdated online at target 2 → can't drain yet (online not > target) → surge 1 new
		const a = plan(project(), obs([inst({ version: "v1" }), inst({ version: "v1", location: "nbg1" })]));
		expect(drains(a)).toHaveLength(0);
		const c = creates(a);
		expect(c).toHaveLength(1);
		expect(c[0].type === "create" && c[0].version).toBe("v2");
	});

	it("drains one outdated once online exceeds target", () => {
		// 2 v1 + 1 v2 online (3 > target 2) → drain one v1, no new create
		const a = plan(
			project(),
			obs([
				inst({ version: "v1", instanceId: "old1", runnerId: "old1" }),
				inst({ version: "v1", location: "nbg1", instanceId: "old2", runnerId: "old2" }),
				inst({ version: "v2" }),
			]),
		);
		expect(drains(a)).toHaveLength(1);
		expect(creates(a)).toHaveLength(0);
		const d = drains(a)[0];
		expect(d.type === "drain" && d.runnerId.startsWith("old")).toBe(true);
	});

	it("reaps a drained instance once idle", () => {
		const a = plan(
			project(),
			obs([inst(), inst({ location: "nbg1" }), inst({ status: "draining", busy: false })]),
		);
		expect(destroys(a)).toHaveLength(1);
	});

	it("never drains a busy outdated runner's slot out from under it", () => {
		// prefers the idle outdated when online > target
		const a = plan(
			project(),
			obs([
				inst({ version: "v1", busy: true, instanceId: "busy", runnerId: "busy" }),
				inst({ version: "v1", busy: false, location: "nbg1", instanceId: "idle", runnerId: "idle" }),
				inst({ version: "v2" }),
			]),
		);
		const d = drains(a);
		expect(d).toHaveLength(1);
		expect(d[0].type === "drain" && d[0].runnerId).toBe("idle");
	});
});

describe("plan — idle surplus scale-down", () => {
	it("holds surplus until the grace window elapses", () => {
		const instances = [inst(), inst({ location: "nbg1" }), inst({ location: "nbg1" })]; // 3 > target 2
		expect(destroys(plan(project(), obs(instances, { surplusTicks: 1 })))).toHaveLength(0);
		// grace elapsed → drop the surplus idle one (nbg1 has 2 > min 1)
		const a = plan(project(), obs(instances, { surplusTicks: 3 }));
		expect(destroys(a)).toHaveLength(1);
	});

	it("never scales a location below its minimum", () => {
		// target 2, 2 online (1 per loc) but surplusTicks high → nothing to drop (each at min)
		const a = plan(project(), obs([inst({ location: "fsn1" }), inst({ location: "nbg1" })], { surplusTicks: 9 }));
		expect(destroys(a)).toHaveLength(0);
	});
});

describe("plan — placement + capacity-cap edges (mutation hardening)", () => {
	it("distributes creates round-robin to the least-loaded location", () => {
		// 3 creates over 2 locations, min 0 (skips the below-min path) → fsn1, nbg1, fsn1 (least-loaded each time).
		const a = plan(
			project({ minPerLocation: 0, locations: ["fsn1", "nbg1"], warmMin: 3, buffer: 0, max: 10 }),
			obs([]),
		);
		const locs = creates(a).map((c) => c.type === "create" && c.location);
		expect(locs).toHaveLength(3);
		expect(locs.filter((l) => l === "fsn1")).toHaveLength(2);
		expect(locs.filter((l) => l === "nbg1")).toHaveLength(1);
	});

	it("never creates beyond max + surge, even to satisfy per-location minimums", () => {
		// target 0, but minPerLocation 2 × 2 locations = 4 wanted; max 2 + surge 1 = 3 hard cap.
		const a = plan(
			project({ max: 2, surge: 1, warmMin: 0, buffer: 0, minPerLocation: 2, locations: ["fsn1", "nbg1"] }),
			obs([]),
		);
		expect(creates(a)).toHaveLength(3);
	});

	it("caps creates at the global maxCreates budget (fleet-wide ceiling)", () => {
		// The pool wants 5 (warmMin 5) from empty, but the fleet ceiling leaves only 2 of headroom.
		const a = plan(project({ warmMin: 5, buffer: 0, max: 10 }), obs([], { maxCreates: 2 }));
		expect(creates(a)).toHaveLength(2);
		// min-per-location creates also respect the budget: 0 headroom ⇒ no VMs even below the floor.
		const b = plan(
			project({ warmMin: 0, buffer: 0, minPerLocation: 2, locations: ["fsn1"] }),
			obs([], { maxCreates: 0 }),
		);
		expect(creates(b)).toHaveLength(0);
	});

	it("the global budget limits ONLY creates — scale-down still proceeds at zero headroom", () => {
		// 3 idle online at target version, target 1 (warmMin 1), grace elapsed: 2 surplus are destroyed
		// even though the fleet ceiling forbids any new VM this tick (maxCreates 0).
		const online3 = [inst(), inst(), inst()];
		const a = plan(
			project({ warmMin: 1, buffer: 0, minPerLocation: 0, scaleDownGraceTicks: 0, locations: ["fsn1"] }),
			obs(online3, { maxCreates: 0, surplusTicks: 9 }),
		);
		expect(creates(a)).toHaveLength(0);
		expect(destroys(a)).toHaveLength(2);
	});

	it("scales surplus down from the most-loaded location, never below a location minimum", () => {
		// 3 online: 2 in fsn1, 1 in nbg1; target 2; min 1; grace elapsed → drop 1 from fsn1 (over min),
		// and crucially NOT from nbg1 (which sits exactly at the minimum).
		const a = plan(
			project({ warmMin: 2, buffer: 0, minPerLocation: 1, locations: ["fsn1", "nbg1"] }),
			obs(
				[
					inst({ location: "fsn1", instanceId: "f1", runnerId: "f1" }),
					inst({ location: "fsn1", instanceId: "f2", runnerId: "f2" }),
					inst({ location: "nbg1", instanceId: "n1", runnerId: "n1" }),
				],
				{ surplusTicks: 5 },
			),
		);
		const d = destroys(a);
		expect(d).toHaveLength(1);
		expect(d[0].type === "destroy" && d[0].instanceId).toMatch(/^f/); // fsn1, not the at-min nbg1
	});
});

describe("plan — teardown (version-agnostic drain to zero)", () => {
	it("destroys EVERY instance regardless of version and never creates (the case the naive fix misses)", () => {
		// A pool being deleted/paused with targetVersion=null and OFF-version instances. The naive
		// "set target=0" fix leaves these untouched (scale-down is gated on outdated.length===0), so
		// they orphan. The explicit teardown branch must destroy/drain all of them.
		const a = plan(
			project({ teardown: true, targetVersion: null }),
			obs([
				inst({ instanceId: "oi", runnerId: "oi", version: "1.2.3" }), // online idle
				inst({ instanceId: "ob", runnerId: "ob", version: "1.2.3", busy: true }), // online busy
				inst({ instanceId: "dr", runnerId: "dr", status: "draining", busy: false }), // draining idle
				inst({ instanceId: "bt", runnerId: null, status: "none", ageSeconds: 10 }), // booting
			]),
		);
		expect(creates(a)).toHaveLength(0); // teardown NEVER creates
		// busy online → drain (let the in-flight job finish); everything else → destroy.
		expect(drains(a).map((d) => d.type === "drain" && d.runnerId)).toEqual(["ob"]);
		expect(destroys(a).map((d) => d.type === "destroy" && d.instanceId).sort()).toEqual(
			["bt", "dr", "oi"].sort(),
		);
	});

	it("leaves a busy DRAINING instance alone until its job finishes, then destroys it", () => {
		const busyDraining = plan(
			project({ teardown: true }),
			obs([inst({ instanceId: "d1", runnerId: "d1", status: "draining", busy: true })]),
		);
		expect(busyDraining).toHaveLength(0); // busy + already draining → wait
		const idleDraining = plan(
			project({ teardown: true }),
			obs([inst({ instanceId: "d1", runnerId: "d1", status: "draining", busy: false })]),
		);
		expect(destroys(idleDraining).map((d) => d.type === "destroy" && d.instanceId)).toEqual(["d1"]);
	});

	it("is a no-op once the pool is empty (idempotent → lets reapDeletedPools remove the row)", () => {
		expect(plan(project({ teardown: true }), obs([]))).toEqual([]);
	});

	it("NEGATIVE — the naive fix: without the teardown branch, target=0 does NOT drop an off-version instance", () => {
		// warmMin/buffer 0 (target 0) and targetVersion=null with one online off-version instance.
		// This documents WHY the explicit branch is required: the scale-down path is gated behind
		// outdated.length===0 (all online on the target version), which is never true here, so the
		// planner emits NO destroy and the VM would orphan.
		const a = plan(
			project({ warmMin: 0, buffer: 0, minPerLocation: 0, targetVersion: null }),
			obs([inst({ version: "1.2.3" })], { surplusTicks: 99 }),
		);
		expect(destroys(a)).toHaveLength(0); // the leak the teardown branch fixes
	});
});

describe("plan — rollout converges with the warmMin invariant intact", () => {
	it("rolls v1→v2 across ticks, never dropping online below warmMin", () => {
		const s = project({ warmMin: 2, minPerLocation: 1, locations: ["fsn1", "nbg1"], surge: 1, buffer: 0 });
		// start: 2 online v1 (one per location)
		let instances: ObservedInstance[] = [
			inst({ instanceId: "a", runnerId: "a", version: "v1", location: "fsn1" }),
			inst({ instanceId: "b", runnerId: "b", version: "v1", location: "nbg1" }),
		];
		let idCounter = 0;
		let surplusTicks = 0;
		const target = targetCount(s, 0, 0); // 2
		for (let tick = 0; tick < 30; tick++) {
			const online = instances.filter((i) => i.status === "online");
			// INVARIANT: claimable capacity never below the warm floor
			expect(online.length).toBeGreaterThanOrEqual(s.warmMin);
			// the controller accrues surplus ticks while over target (reset otherwise)
			surplusTicks = online.length > target ? surplusTicks + 1 : 0;
			const actions = plan(s, obs(instances, { surplusTicks }));
			const settled =
				actions.length === 0 && online.length === target && online.every((i) => i.version === "v2");
			if (settled) {
				expect(online.length).toBe(target);
				expect(online.every((i) => i.version === "v2")).toBe(true);
				return;
			}
			// apply actions
			for (const act of actions) {
				if (act.type === "destroy") instances = instances.filter((i) => i.instanceId !== act.instanceId);
				else if (act.type === "drain")
					instances = instances.map((i) =>
						i.instanceId === act.instanceId ? { ...i, status: "draining" as const } : i,
					);
				else {
					const id = `new${idCounter++}`;
					instances.push(inst({ instanceId: id, runnerId: null, status: "none", ageSeconds: 0, version: act.version ?? "v2", location: act.location }));
				}
			}
			// "boot": registration-less instances become online next tick
			instances = instances.map((i) =>
				i.status === "none" ? { ...i, status: "online" as const, runnerId: i.instanceId, ageSeconds: 300 } : i,
			);
		}
		throw new Error("rollout did not converge within 30 ticks");
	});
});
