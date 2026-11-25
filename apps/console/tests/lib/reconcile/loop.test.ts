// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The supervised reconcile loop host (lib/reconcile/loop.ts). Like the recovery loop it's a
// setInterval host, so we capture the tick via a stubbed setInterval and drive it directly — asserting
// the idempotency + DB-URL guards, and that one tick fans out to each reconciler (isolated per task).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ getServiceDb: vi.fn(() => ({})) }));
vi.mock("@/lib/billing/factura/sweeper", () => ({
	runFacturaSweep: vi.fn(async () => ({ retried: 0, issued: 0, alerted: 0, pdfsRendered: 0, failures: 0 })),
}));
vi.mock("@/lib/billing/paddle/overage-sweeper", () => ({
	paddleOverageSweepEnabled: vi.fn(() => false),
	runPaddleOverageSweep: vi.fn(async () => ({
		postedCharges: 0,
		reconciledCharges: 0,
		waivedCharges: 0,
		failedCharges: 0,
		unconfirmedCharges: 0,
		skippedSubscriptions: 0,
	})),
}));
vi.mock("@/lib/reconcile/converge", () => ({ convergeEnvStatuses: vi.fn(async () => ({ converged: 0, candidates: 0 })) }));
vi.mock("@/lib/reconcile/reap", () => ({ reapExpiredEphemeralEnvs: vi.fn(async () => ({ reaped: 0, expired: 0 })) }));
vi.mock("@/lib/drift/dispatch", () => ({ sweepDriftSchedule: vi.fn(async () => ({ enqueued: 0 })) }));
vi.mock("@/lib/probes/dispatch", () => ({ sweepProbeSchedule: vi.fn(async () => ({ enqueued: 0 })) }));
vi.mock("@/lib/reconcile/ai-holds", () => ({ releaseStrandedAiHolds: vi.fn(async () => ({ released: 0 })) }));
vi.mock("@/lib/kubeconfig-mint/sweep", () => ({
	sweepExpiredKubeconfigMints: vi.fn(async () => ({ expired: 0, cancelledJobs: 0, deleted: 0 })),
}));
vi.mock("@/lib/rate-limit", () => ({
	sweepExpiredRateLimitBuckets: vi.fn(async () => ({ deleted: 0 })),
}));
vi.mock("@/lib/elench/drafts-sweep", () => ({
	sweepElenchDrafts: vi.fn(async () => ({ settled: 0, settleFailed: 0, discardedDeleted: 0, staleDeleted: 0 })),
}));
vi.mock("@/lib/reconcile/state-locks", () => ({
	releaseCancelledStateLocks: vi.fn(async () => ({ jobs: 0, released: 0 })),
}));
vi.mock("@/lib/reconcile/gc", () => ({
	gcJobLogs: vi.fn(async () => ({ deleted: 0 })),
	gcFleetActions: vi.fn(async () => ({ deleted: 0 })),
	gcAuthzActivityLog: vi.fn(async () => ({ deleted: 0 })),
	gcSupportCases: vi.fn(async () => ({ deleted: 0, filesDeleted: 0, storageFailed: 0 })),
}));

import {
	__resetLoopHeartbeats,
	getLoopHeartbeats,
} from "@/lib/observability/heartbeats";
import { convergeEnvStatuses } from "@/lib/reconcile/converge";
import { sweepDriftSchedule } from "@/lib/drift/dispatch";
import { runFacturaSweep } from "@/lib/billing/factura/sweeper";
import { paddleOverageSweepEnabled, runPaddleOverageSweep } from "@/lib/billing/paddle/overage-sweeper";
import { sweepElenchDrafts } from "@/lib/elench/drafts-sweep";
import { sweepExpiredKubeconfigMints } from "@/lib/kubeconfig-mint/sweep";
import { sweepProbeSchedule } from "@/lib/probes/dispatch";
import { sweepExpiredRateLimitBuckets } from "@/lib/rate-limit";
import { releaseStrandedAiHolds } from "@/lib/reconcile/ai-holds";
import { gcAuthzActivityLog, gcFleetActions, gcJobLogs } from "@/lib/reconcile/gc";
import { __resetHeartbeats, getHeartbeats } from "@/lib/reconcile/heartbeat";
import { startReconcileLoop, tick } from "@/lib/reconcile/loop";
import { reapExpiredEphemeralEnvs } from "@/lib/reconcile/reap";
import { releaseCancelledStateLocks } from "@/lib/reconcile/state-locks";

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

describe("tick — the фактура sweep (#7369)", () => {
	const ORIGINAL_KEY = process.env.STRIPE_SECRET_KEY;
	afterEach(() => {
		if (ORIGINAL_KEY === undefined) delete process.env.STRIPE_SECRET_KEY;
		else process.env.STRIPE_SECRET_KEY = ORIGINAL_KEY;
	});

	it("never runs on a console without Stripe configured", async () => {
		delete process.env.STRIPE_SECRET_KEY;
		await tick(new Date());
		expect(runFacturaSweep).not.toHaveBeenCalled();
		expect(getHeartbeats().map((h) => h.task)).not.toContain("factura-sweep");
	});

	it("runs under its own heartbeat when Stripe is configured, then waits an hour", async () => {
		process.env.STRIPE_SECRET_KEY = "sk_test_loop";
		// `runTask` stamps lastRunAt from the wall clock, so the ticks are offsets from now.
		const t0 = new Date();
		await tick(t0);
		expect(runFacturaSweep).toHaveBeenCalledTimes(1);
		expect(runFacturaSweep).toHaveBeenCalledWith(t0);
		expect(getHeartbeats().map((h) => h.task)).toContain("factura-sweep");

		vi.mocked(runFacturaSweep).mockClear();
		await tick(new Date(t0.getTime() + 30 * 60_000));
		expect(runFacturaSweep).not.toHaveBeenCalled();
		await tick(new Date(t0.getTime() + 61 * 60_000));
		expect(runFacturaSweep).toHaveBeenCalledTimes(1);
	});
});

describe("tick — the Paddle overage sweep (L5)", () => {
	it("never runs while the flag is off", async () => {
		vi.mocked(paddleOverageSweepEnabled).mockReturnValue(false);
		await tick(new Date());
		expect(runPaddleOverageSweep).not.toHaveBeenCalled();
		expect(getHeartbeats().map((h) => h.task)).not.toContain("paddle-overage-sweep");
	});

	it("runs under its own heartbeat when enabled, then waits 15 minutes", async () => {
		vi.mocked(paddleOverageSweepEnabled).mockReturnValue(true);
		const t0 = new Date();
		await tick(t0);
		expect(runPaddleOverageSweep).toHaveBeenCalledWith(t0);
		expect(getHeartbeats().map((h) => h.task)).toContain("paddle-overage-sweep");
		vi.mocked(runPaddleOverageSweep).mockClear();
		await tick(new Date(t0.getTime() + 10 * 60_000));
		expect(runPaddleOverageSweep).not.toHaveBeenCalled();
		await tick(new Date(t0.getTime() + 16 * 60_000));
		expect(runPaddleOverageSweep).toHaveBeenCalledTimes(1);
		vi.mocked(paddleOverageSweepEnabled).mockReturnValue(false);
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
		expect(releaseStrandedAiHolds).toHaveBeenCalledTimes(1);
		expect(sweepExpiredKubeconfigMints).toHaveBeenCalledTimes(1);
		expect(sweepExpiredRateLimitBuckets).toHaveBeenCalledTimes(1);
		expect(sweepElenchDrafts).toHaveBeenCalledTimes(1);
		expect(releaseCancelledStateLocks).toHaveBeenCalledTimes(1);
		// Each ran under a heartbeat.
		const tasks = getHeartbeats().map((h) => h.task).sort();
		expect(tasks).toEqual([
			"drift-schedule",
			"elench-drafts-sweep",
			"env-convergence",
			"ephemeral-reaper",
			"gc-authz-activity",
			"gc-fleet-actions",
			"gc-job-logs",
			"gc-support-cases",
			"kubeconfig-mint-sweep",
			"probe-schedule",
			"rate-limit-sweep",
			"release-ai-holds",
			"release-cancelled-state-locks",
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
		// The mint sweep is hot (1m) too: an uncollected ciphertext must not outlive its window by more.
		expect(sweepExpiredKubeconfigMints).toHaveBeenCalledTimes(1);
		// So is the cancelled-lock release (1m): its gap is added to the drain window a DESTROY waits.
		expect(releaseCancelledStateLocks).toHaveBeenCalledTimes(1);
		expect(sweepProbeSchedule).not.toHaveBeenCalled();
		expect(sweepDriftSchedule).not.toHaveBeenCalled();
		// The rate-limit sweep (5m) only bounds dead rows, so it is not hot.
		expect(sweepExpiredRateLimitBuckets).not.toHaveBeenCalled();
		expect(gcJobLogs).not.toHaveBeenCalled();
		expect(gcFleetActions).not.toHaveBeenCalled();
		// Draft retention is counted in days: the sweep is daily.
		expect(sweepElenchDrafts).not.toHaveBeenCalled();
	});

	it("runs the drafts sweep again only once a day has passed", async () => {
		await tick(new Date());
		vi.clearAllMocks();
		await tick(new Date(Date.now() + 23 * 60 * 60_000));
		expect(sweepElenchDrafts).not.toHaveBeenCalled();
		await tick(new Date(Date.now() + 24 * 60 * 60_000 + 1_000));
		expect(sweepElenchDrafts).toHaveBeenCalledTimes(1);
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
