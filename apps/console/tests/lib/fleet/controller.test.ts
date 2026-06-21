// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { reconcilePool, type SurplusState } from "@/lib/fleet/controller";
import { FakeFleet } from "@/lib/fleet/fake-provider";
import { targetCount } from "@/lib/fleet/plan";
import type { FleetSpec } from "@/lib/fleet/types";
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
	s: FleetSpec,
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
		await drive(fake, spec());
		const online = fake.online();
		expect(online).toHaveLength(2);
		expect(new Set(online.map((i) => i.location))).toEqual(new Set(["fsn1", "nbg1"]));
		expect(online.every((i) => i.version === "v2")).toBe(true);
	});

	it("rolls v1 → v2 without ever dropping online below warmMin", async () => {
		const fake = new FakeFleet();
		fake.seed({ version: "v1", location: "fsn1" });
		fake.seed({ version: "v1", location: "nbg1" });
		await drive(fake, spec(), { assertInvariant: true });
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
		await reconcilePool(spec(), fake, fake.deps(), surplus);
		expect(fake.online()).toHaveLength(2);
		// crash one → controller reaps + replaces
		fake.crash(a);
		await drive(fake, spec());
		expect(fake.online()).toHaveLength(2);
		expect(fake.all().some((i) => i.instanceId === a)).toBe(false); // dead one reaped
	});

	it("resolves a channel to the latest version and rolls to it", async () => {
		const fake = new FakeFleet();
		fake.channelVersion = "v5";
		fake.seed({ version: "v4", location: "fsn1" });
		fake.seed({ version: "v4", location: "nbg1" });
		await drive(fake, spec({ targetVersion: null, channel: "stable" }), { assertInvariant: true });
		expect(fake.online().every((i) => i.version === "v5")).toBe(true);
	});

	it("auto-grows the warm floor to recent peak, then scales back down", async () => {
		const fake = new FakeFleet();
		fake.seed({ version: "v2", location: "fsn1" });
		fake.seed({ version: "v2", location: "nbg1" });
		fake.recentPeak = 5; // load spike → target 5 (+buffer 0)
		await drive(fake, spec({ buffer: 0 }));
		expect(fake.online().length).toBe(5);
		// spike subsides → scales back to warmMin after the grace window
		fake.recentPeak = 0;
		await drive(fake, spec({ buffer: 0 }));
		expect(fake.online().length).toBe(2);
	});
});
