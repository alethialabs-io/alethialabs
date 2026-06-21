// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { plan, targetCount } from "@/lib/fleet/plan";
import type { FleetAction, FleetSpec, Observed, ObservedInstance } from "@/lib/fleet/types";
import { describe, expect, it } from "vitest";

function spec(over: Partial<FleetSpec> = {}): FleetSpec {
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
		expect(targetCount(spec(), 0, 0)).toBe(2); // warmMin
		expect(targetCount(spec(), 5, 0)).toBe(6); // ceil(5/1)+buffer
		expect(targetCount(spec(), 0, 4)).toBe(5); // peak+buffer
		expect(targetCount(spec(), 1000, 0)).toBe(10); // max clamp
	});
});

describe("plan — count + placement", () => {
	it("cold start creates to target, one per location (minPerLocation)", () => {
		const a = plan(spec(), obs([]));
		expect(creates(a)).toHaveLength(2);
		expect(new Set(creates(a).map((c) => c.type === "create" && c.location))).toEqual(
			new Set(["fsn1", "nbg1"]),
		);
	});

	it("scales up on backlog", () => {
		const a = plan(spec(), obs([], { backlog: 5 })); // target 6
		expect(creates(a)).toHaveLength(6);
	});

	it("enforces minPerLocation even when the count target is met", () => {
		// 2 online both in fsn1 → count met (target 2) but nbg1 below min → 1 create in nbg1
		const a = plan(spec(), obs([inst({ location: "fsn1" }), inst({ location: "fsn1" })]));
		const c = creates(a);
		expect(c).toHaveLength(1);
		expect(c[0].type === "create" && c[0].location).toBe("nbg1");
	});
});

describe("plan — health", () => {
	it("reaps a dead (offline) instance and replaces it", () => {
		const a = plan(
			spec(),
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
			spec({ warmMin: 1, minPerLocation: 0, locations: ["fsn1"] }),
			obs([inst({ status: "none", runnerId: null, ageSeconds: 10 })], { bootGraceSeconds: 120 }),
		);
		expect(destroys(a)).toHaveLength(0); // still booting → leave it
	});

	it("reaps an unregistered instance past the boot grace", () => {
		const a = plan(
			spec({ warmMin: 0, minPerLocation: 0, locations: ["fsn1"], buffer: 0 }),
			obs([inst({ status: "none", runnerId: null, ageSeconds: 600 })], { bootGraceSeconds: 120 }),
		);
		expect(destroys(a)).toHaveLength(1);
	});
});

describe("plan — version rollout", () => {
	it("surges a replacement before draining when at target", () => {
		// 2 outdated online at target 2 → can't drain yet (online not > target) → surge 1 new
		const a = plan(spec(), obs([inst({ version: "v1" }), inst({ version: "v1", location: "nbg1" })]));
		expect(drains(a)).toHaveLength(0);
		const c = creates(a);
		expect(c).toHaveLength(1);
		expect(c[0].type === "create" && c[0].version).toBe("v2");
	});

	it("drains one outdated once online exceeds target", () => {
		// 2 v1 + 1 v2 online (3 > target 2) → drain one v1, no new create
		const a = plan(
			spec(),
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
			spec(),
			obs([inst(), inst({ location: "nbg1" }), inst({ status: "draining", busy: false })]),
		);
		expect(destroys(a)).toHaveLength(1);
	});

	it("never drains a busy outdated runner's slot out from under it", () => {
		// prefers the idle outdated when online > target
		const a = plan(
			spec(),
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
		expect(destroys(plan(spec(), obs(instances, { surplusTicks: 1 })))).toHaveLength(0);
		// grace elapsed → drop the surplus idle one (nbg1 has 2 > min 1)
		const a = plan(spec(), obs(instances, { surplusTicks: 3 }));
		expect(destroys(a)).toHaveLength(1);
	});

	it("never scales a location below its minimum", () => {
		// target 2, 2 online (1 per loc) but surplusTicks high → nothing to drop (each at min)
		const a = plan(spec(), obs([inst({ location: "fsn1" }), inst({ location: "nbg1" })], { surplusTicks: 9 }));
		expect(destroys(a)).toHaveLength(0);
	});
});

describe("plan — rollout converges with the warmMin invariant intact", () => {
	it("rolls v1→v2 across ticks, never dropping online below warmMin", () => {
		const s = spec({ warmMin: 2, minPerLocation: 1, locations: ["fsn1", "nbg1"], surge: 1, buffer: 0 });
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
