// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The general loop-supervision registry (lib/observability/heartbeats.ts): superviseLoop stamps
// success/failure + ISOLATES a throw (a setInterval host must never get an unhandled rejection);
// livenessOf is interval-aware (DEGRADED after N× the loop's own interval without a success); and
// evaluateHeartbeatAlerts raises exactly ONE throttled alert per degraded episode.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const emitAlertEventSafe = vi.fn();
vi.mock("@/lib/alerts/emit", () => ({
	emitAlertEventSafe: (...args: unknown[]) => emitAlertEventSafe(...args),
}));

import {
	__resetLoopHeartbeats,
	evaluateHeartbeatAlerts,
	getLoopHeartbeats,
	livenessOf,
	registerLoop,
	superviseLoop,
} from "@/lib/observability/heartbeats";

const ORG_ENV = "ALETHIA_PLATFORM_ALERT_ORG_ID";
const savedOrg = process.env[ORG_ENV];

beforeEach(() => {
	__resetLoopHeartbeats();
	emitAlertEventSafe.mockReset();
	process.env[ORG_ENV] = "org-ops";
});
afterEach(() => {
	if (savedOrg === undefined) delete process.env[ORG_ENV];
	else process.env[ORG_ENV] = savedOrg;
});

describe("superviseLoop", () => {
	it("records a success (lastSuccessAt, counts) and returns the value", async () => {
		registerLoop("l", { intervalMs: 60_000 });
		const out = await superviseLoop("l", async () => ({ checked: 4 }));
		expect(out).toEqual({ checked: 4 });
		const [hb] = getLoopHeartbeats();
		expect(hb.runs).toBe(1);
		expect(hb.failures).toBe(0);
		expect(hb.lastSuccessAt).not.toBeNull();
		expect(hb.lastErrorAt).toBeNull();
		expect(hb.lastResult).toEqual({ checked: 4 });
	});

	it("captures a numeric return but stores no non-numeric result object", async () => {
		const n = await superviseLoop("num", async () => 7);
		expect(n).toBe(7);
		const [hb] = getLoopHeartbeats();
		expect(hb.lastResult).toBeNull(); // a bare number is not a counts object
	});

	it("isolates a throw — records the error, returns undefined, does NOT propagate", async () => {
		registerLoop("boom", { intervalMs: 60_000 });
		const out = await superviseLoop("boom", async () => {
			throw new Error("kaboom");
		});
		expect(out).toBeUndefined();
		const [hb] = getLoopHeartbeats();
		expect(hb.failures).toBe(1);
		expect(hb.lastError).toBe("kaboom");
		expect(hb.lastSuccessAt).toBeNull();
	});

	it("auto-registers a loop supervised before it registered (60s default)", async () => {
		await superviseLoop("implicit", async () => {});
		const [hb] = getLoopHeartbeats();
		expect(hb.intervalMs).toBe(60_000);
	});
});

describe("livenessOf — interval-aware", () => {
	it("is `starting` before the first run and `ok` right after a success", async () => {
		registerLoop("l", { intervalMs: 60_000 });
		const before = getLoopHeartbeats()[0];
		expect(livenessOf(before)).toBe("starting");
		await superviseLoop("l", async () => {});
		expect(livenessOf(getLoopHeartbeats()[0])).toBe("ok");
	});

	it("a loop that stops stamping goes DEGRADED after N× its interval", async () => {
		registerLoop("stuck", { intervalMs: 60_000 }); // threshold = 3×60s = 180s
		await superviseLoop("stuck", async () => {});
		const hb = getLoopHeartbeats()[0];
		const t0 = new Date(hb.lastSuccessAt as string).getTime();
		expect(livenessOf(hb, new Date(t0 + 179_000))).toBe("ok"); // still within window
		expect(livenessOf(hb, new Date(t0 + 181_000))).toBe("degraded"); // stopped succeeding
	});

	it("respects a longer interval (a 15m loop's window is 45m, not 3m)", () => {
		registerLoop("cold", { intervalMs: 15 * 60_000 }); // threshold = 45m
		const hb = getLoopHeartbeats()[0];
		const t0 = new Date(hb.createdAt).getTime();
		expect(livenessOf(hb, new Date(t0 + 40 * 60_000))).toBe("starting"); // never ran, still fresh
		expect(livenessOf(hb, new Date(t0 + 50 * 60_000))).toBe("degraded");
	});
});

describe("evaluateHeartbeatAlerts — one throttled alert per episode", () => {
	/** Drive `id` degraded, evaluate at `at`. */
	function degradedNow(id: string): Date {
		const hb = getLoopHeartbeats().find((h) => h.id === id);
		if (!hb) throw new Error("no hb");
		const anchor = hb.lastSuccessAt ?? hb.createdAt;
		return new Date(new Date(anchor).getTime() + 181_000);
	}

	it("emits exactly one degraded alert per episode, then one recovered alert", async () => {
		registerLoop("job-recovery", { intervalMs: 60_000 });
		await superviseLoop("job-recovery", async () => {});

		const whenDegraded = degradedNow("job-recovery");
		evaluateHeartbeatAlerts(whenDegraded);
		evaluateHeartbeatAlerts(whenDegraded); // still degraded — must NOT re-alert
		expect(emitAlertEventSafe).toHaveBeenCalledTimes(1);
		expect(emitAlertEventSafe.mock.calls[0][1]).toBe("system.platform.loop_degraded");
		expect(emitAlertEventSafe.mock.calls[0][2]).toMatchObject({ resource_id: "job-recovery" });

		// Recover: a fresh success, then evaluate at ~now → exactly one recovered alert, latch cleared.
		await superviseLoop("job-recovery", async () => {});
		emitAlertEventSafe.mockClear();
		evaluateHeartbeatAlerts(new Date());
		evaluateHeartbeatAlerts(new Date());
		expect(emitAlertEventSafe).toHaveBeenCalledTimes(1);
		expect(emitAlertEventSafe.mock.calls[0][1]).toBe("system.platform.loop_recovered");

		// A NEW degraded episode alerts again.
		emitAlertEventSafe.mockClear();
		evaluateHeartbeatAlerts(degradedNow("job-recovery"));
		expect(emitAlertEventSafe).toHaveBeenCalledTimes(1);
		expect(emitAlertEventSafe.mock.calls[0][1]).toBe("system.platform.loop_degraded");
	});

	it("does NOT emit when no operator org is configured (still process-local visible)", async () => {
		delete process.env[ORG_ENV];
		registerLoop("fleet-scaler", { intervalMs: 60_000 });
		await superviseLoop("fleet-scaler", async () => {});
		evaluateHeartbeatAlerts(degradedNow("fleet-scaler"));
		expect(emitAlertEventSafe).not.toHaveBeenCalled();
		// …but the degradation is still observable in the registry for /health.
		expect(livenessOf(getLoopHeartbeats()[0], degradedNow("fleet-scaler"))).toBe("degraded");
	});
});
