// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { computeDesired, type PoolConfig } from "@/lib/fleet/compute-desired";
import { describe, expect, it } from "vitest";

const cfg: PoolConfig = {
	warmMin: 1,
	max: 5,
	slotsPerRunner: 2,
	scaleDownGraceTicks: 3,
};

describe("computeDesired", () => {
	it("holds the warm floor when the queue is empty", () => {
		const r = computeDesired(0, 1, cfg, 0);
		expect(r.desired).toBe(1); // warmMin
	});

	it("never reports below warmMin even from a cold start", () => {
		const r = computeDesired(0, 0, cfg, 0);
		expect(r.desired).toBe(1); // scale up to the floor
	});

	it("scales up immediately by backlog / slots above the floor", () => {
		// warmMin 1 + ceil(5/2)=3 → 4
		const r = computeDesired(5, 1, cfg, 0);
		expect(r.desired).toBe(4);
		expect(r.idleTicks).toBe(0);
	});

	it("clamps to max", () => {
		const r = computeDesired(100, 1, cfg, 0);
		expect(r.desired).toBe(5); // max
	});

	it("does NOT scale down until the idle grace elapses", () => {
		// target 1 (empty) < current 4 → hold, accrue idle
		const t1 = computeDesired(0, 4, cfg, 0);
		expect(t1).toEqual({ desired: 4, idleTicks: 1 });
		const t2 = computeDesired(0, 4, cfg, t1.idleTicks);
		expect(t2).toEqual({ desired: 4, idleTicks: 2 });
		const t3 = computeDesired(0, 4, cfg, t2.idleTicks);
		expect(t3).toEqual({ desired: 1, idleTicks: 0 }); // grace (3) reached → scale down
	});

	it("resets the idle counter when work reappears mid-grace", () => {
		const t1 = computeDesired(0, 4, cfg, 0); // idle 1
		const t2 = computeDesired(6, 4, cfg, t1.idleTicks); // backlog → scale up, reset
		expect(t2.idleTicks).toBe(0);
		expect(t2.desired).toBe(4); // warmMin 1 + ceil(6/2)=3 = 4
	});

	it("is steady when target equals current", () => {
		const r = computeDesired(2, 2, cfg, 0); // warmMin 1 + ceil(2/2)=1 = 2
		expect(r).toEqual({ desired: 2, idleTicks: 0 });
	});
});
