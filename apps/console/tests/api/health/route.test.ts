// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// The /api/health route: a cheap DB-free liveness path (?shallow=1) that is ALWAYS public, distinct
// from the deep, TTL-cached readiness document, and the documented status scheme (503 only when the
// DB — a core dep — is down). The deep DETAIL (db latency, per-loop counters, OTel endpoint) is
// internal topology and is gated behind the platform-internal bearer (ALETHIA_CRON_SECRET); anonymous
// callers get only the sanitized aggregate so an LB readiness probe keeps working without a secret.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const execute = vi.fn();
vi.mock("@/lib/db", () => ({
	getServiceDb: () => ({ execute }),
}));

import { GET } from "@/app/api/health/route";
import { __resetHealthCache } from "@/lib/observability/health";
import { __resetLoopHeartbeats } from "@/lib/observability/heartbeats";

const savedOtel = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
const savedSecret = process.env.ALETHIA_CRON_SECRET;
const SECRET = "test-internal-secret";

/** A deep-readiness request carrying the platform-internal bearer. */
function authedDeep(): Request {
	return new Request("http://local/api/health", {
		headers: { authorization: `Bearer ${SECRET}` },
	});
}

beforeEach(() => {
	__resetHealthCache();
	__resetLoopHeartbeats();
	execute.mockReset();
	execute.mockResolvedValue([{ "?column?": 1 }]);
	delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
	process.env.ALETHIA_CRON_SECRET = SECRET;
});
afterEach(() => {
	if (savedOtel === undefined) delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
	else process.env.OTEL_EXPORTER_OTLP_ENDPOINT = savedOtel;
	if (savedSecret === undefined) delete process.env.ALETHIA_CRON_SECRET;
	else process.env.ALETHIA_CRON_SECRET = savedSecret;
});

describe("GET /api/health — liveness (always public)", () => {
	it("?shallow=1 is liveness only — 200, NO DB round-trip, no secret needed", async () => {
		const res = await GET(new Request("http://local/api/health?shallow=1"));
		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({ status: "ok", mode: "live" });
		expect(execute).not.toHaveBeenCalled();
	});

	it("?probe=live is the same DB-free liveness alias", async () => {
		const res = await GET(new Request("http://local/api/health?probe=live"));
		expect(res.status).toBe(200);
		expect(execute).not.toHaveBeenCalled();
	});
});

describe("GET /api/health — deep detail requires the internal bearer", () => {
	it("with the bearer: returns the FULL deep document (db/loops/otel detail)", async () => {
		const res = await GET(authedDeep());
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.status).toBe("healthy");
		expect(body.db.reachable).toBe(true);
		expect(Array.isArray(body.loops)).toBe(true);
		expect(body.otel).toEqual({ configured: false, reachable: null });
		expect(execute).toHaveBeenCalledTimes(1);
	});

	it("anonymous: sanitized aggregate only — 200 + status, but NO db/loops/otel topology leak", async () => {
		const res = await GET(new Request("http://local/api/health"));
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body).toEqual({ status: "healthy", mode: "readiness", ts: expect.any(String) });
		// The internal detail must NOT be present for an unauthenticated caller.
		expect(body.db).toBeUndefined();
		expect(body.loops).toBeUndefined();
		expect(body.otel).toBeUndefined();
		expect(body.version).toBeUndefined();
	});

	it("wrong bearer: still only the sanitized aggregate (no leak)", async () => {
		const res = await GET(
			new Request("http://local/api/health", {
				headers: { authorization: "Bearer not-the-secret" },
			}),
		);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.loops).toBeUndefined();
		expect(body.db).toBeUndefined();
	});

	it("fail-closed: with the secret UNSET, even a 'Bearer ' request gets only the aggregate", async () => {
		delete process.env.ALETHIA_CRON_SECRET;
		const res = await GET(
			new Request("http://local/api/health", {
				headers: { authorization: "Bearer " },
			}),
		);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body).toEqual({ status: "healthy", mode: "readiness", ts: expect.any(String) });
		expect(body.loops).toBeUndefined();
	});
});

describe("GET /api/health — status scheme", () => {
	it("anonymous: 503 when the DB is unreachable, still no detail leaked", async () => {
		execute.mockRejectedValue(new Error("down"));
		const res = await GET(new Request("http://local/api/health"));
		expect(res.status).toBe(503);
		const body = await res.json();
		expect(body.status).toBe("unhealthy");
		// Even the failing-DB error string is internal detail — not exposed to anonymous callers.
		expect(body.db).toBeUndefined();
	});

	it("with the bearer: 503 when the DB is unreachable, full detail present", async () => {
		execute.mockRejectedValue(new Error("down"));
		const res = await GET(authedDeep());
		expect(res.status).toBe(503);
		const body = await res.json();
		expect(body.status).toBe("unhealthy");
		expect(body.db.reachable).toBe(false);
	});
});

// ── which build is answering (#2812) ────────────────────────────────────────────────────────
//
// A sandbox env runs the dev server and `.next` is excluded from the rsync, so the box keeps its
// own compile cache across pushes. A stale cache serves the PREVIOUS module while `env:push` and
// `env:up` both report success — an aria-label fix once sat invisible across two restarts, and a
// visual pass can confirm something that is not on the page.
//
// The id rides on the LIVENESS response on purpose: that path is always public and never touches
// the database, so `pnpm env:verify` can ask "is this my tree?" without a credential and without
// costing a query. It must stay out of the deep document, which is bearer-gated.
describe("GET /api/health — build identity", () => {
	const saved = process.env.NEXT_PUBLIC_ALETHIA_BUILD_ID;
	afterEach(() => {
		if (saved === undefined) delete process.env.NEXT_PUBLIC_ALETHIA_BUILD_ID;
		else process.env.NEXT_PUBLIC_ALETHIA_BUILD_ID = saved;
	});

	it("liveness reports the build it was compiled with", async () => {
		process.env.NEXT_PUBLIC_ALETHIA_BUILD_ID = "tree-abc123";
		const res = await GET(new Request("http://local/api/health?shallow=1"));
		expect(await res.json()).toMatchObject({ status: "ok", mode: "live", build: "tree-abc123" });
	});

	it("...on the ?probe=live alias too", async () => {
		process.env.NEXT_PUBLIC_ALETHIA_BUILD_ID = "tree-abc123";
		const res = await GET(new Request("http://local/api/health?probe=live"));
		expect((await res.json()).build).toBe("tree-abc123");
	});

	// NULL, not "unknown". A production image and a local run carry no boot id, and inventing a
	// placeholder would let `env:verify` compare two fabrications and call them equal — the same
	// absence-as-measurement collapse that made proof bundles unfalsifiable in #2688.
	it("is null when no build id was compiled in, never a placeholder", async () => {
		delete process.env.NEXT_PUBLIC_ALETHIA_BUILD_ID;
		const body = await (await GET(new Request("http://local/api/health?shallow=1"))).json();
		expect(body.build).toBeNull();
		expect(body).toMatchObject({ status: "ok", mode: "live" });
	});

	// The liveness path must stay free of the topology detail the deep path gates behind a bearer.
	it("adding it did not widen the liveness payload", async () => {
		process.env.NEXT_PUBLIC_ALETHIA_BUILD_ID = "tree-abc123";
		const body = await (await GET(new Request("http://local/api/health?shallow=1"))).json();
		expect(Object.keys(body).sort()).toEqual(["build", "mode", "status", "ts"]);
	});
});
