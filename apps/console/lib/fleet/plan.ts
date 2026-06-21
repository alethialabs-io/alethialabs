// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The Fleet Controller's brain: a PURE function that diffs a pool spec against observed
// reality and returns the minimal, safe set of actions to advance toward it (spec/mvp/26).
// Reconciles four axes in priority order — health → count → placement → version — under
// one hard invariant: never plan the claimable (online) count below the warm floor.
// Convergent: each call advances rollout/heal/rebalance one safe step; idempotent.

import type { FleetAction, FleetSpec, Observed, ObservedInstance } from "@/lib/fleet/types";

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/** The healthy-instance count we want right now: warm floor, lifted by demand + N+1 buffer. */
export function targetCount(spec: FleetSpec, backlog: number, recentPeak: number): number {
	const slots = Math.max(1, spec.slotsPerRunner);
	const demand = Math.max(recentPeak, Math.ceil(Math.max(0, backlog) / slots));
	return clamp(Math.max(spec.warmMin, demand + spec.buffer), 0, spec.max);
}

type Bucket = "online" | "draining" | "booting" | "dead";

function classify(i: ObservedInstance, bootGraceSeconds: number): Bucket {
	if (i.status === "online") return "online";
	if (i.status === "draining") return "draining";
	// Unregistered + young = still booting (don't kill); offline, or never-registered past
	// the boot grace = dead.
	if (i.status === "none" && i.ageSeconds <= bootGraceSeconds) return "booting";
	return "dead";
}

/**
 * Plan the next reconcile step for a pool. Returns create/drain/destroy actions; the
 * controller applies them idempotently. Pure — no I/O, deterministic.
 */
export function plan(spec: FleetSpec, o: Observed): FleetAction[] {
	const actions: FleetAction[] = [];
	const target = targetCount(spec, o.backlog, o.recentPeak);
	const maxInstances = spec.max + spec.surge;

	const online: ObservedInstance[] = [];
	const draining: ObservedInstance[] = [];
	const booting: ObservedInstance[] = [];
	for (const i of o.instances) {
		const b = classify(i, o.bootGraceSeconds);
		if (b === "online") online.push(i);
		else if (b === "draining") draining.push(i);
		else if (b === "booting") booting.push(i);
		else actions.push({ type: "destroy", instanceId: i.instanceId }); // dead → reap
	}

	// Drained instances whose job has finished → reap (their replacement was already created).
	for (const d of draining) {
		if (!d.busy) actions.push({ type: "destroy", instanceId: d.instanceId });
	}

	// "Live" = capacity that counts toward target (online + booting); draining is leaving.
	const liveByLoc = new Map<string, number>();
	for (const i of [...online, ...booting]) {
		liveByLoc.set(i.location, (liveByLoc.get(i.location) ?? 0) + 1);
	}
	let live = online.length + booting.length;

	/** Pick a location: fill below-min ones first, then least-loaded. */
	function pickLocation(): string {
		for (const loc of spec.locations) {
			if ((liveByLoc.get(loc) ?? 0) < spec.minPerLocation) return loc;
		}
		let best = spec.locations[0] ?? "";
		let bestN = Number.POSITIVE_INFINITY;
		for (const loc of spec.locations) {
			const n = liveByLoc.get(loc) ?? 0;
			if (n < bestN) {
				bestN = n;
				best = loc;
			}
		}
		return best;
	}
	function create(version: string | null): boolean {
		if (live >= maxInstances) return false;
		const loc = pickLocation();
		actions.push({ type: "create", location: loc, version });
		liveByLoc.set(loc, (liveByLoc.get(loc) ?? 0) + 1);
		live += 1;
		return true;
	}

	// Count + placement: bring live up to target (placement-aware), then satisfy any
	// remaining per-location minimums. New capacity is always created at the target version.
	while (live < target) if (!create(spec.targetVersion)) break;
	for (const loc of spec.locations) {
		while ((liveByLoc.get(loc) ?? 0) < spec.minPerLocation && live < maxInstances) {
			actions.push({ type: "create", location: loc, version: spec.targetVersion });
			liveByLoc.set(loc, (liveByLoc.get(loc) ?? 0) + 1);
			live += 1;
		}
	}

	// Version rollout — immutable drain-replace, one step per tick. Surge a replacement
	// up FIRST, then drain an outdated only while online > target (so draining never drops
	// online below the floor). Converges over ticks.
	const outdated = online.filter((h) => h.version !== spec.targetVersion);
	if (spec.targetVersion !== null && outdated.length > 0) {
		if (online.length > target) {
			const victim = outdated.find((h) => !h.busy) ?? outdated[0];
			if (victim.runnerId) {
				actions.push({ type: "drain", runnerId: victim.runnerId, instanceId: victim.instanceId });
			}
		} else if (live < target + spec.surge) {
			create(spec.targetVersion); // surge a replacement up; drain it in next tick
		}
	}

	// Idle surplus scale-down — only once the rollout has settled (no outdated online),
	// after the grace window, idle online beyond target, never below a location minimum.
	if (outdated.length === 0 && o.surplusTicks >= spec.scaleDownGraceTicks) {
		let over = live - target;
		const idle = online
			.filter((h) => !h.busy)
			// up-to-date duplicates are the safest to drop; prefer over-min locations
			.sort((a, b) => (liveByLoc.get(b.location) ?? 0) - (liveByLoc.get(a.location) ?? 0));
		for (const h of idle) {
			if (over <= 0) break;
			if ((liveByLoc.get(h.location) ?? 0) <= spec.minPerLocation) continue;
			actions.push({ type: "destroy", instanceId: h.instanceId });
			liveByLoc.set(h.location, (liveByLoc.get(h.location) ?? 0) - 1);
			live -= 1;
			over -= 1;
		}
	}

	return actions;
}
