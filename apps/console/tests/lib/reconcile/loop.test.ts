// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The supervised reconcile loop host (lib/reconcile/loop.ts). Like the recovery loop it's a
// setInterval host, so we capture the tick via a stubbed setInterval and drive it directly — asserting
// the idempotency + DB-URL guards, and that one tick fans out to each reconciler (isolated per task).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ getServiceDb: vi.fn(() => ({})) }));
vi.mock("@/lib/reconcile/converge", () => ({ convergeEnvStatuses: vi.fn(async () => ({ converged: 0, candidates: 0 })) }));
vi.mock("@/lib/reconcile/reap", () => ({ reapExpiredEphemeralEnvs: vi.fn(async () => ({ reaped: 0, expired: 0 })) }));
vi.mock("@/lib/drift/dispatch", () => ({ sweepDriftSchedule: vi.fn(async () => ({ enqueued: 0 })) }));
vi.mock("@/lib/probes/dispatch", () => ({ sweepProbeSchedule: vi.fn(async () => ({ enqueued: 0 })) }));
vi.mock("@/lib/reconcile/gc", () => ({
	gcJobLogs: vi.fn(async () => ({ deleted: 0 })),
	gcFleetActions: vi.fn(async () => ({ deleted: 0 })),
	gcAuthzActivityLog: vi.fn(async () => ({ deleted: 0 })),
}));

import {
	__resetLoopHeartbeats,
	getLoopHeartbeats,
} from "@/lib/observability/heartbeats";
import { convergeEnvStatuses } from "@/lib/reconcile/converge";
import { sweepDriftSchedule } from "@/lib/drift/dispatch";
import { sweepProbeSchedule } from "@/lib/probes/dispatch";
import { gcAuthzActivityLog, gcFleetActions, gcJobLogs } from "@/lib/reconcile/gc";
import { __resetHeartbeats, getHeartbeats } from "@/lib/reconcile/heartbeat";
import { startReconcileLoop, tick } from "@/lib/reconcile/loop";
import { reapExpiredEphemeralEnvs } from "@/lib/reconcile/reap";

const G = globalThis as unknown as { __alethiaReconcileLoop?: unknown };
const ORIGINAL_URL = process.env.ALETHIA_DATABASE_URL;

let intervalCalls: number;
beforeEach(() => {
	vi.clearAllMocks();
	__resetHeartbeats();
	__resetLoopHeartbeats();
	delete G.__alethiaReconcileLoop;
	process.env.ALETHIA_DATABASE_URL = "postgres://x";
	intervalCalls = 0;
	vi.stubGlobal("setInterval", () => {
		intervalCalls++;
		return 1 as unknown as ReturnType<typeof setInterval>;
	});
});
afterEach(() => {
	vi.unstubAllGlobals();
	if (ORIGINAL_URL === undefined) delete process.env.ALETHIA_DATABASE_URL;
	else process.env.ALETHIA_DATABASE_URL = ORIGINAL_URL;
});

describe("startReconcileLoop — guards", () => {
	it("registers exactly one interval and is idempotent across calls", () => {
		startReconcileLoop();
		startReconcileLoop();
		expect(intervalCalls).toBe(1);
	});

	it("does nothing without a database URL configured", () => {
		delete process.env.ALETHIA_DATABASE_URL;
		startReconcileLoop();
		expect(intervalCalls).toBe(0);
	});
});

describe("tick — fan-out", () => {
	it("runs every reconciler on a fresh (all-due) tick", async () => {
		await tick(new Date());
		expect(convergeEnvStatuses).toHaveBeenCalledTimes(1);
		expect(reapExpiredEphemeralEnvs).toHaveBeenCalledTimes(1);
		expect(sweepDriftSchedule).toHaveBeenCalledTimes(1);
		expect(sweepProbeSchedule).toHaveBeenCalledTimes(1);
		expect(gcJobLogs).toHaveBeenCalledTimes(1);
		expect(gcFleetActions).toHaveBeenCalledTimes(1);
		expect(gcAuthzActivityLog).toHaveBeenCalledTimes(1);
		// Each ran under a heartbeat.
		const tasks = getHeartbeats().map((h) => h.task).sort();
		expect(tasks).toEqual([
			"drift-schedule",
			"env-convergence",
			"ephemeral-reaper",
			"gc-authz-activity",
			"gc-fleet-actions",
			"gc-job-logs",
			"probe-schedule",
		]);
	});

	it("a throwing reconciler is isolated — its siblings still run", async () => {
		vi.mocked(convergeEnvStatuses).mockRejectedValueOnce(new Error("converge boom"));
		await expect(tick(new Date())).resolves.toBeUndefined();
		expect(reapExpiredEphemeralEnvs).toHaveBeenCalledTimes(1);
		expect(gcJobLogs).toHaveBeenCalledTimes(1);
		const conv = getHeartbeats().find((h) => h.task === "env-convergence");
		expect(conv?.failures).toBe(1);
		expect(conv?.lastError).toBe("converge boom");
	});

	it("gates cold reconcilers by their interval (a re-tick 90s later skips the GCs)", async () => {
		// runTask stamps lastRunAt off the real wall clock, and isDue compares the passed `now`
		// against it — so drive both off Date.now() to keep the two clocks aligned.
		await tick(new Date());
		vi.clearAllMocks();
		// 90s later: convergence + reaper (1m) are due again, but probe (2m) + drift (5m) + GC (15m) are not.
		await tick(new Date(Date.now() + 90_000));
		expect(convergeEnvStatuses).toHaveBeenCalledTimes(1);
		expect(reapExpiredEphemeralEnvs).toHaveBeenCalledTimes(1);
		expect(sweepProbeSchedule).not.toHaveBeenCalled();
		expect(sweepDriftSchedule).not.toHaveBeenCalled();
		expect(gcJobLogs).not.toHaveBeenCalled();
		expect(gcFleetActions).not.toHaveBeenCalled();
	});

	it("keeps the loop DEGRADED across not-due ticks while a cold task stays in failed state", async () => {
		// gc-job-logs (15m) fails on its due tick → it's in a FAILED STATE (last run errored).
		vi.mocked(gcJobLogs).mockRejectedValueOnce(new Error("gc boom"));
		await tick(new Date());
		let loop = getLoopHeartbeats().find((l) => l.id === "reconcile");
		expect(loop?.lastError).toContain("gc-job-logs");
		const failuresAfterFirst = loop?.failures ?? 0;
		expect(failuresAfterFirst).toBeGreaterThan(0);

		// 90s later: GC (15m) is NOT due, so it doesn't re-run — but it's still in a failed state.
		// The loop must STAY degraded (the tick re-throws off the latched failure), NOT re-stamp healthy.
		vi.clearAllMocks();
		await tick(new Date(Date.now() + 90_000));
		expect(gcJobLogs).not.toHaveBeenCalled(); // proves it's the LATCH, not a re-run failing again
		loop = getLoopHeartbeats().find((l) => l.id === "reconcile");
		expect(loop?.lastError).toContain("gc-job-logs");
		expect(loop?.failures).toBeGreaterThan(failuresAfterFirst);
	});
});
