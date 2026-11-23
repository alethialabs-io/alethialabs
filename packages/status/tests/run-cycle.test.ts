// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it, vi } from "vitest";
import { COMPONENTS } from "../src/probes";
import { parseSnapshot, runCycle, SNAPSHOT_KEY, type Env } from "../src/worker";
import { FakeD1, FakeKV } from "./helpers/fake-bindings";

/**
 * `runCycle` executed against a REAL SQLite that starts EMPTY, so the Worker's self-applied schema
 * is what every statement runs against. This is deliberately an integration test of the cycle: the
 * parts have their own tests, and the gap was that nothing put them together against a database.
 */

afterEach(() => {
	vi.unstubAllGlobals();
});

const TOKEN = "probe-token-for-tests";

/** The console's answer to the probe credential, in a given state. */
function consoleBody(status: string, db = true, schema = true, openfga: boolean | null = null): string {
	return JSON.stringify({ status, mode: "status", ts: "x", checks: { db, schema, openfga } });
}

/** The head of apps/console/public/install.sh — enough to carry the installer markers. */
const INSTALL_SH = '#!/bin/sh\n# Alethia CLI installer (macOS / Linux).\nmain() {\n\tREPO="alethialabs-io/alethia-cli"\n}\nmain "$@"\n';

/** The URL string of a fetch input. */
function urlOf(input: string | URL | Request): string {
	return typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
}

/**
 * Answers every probe URL. `overrides` maps a URL substring to a status code or a body. Records the
 * authorization header each request carried.
 */
function stubFetch(overrides: Record<string, number | { status: number; body: string }> = {}): Map<string, string | null> {
	const seenAuth = new Map<string, string | null>();
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			const url = urlOf(input);
			seenAuth.set(url, new Headers(init?.headers).get("authorization"));
			for (const [needle, answer] of Object.entries(overrides)) {
				if (!url.includes(needle)) continue;
				return typeof answer === "number"
					? new Response("", { status: answer })
					: new Response(answer.body, { status: answer.status });
			}
			if (url.endsWith("/api/health")) return new Response(consoleBody("healthy"), { status: 200 });
			// The Installer row reads the body (probes.ts assertInstaller), so it gets a real script.
			if (url.includes("get.alethialabs.io")) return new Response(INSTALL_SH, { status: 200 });
			return new Response("<html></html>", { status: 200 });
		}),
	);
	return seenAuth;
}

/** A fresh environment: empty D1, empty KV, the probe secret bound. */
function env(): Env & { DB: FakeD1; SNAPSHOT: FakeKV } {
	return { DB: new FakeD1(), SNAPSHOT: new FakeKV(), STATUS_PROBE_TOKEN: TOKEN };
}

/** The summary JSON out of the stored snapshot. */
async function summaryOf(e: { SNAPSHOT: FakeKV }): Promise<{ state: string; components: { id: string; health: string }[] }> {
	const stored = parseSnapshot(await e.SNAPSHOT.get(SNAPSHOT_KEY));
	if (!stored) throw new Error("no snapshot");
	return JSON.parse(stored.summaryJson);
}

const MINUTE = 60_000;
const T0 = Date.parse("2026-11-21T12:00:00.000Z");

describe("runCycle against a real, initially empty database", () => {
	it("applies its own schema and writes one check per component", async () => {
		stubFetch();
		const e = env();
		await runCycle(e, T0);
		expect(e.DB.rows("checks")).toHaveLength(COMPONENTS.length);
		expect(e.DB.rows("daily")).toHaveLength(COMPONENTS.length);
		for (const r of e.DB.rows("daily")) expect([r.total, r.up]).toEqual([1, 1]);
	});

	it("sends the probe credential to the console and nowhere else", async () => {
		const seen = stubFetch();
		await runCycle(env(), T0);
		expect(seen.get("https://alethialabs.io/api/health")).toBe(`Bearer ${TOKEN}`);
		for (const [url, auth] of seen) if (!url.endsWith("/api/health")) expect(auth).toBeNull();
	});

	it("publishes a snapshot that names every component", async () => {
		stubFetch();
		const e = env();
		await runCycle(e, T0);
		const summary = await summaryOf(e);
		expect(summary.state).toBe("operational");
		expect(summary.components.map((c) => c.id).sort()).toEqual(COMPONENTS.map((c) => c.id).sort());
		expect(parseSnapshot(await e.SNAPSHOT.get(SNAPSHOT_KEY))?.html).toContain("All systems operational");
	});

	it("accumulates the daily rollup across cycles rather than overwriting", async () => {
		stubFetch();
		const e = env();
		await runCycle(e, T0);
		stubFetch({ "get.alethialabs.io": 503 });
		await runCycle(e, T0 + MINUTE);
		const row = e.DB.rows("daily").find((r) => r.component === "installer");
		expect([row?.total, row?.up]).toEqual([2, 1]);
	});

	it("opens exactly one incident after two consecutive failures", async () => {
		const e = env();
		stubFetch({ "get.alethialabs.io": 503 });
		await runCycle(e, T0);
		expect(e.DB.rows("incidents")).toHaveLength(0);
		await runCycle(e, T0 + MINUTE);
		expect(e.DB.rows("incidents")).toHaveLength(1);
		await runCycle(e, T0 + 2 * MINUTE);
		expect(e.DB.rows("incidents")).toHaveLength(1);
		const inc = e.DB.rows("incidents")[0];
		expect(inc?.component).toBe("installer");
		expect(inc?.resolved_at).toBeNull();
	});

	it("resolves the incident after two consecutive recoveries", async () => {
		const e = env();
		stubFetch({ "get.alethialabs.io": 503 });
		await runCycle(e, T0);
		await runCycle(e, T0 + MINUTE);
		stubFetch();
		await runCycle(e, T0 + 2 * MINUTE);
		expect(e.DB.rows("incidents")[0]?.resolved_at).toBeNull();
		await runCycle(e, T0 + 3 * MINUTE);
		expect(e.DB.rows("incidents")[0]?.resolved_at).not.toBeNull();
	});

	/**
	 * The schema trap, end to end: the console reaches Postgres but the schema is gone. Through the
	 * real assertions, the real SQL and the self-applied schema, Database must go down and the whole
	 * page must read OUTAGE (the row is critical).
	 */
	it("reports an empty database as an outage", async () => {
		const e = env();
		stubFetch({ "/api/health": { status: 503, body: consoleBody("unhealthy", true, false) } });
		await runCycle(e, T0);
		await runCycle(e, T0 + MINUTE);
		const db = e.DB.rows("checks").filter((r) => r.component === "database");
		expect(db.every((r) => r.health === "down" && r.reason === "schema: missing")).toBe(true);
		expect((await summaryOf(e)).state).toBe("outage");
		expect(e.DB.rows("incidents").map((r) => r.component)).toContain("database");
	});

	it("without the probe secret, the detail rows read degraded — never up", async () => {
		stubFetch({ "/api/health": { status: 200, body: '{"status":"healthy","mode":"readiness","ts":"x"}' } });
		const e = { DB: new FakeD1(), SNAPSHOT: new FakeKV() };
		await runCycle(e, T0);
		const byId = new Map((await summaryOf(e)).components.map((c) => [c.id, c.health]));
		expect(byId.get("console")).toBe("up");
		expect(byId.get("database")).toBe("degraded");
		expect(byId.get("authorization")).toBe("degraded");
	});

	it("does not write KV again while nothing has changed", async () => {
		stubFetch();
		const e = env();
		await runCycle(e, T0);
		expect(e.SNAPSHOT.puts).toBe(1);
		for (let i = 1; i <= 5; i++) await runCycle(e, T0 + i * MINUTE);
		expect(e.SNAPSHOT.puts).toBe(1);
	});

	it("writes KV again the moment a component changes state", async () => {
		stubFetch();
		const e = env();
		await runCycle(e, T0);
		stubFetch({ "alethialabs.io/docs": 502 });
		await runCycle(e, T0 + MINUTE);
		expect(e.SNAPSHOT.puts).toBe(2);
	});

	it("prunes checks older than the retention window but keeps daily", async () => {
		stubFetch();
		const e = env();
		await runCycle(e, T0);
		await runCycle(e, T0 + 2 * 3600_000);
		expect(new Set(e.DB.rows("checks").map((r) => r.ts)).size).toBe(1);
		expect(e.DB.rows("daily")).toHaveLength(COMPONENTS.length);
	});

	it("one unreachable host does not abort the other probes", async () => {
		const e = env();
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request): Promise<Response> => {
				if (urlOf(input).includes("get.alethialabs.io")) throw new Error("getaddrinfo ENOTFOUND");
				if (urlOf(input).endsWith("/api/health")) return new Response(consoleBody("healthy"));
				return new Response("ok");
			}),
		);
		await runCycle(e, T0);
		const installer = e.DB.rows("checks").find((r) => r.component === "installer");
		expect([installer?.health, installer?.reason]).toEqual(["down", "getaddrinfo ENOTFOUND"]);
		expect(e.DB.rows("checks").filter((r) => r.health === "up")).toHaveLength(COMPONENTS.length - 1);
	});
});
