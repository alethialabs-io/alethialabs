// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The reconcile heartbeat seam (lib/reconcile/heartbeat.ts): runTask stamps success/failure and
// ISOLATES a throw (returns undefined, records the error) so one reconciler can't abort its siblings;
// isDue gates each reconciler off its own interval on the shared heartbeat clock.

import { beforeEach, describe, expect, it } from "vitest";
import {
	__resetHeartbeats,
	getHeartbeats,
	isDue,
	runTask,
} from "@/lib/reconcile/heartbeat";

beforeEach(() => __resetHeartbeats());

describe("runTask", () => {
	it("records a success (lastSuccessAt, result) and returns the value", async () => {
		const out = await runTask("t", async () => ({ converged: 3 }));
		expect(out).toEqual({ converged: 3 });
		const [hb] = getHeartbeats();
		expect(hb.task).toBe("t");
		expect(hb.runs).toBe(1);
		expect(hb.failures).toBe(0);
		expect(hb.lastSuccessAt).not.toBeNull();
		expect(hb.lastErrorAt).toBeNull();
		expect(hb.lastResult).toEqual({ converged: 3 });
	});

	it("isolates a throw — records the error, returns undefined, does NOT propagate", async () => {
		const out = await runTask("boom", async () => {
			throw new Error("kaboom");
		});
		expect(out).toBeUndefined();
		const [hb] = getHeartbeats();
		expect(hb.runs).toBe(1);
		expect(hb.failures).toBe(1);
		expect(hb.lastError).toBe("kaboom");
		expect(hb.lastErrorAt).not.toBeNull();
		expect(hb.lastSuccessAt).toBeNull();
	});

	it("accumulates runs/failures across calls", async () => {
		await runTask("t", async () => {});
		await runTask("t", async () => {
			throw new Error("x");
		});
		await runTask("t", async () => {});
		const [hb] = getHeartbeats();
		expect(hb.runs).toBe(3);
		expect(hb.failures).toBe(1);
		// A later success does not erase the last error string (kept for forensics) but does stamp success.
		expect(hb.lastSuccessAt).not.toBeNull();
	});
});

describe("isDue", () => {
	it("is due when never run", () => {
		expect(isDue("never", 60_000)).toBe(true);
	});

	it("is not due within the interval, due after it", async () => {
		const t0 = new Date("2026-07-12T00:00:00Z");
		await runTask("gc", async () => {});
		// runTask stamps lastRunAt at ~now(); compare against controlled `now`s relative to a fresh run.
		const justAfter = new Date(Date.now() + 30_000);
		const wellAfter = new Date(Date.now() + 61_000);
		expect(isDue("gc", 60_000, justAfter)).toBe(false);
		expect(isDue("gc", 60_000, wellAfter)).toBe(true);
		void t0;
	});
});
