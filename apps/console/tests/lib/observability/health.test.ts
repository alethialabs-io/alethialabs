// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// The deep readiness model (lib/observability/health.ts): aggregate status rolls DB + loop liveness,
// the TTL cache serves a probe storm from one compute (no DB re-hit per request), and a DB-down probe
// degrades gracefully to `unhealthy`/503 rather than throwing a 500.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const execute = vi.fn();
vi.mock("@/lib/db", () => ({
	getServiceDb: () => ({ execute }),
}));

import {
	__resetHealthCache,
	getDeepHealth,
	httpStatusFor,
} from "@/lib/observability/health";
import {
	__resetLoopHeartbeats,
	registerLoop,
	superviseLoop,
} from "@/lib/observability/heartbeats";

const savedOtel = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;

beforeEach(() => {
	__resetHealthCache();
	__resetLoopHeartbeats();
	execute.mockReset();
	execute.mockResolvedValue([{ "?column?": 1 }]);
	delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT; // keep OTel out of the aggregate
});
afterEach(() => {
	if (savedOtel === undefined) delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
	else process.env.OTEL_EXPORTER_OTLP_ENDPOINT = savedOtel;
});

describe("getDeepHealth — aggregation", () => {
	it("is healthy (200) when DB is reachable and every loop is ok", async () => {
		registerLoop("job-recovery", { intervalMs: 60_000 });
		await superviseLoop("job-recovery", async () => {});
		__resetHealthCache();

		const health = await getDeepHealth();
		expect(health.status).toBe("healthy");
		expect(health.db.reachable).toBe(true);
		expect(health.otel).toEqual({ configured: false, reachable: null });
		expect(httpStatusFor(health)).toBe(200);
	});

	it("is degraded (200 default, 503 strict) when a background loop is stuck", async () => {
		registerLoop("reconcile", { intervalMs: 60_000 });
		await superviseLoop("reconcile", async () => {});

		// Probe far enough in the future that the loop has missed > 3× its interval.
		const future = new Date(Date.now() + 10 * 60_000);
		const health = await getDeepHealth(future);
		expect(health.status).toBe("degraded");
		expect(health.db.reachable).toBe(true);
		const reconcile = health.loops.find((l) => l.id === "reconcile");
		expect(reconcile?.status).toBe("degraded");
		// A degraded background loop keeps serving (200) — unless the monitor asks for strict.
		expect(httpStatusFor(health)).toBe(200);
		expect(httpStatusFor(health, true)).toBe(503);
	});

	it("is unhealthy (503) when the DB is unreachable — degrades gracefully, no throw", async () => {
		execute.mockRejectedValue(new Error("ECONNREFUSED"));
		const health = await getDeepHealth();
		expect(health.status).toBe("unhealthy");
		expect(health.db.reachable).toBe(false);
		expect(health.db.error).toContain("ECONNREFUSED");
		expect(httpStatusFor(health)).toBe(503);
	});

	it("attaches the reconcile loop's per-reconciler sub-tasks as detail", async () => {
		registerLoop("reconcile", { intervalMs: 60_000 });
		await superviseLoop("reconcile", async () => {});
		const health = await getDeepHealth();
		const reconcile = health.loops.find((l) => l.id === "reconcile");
		expect(reconcile?.tasks).toBeDefined(); // present (empty until the reconcilers run) for the dashboard
	});
});

describe("getDeepHealth — TTL cache (no probe-storm DB load)", () => {
	it("computes once within the window and serves the cached document", async () => {
		const a = await getDeepHealth();
		const b = await getDeepHealth();
		const c = await getDeepHealth();
		expect(execute).toHaveBeenCalledTimes(1); // one DB round-trip for three probes
		expect(b).toBe(a); // same cached object reference
		expect(c).toBe(a);
	});

	it("coalesces concurrent probes during a recompute into one compute", async () => {
		const [a, b] = await Promise.all([getDeepHealth(), getDeepHealth()]);
		expect(execute).toHaveBeenCalledTimes(1);
		expect(b).toBe(a);
	});
});
