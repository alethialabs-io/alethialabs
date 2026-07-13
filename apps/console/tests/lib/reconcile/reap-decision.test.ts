// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Pure-logic proof for the ephemeral-reaper's bounded-retry decision (audit #10). The DB-bearing enqueue
// path is proven in tests/integration/reconcile-b2c.test.ts against real Postgres; here we prove the
// "should I re-enqueue, wait, or give up?" decision — the exact logic that used to be missing (the reaper
// re-enqueued a failing DESTROY every 60s forever) — as a pure function, no database required.

import { describe, expect, it, vi } from "vitest";

// reap.ts imports the DB/alerts/scaler graph at module load; stub them so the pure helpers import clean.
vi.mock("@/lib/db", () => ({ getServiceDb: vi.fn(() => ({})) }));
vi.mock("@/lib/alerts/emit", () => ({ emitAlertEventSafe: vi.fn() }));
vi.mock("@/lib/scaler", () => ({ notifyScaler: vi.fn() }));

import { decideReap, MAX_REAP_ATTEMPTS, reapBackoffMs } from "@/lib/reconcile/reap";

describe("reapBackoffMs — exponential backoff, capped", () => {
	it("doubles per attempt", () => {
		expect(reapBackoffMs(0)).toBe(5 * 60_000); // 5m
		expect(reapBackoffMs(1)).toBe(10 * 60_000); // 10m
		expect(reapBackoffMs(2)).toBe(20 * 60_000); // 20m
		expect(reapBackoffMs(3)).toBe(40 * 60_000); // 40m
	});

	it("clamps to the 24h cap for large attempt counts", () => {
		expect(reapBackoffMs(100)).toBe(24 * 60 * 60_000);
	});

	it("is monotonic non-decreasing", () => {
		for (let a = 0; a < 30; a++) {
			expect(reapBackoffMs(a + 1)).toBeGreaterThanOrEqual(reapBackoffMs(a));
		}
	});
});

describe("decideReap — re-enqueue vs backoff vs give-up", () => {
	const now = new Date("2026-07-12T00:00:00Z");

	it("first attempt (0 attempts, never reaped) reaps immediately — no backoff", () => {
		expect(decideReap(0, null, now)).toBe("reap");
	});

	it("backs off while the window since the last reap has not elapsed", () => {
		// One attempt charged, reaped 1 minute ago → still inside the 10m window for attempt #1.
		const lastReap = new Date(now.getTime() - 1 * 60_000);
		expect(decideReap(1, lastReap, now)).toBe("backoff");
	});

	it("re-enqueues once the backoff window has fully elapsed (retry, not give up)", () => {
		const lastReap = new Date(now.getTime() - reapBackoffMs(1) - 1_000);
		expect(decideReap(1, lastReap, now)).toBe("reap");
	});

	it("respects the exact boundary: elapsed < window backs off, elapsed >= window reaps", () => {
		const window = reapBackoffMs(2);
		const justInside = new Date(now.getTime() - (window - 1));
		const exactlyAt = new Date(now.getTime() - window);
		expect(decideReap(2, justInside, now)).toBe("backoff");
		expect(decideReap(2, exactlyAt, now)).toBe("reap");
	});

	it("gives up once the attempt cap is hit (the loop terminates, not forever)", () => {
		expect(decideReap(MAX_REAP_ATTEMPTS, new Date(now.getTime() - 1), now)).toBe("give_up");
		expect(decideReap(MAX_REAP_ATTEMPTS + 5, null, now)).toBe("give_up");
	});

	it("REGRESSION: a permanently-failing env is bounded — it reaps, then backs off, then gives up (never loops)", () => {
		// Simulate the reaper being called every 60s for a full day against an env whose DESTROY always
		// fails (settles back to FAILED, so attempts are charged but the env stays reapable). Model the
		// state the loop maintains: attempts increments on each real re-enqueue; last_reap_at = the time
		// of that re-enqueue. Assert the number of actual re-enqueues is BOUNDED by MAX_REAP_ATTEMPTS —
		// the old code (no attempts/backoff) would have produced one every tick (1440/day).
		let attempts = 0;
		let lastReapAt: Date | null = null;
		let enqueues = 0;
		let gaveUp = false;
		const start = new Date("2026-07-12T00:00:00Z");
		for (let tick = 0; tick < 24 * 60; tick++) {
			const t = new Date(start.getTime() + tick * 60_000);
			const d = decideReap(attempts, lastReapAt, t);
			if (d === "give_up") {
				gaveUp = true;
				break; // env is flagged reap_gave_up_at → excluded from the set forever after
			}
			if (d === "reap") {
				enqueues += 1;
				attempts += 1;
				lastReapAt = t;
			}
			// d === "backoff" → no work this tick (the whole point).
		}
		expect(gaveUp).toBe(true);
		expect(enqueues).toBe(MAX_REAP_ATTEMPTS);
		expect(enqueues).toBeLessThan(24 * 60); // vs the old infinite storm (one per tick)
	});
});
