// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// The /api/health route: a cheap DB-free liveness path (?shallow=1) distinct from the deep, TTL-cached
// readiness document, and the documented status scheme (503 only when the DB — a core dep — is down).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const execute = vi.fn();
vi.mock("@/lib/db", () => ({
	getServiceDb: () => ({ execute }),
}));

import { GET } from "@/app/api/health/route";
import { __resetHealthCache } from "@/lib/observability/health";
import { __resetLoopHeartbeats } from "@/lib/observability/heartbeats";

const savedOtel = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;

beforeEach(() => {
	__resetHealthCache();
	__resetLoopHeartbeats();
	execute.mockReset();
	execute.mockResolvedValue([{ "?column?": 1 }]);
	delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
});
afterEach(() => {
	if (savedOtel === undefined) delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
	else process.env.OTEL_EXPORTER_OTLP_ENDPOINT = savedOtel;
});

describe("GET /api/health", () => {
	it("?shallow=1 is liveness only — 200, NO DB round-trip", async () => {
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

	it("default is deep readiness — 200 healthy with a structured document", async () => {
		const res = await GET(new Request("http://local/api/health"));
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.status).toBe("healthy");
		expect(body.db.reachable).toBe(true);
		expect(Array.isArray(body.loops)).toBe(true);
		expect(body.otel).toEqual({ configured: false, reachable: null });
		expect(execute).toHaveBeenCalledTimes(1);
	});

	it("returns 503 when the DB is unreachable", async () => {
		execute.mockRejectedValue(new Error("down"));
		const res = await GET(new Request("http://local/api/health"));
		expect(res.status).toBe(503);
		expect((await res.json()).status).toBe("unhealthy");
	});
});
