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
	type DeepHealth,
	getDeepHealth,
	httpStatusFor,
	statusProbeView,
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
	execute.mockResolvedValue([{ notify_queue_usage: 0 }]);
	delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT; // keep OTel out of the aggregate
});
afterEach(() => {
	if (savedOtel === undefined) delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
	else process.env.OTEL_EXPORTER_OTLP_ENDPOINT = savedOtel;
	delete process.env.OPENFGA_API_URL;
	delete process.env.OPENFGA_STORE_ID;
	vi.unstubAllGlobals();
});

describe("getDeepHealth — the change bus's NOTIFY queue (#6127)", () => {
	it("reports pg_notification_queue_usage() as a number on the connectivity probe", async () => {
		execute.mockResolvedValue([{ notify_queue_usage: 0.0125 }]);
		const health = await getDeepHealth();
		expect(health.db.notifyQueueUsage).toBe(0.0125);
		expect(execute).toHaveBeenCalledTimes(1); // the same round-trip, not a second query
	});

	it("reports null — not 0 — when the probe failed or answered no number", async () => {
		execute.mockResolvedValue([{}]);
		expect((await getDeepHealth()).db.notifyQueueUsage).toBeNull();
		__resetHealthCache();
		execute.mockRejectedValue(new Error("ECONNREFUSED"));
		expect((await getDeepHealth()).db.notifyQueueUsage).toBeNull();
	});
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

// The schema check (#7148). A restored-but-empty cluster answers `SELECT 1`, so connectivity alone reads
// healthy through it; the probe reads `to_regclass(<sentinel>) is not null` on the SAME round-trip, and a
// definite "the table is not there" is unhealthy. The public status page's Database row reads this.
describe("getDeepHealth — the schema check", () => {
	it("reads schema_ok off the connectivity round-trip, without a second query", async () => {
		execute.mockResolvedValue([{ notify_queue_usage: 0, schema_ok: true }]);
		const health = await getDeepHealth();
		expect(health.schema).toEqual({ ok: true });
		expect(health.status).toBe("healthy");
		expect(execute).toHaveBeenCalledTimes(1);
	});

	it("is UNHEALTHY (503) on a reachable database with no schema", async () => {
		execute.mockResolvedValue([{ notify_queue_usage: 0, schema_ok: false }]);
		const health = await getDeepHealth();
		expect(health.db.reachable).toBe(true);
		expect(health.schema).toEqual({ ok: false });
		expect(health.status).toBe("unhealthy");
		expect(httpStatusFor(health)).toBe(503);
	});

	it("an unestablished schema (DB down, or no boolean in the row) is null — never true", async () => {
		execute.mockResolvedValue([{ notify_queue_usage: 0 }]);
		expect((await getDeepHealth()).schema).toEqual({ ok: null });
		__resetHealthCache();
		execute.mockRejectedValue(new Error("ECONNREFUSED"));
		expect((await getDeepHealth()).schema).toEqual({ ok: null });
	});
});

// OpenFGA, when it is the configured engine (#7148): `GET <apiUrl>/healthz` must say SERVING. Unreachable is
// DEGRADED, not unhealthy — every instance shares the one OpenFGA server, so a 503 there would drain the
// whole fleet from the load balancer at once.
describe("getDeepHealth — OpenFGA", () => {
	/** Configure OpenFGA and answer its /healthz with `answer`. Returns the fetch spy. */
	function withOpenFga(answer: () => Promise<Response>): ReturnType<typeof vi.fn> {
		process.env.OPENFGA_API_URL = "http://openfga.internal:8080/";
		process.env.OPENFGA_STORE_ID = "store-1";
		const spy = vi.fn(answer);
		vi.stubGlobal("fetch", spy);
		return spy;
	}

	it("is not configured — and not probed — when OPENFGA_* is unset", async () => {
		const spy = vi.fn();
		vi.stubGlobal("fetch", spy);
		const health = await getDeepHealth();
		expect(health.openfga).toEqual({ configured: false, reachable: null });
		expect(spy).not.toHaveBeenCalled();
	});

	it("is reachable when /healthz answers SERVING (and the URL's trailing slash is not doubled)", async () => {
		const spy = withOpenFga(async () => Response.json({ status: "SERVING" }));
		const health = await getDeepHealth();
		expect(health.openfga).toEqual({ configured: true, reachable: true });
		expect(health.status).toBe("healthy");
		expect(spy.mock.calls[0]?.[0]).toBe("http://openfga.internal:8080/healthz");
	});

	it("is unreachable — and the aggregate DEGRADED, still 200 — when /healthz fails", async () => {
		withOpenFga(async () => {
			throw new Error("ECONNREFUSED");
		});
		const health = await getDeepHealth();
		expect(health.openfga).toMatchObject({ configured: true, reachable: false, error: "ECONNREFUSED" });
		expect(health.status).toBe("degraded");
		expect(httpStatusFor(health)).toBe(200);
	});

	it("a 200 that is not SERVING is unreachable, not up", async () => {
		withOpenFga(async () => Response.json({ status: "NOT_SERVING" }));
		expect((await getDeepHealth()).openfga.reachable).toBe(false);
	});
});

// The status-page view: what a caller holding ALETHIA_STATUS_PROBE_TOKEN receives. One boolean per
// component and nothing else — the exhaustive key check is the point.
describe("statusProbeView", () => {
	/** A deep document with the given sub-checks. */
	function doc(over: Partial<DeepHealth> = {}): DeepHealth {
		return {
			status: "healthy",
			ts: "2026-11-21T00:00:00.000Z",
			version: "test",
			db: { reachable: true, latencyMs: 3, notifyQueueUsage: 0.5 },
			schema: { ok: true },
			openfga: { configured: false, reachable: null },
			loops: [],
			otel: { configured: true, reachable: true, endpoint: "http://collector.internal:4318" },
			...over,
		};
	}

	it("carries the aggregate and three booleans — no latency, endpoint, error or loop detail", () => {
		const view = statusProbeView(doc());
		expect(view).toEqual({
			status: "healthy",
			mode: "status",
			ts: "2026-11-21T00:00:00.000Z",
			checks: { db: true, schema: true, openfga: null },
		});
		expect(JSON.stringify(view)).not.toMatch(/collector|latency|version|loops|notify/);
	});

	it("reports an unestablished schema as false — the page must not green what nobody measured", () => {
		expect(statusProbeView(doc({ schema: { ok: null } })).checks.schema).toBe(false);
	});

	it("reports OpenFGA as a boolean only when it is the configured engine", () => {
		expect(statusProbeView(doc({ openfga: { configured: true, reachable: false, error: "x" } })).checks.openfga).toBe(
			false,
		);
		expect(statusProbeView(doc({ openfga: { configured: true, reachable: true } })).checks.openfga).toBe(true);
	});
});
