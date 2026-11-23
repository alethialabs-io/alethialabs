// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import {
	COMPONENTS,
	ENDPOINTS,
	NO_CREDENTIAL,
	readConsoleHealth,
	rollUp,
	type EndpointResult,
	type Health,
} from "../src/probes";

/**
 * The page is only worth having if these hold. Every other file renders whatever `probes.ts`
 * decides, so a wrong assertion is not cosmetic — it is a status page that reports "operational"
 * during an outage, which is worse than no status page at all.
 *
 * The anonymous body and the page answers below were captured from production on 2026-11-21. The
 * probe-credential body is the shape apps/console/app/api/health/route.ts returns to the bearer —
 * apps/console/tests/api/health/status-page-monitors.test.ts runs the REAL route through these same
 * assertions, so the two sides cannot drift apart.
 */

const LIVE_ANONYMOUS = '{"status":"healthy","mode":"readiness","ts":"2026-11-21T22:05:46.724Z"}';

/** The body the console returns to the probe credential. */
function probeBody(status: string, checks: { db: boolean; schema: boolean; openfga: boolean | null }): string {
	return JSON.stringify({ status, mode: "status", ts: "2026-11-21T22:05:46.724Z", checks });
}

const HEALTHY = probeBody("healthy", { db: true, schema: true, openfga: null });

/** The head of apps/console/public/install.sh as production served it on 2026-11-23. */
const INSTALL_SH =
	'#!/bin/sh\n# Alethia CLI installer (macOS / Linux).\n# SPDX-License-Identifier: AGPL-3.0-only\n\nmain() {\n\tset -eu\n\n\tREPO="alethialabs-io/alethia-cli"\n}\n';

/** A response with the given code and body. */
function res(status: number, body = "", location?: string): EndpointResult {
	return location ? { status, body, ms: 12, location } : { status, body, ms: 12 };
}

/** Every endpoint healthy. */
function healthyWorld(): Record<string, EndpointResult> {
	return {
		"console-health": res(200, HEALTHY),
		website: res(200, "<html>home</html>"),
		docs: res(200, "<html>docs</html>"),
		news: res(200, "<html>news</html>"),
		installer: res(200, INSTALL_SH),
	};
}

/** One component's verdict in a world. */
function healthOf(world: Record<string, EndpointResult>, id: string): { health: Health; reason?: string } {
	const c = COMPONENTS.find((x) => x.id === id);
	if (!c) throw new Error(`no component ${id}`);
	const r = world[c.endpoint];
	if (!r) throw new Error(`no result for endpoint ${c.endpoint}`);
	return c.assert(r);
}

describe("wiring", () => {
	it("every component points at an endpoint that exists", () => {
		const keys = new Set(ENDPOINTS.map((e) => e.key));
		for (const c of COMPONENTS) expect(keys.has(c.endpoint)).toBe(true);
	});

	it("component ids are unique — they are the public JSON contract keys", () => {
		const ids = COMPONENTS.map((c) => c.id);
		expect(new Set(ids).size).toBe(ids.length);
	});

	it("names the seven components the issue lists, and no email row (see the README)", () => {
		expect(COMPONENTS.map((c) => c.id)).toEqual([
			"console",
			"database",
			"authorization",
			"website",
			"docs",
			"news",
			"installer",
		]);
	});

	it("a healthy world is all up and operational", () => {
		const world = healthyWorld();
		const all = COMPONENTS.map((c) => ({ id: c.id, ...healthOf(world, c.id) }));
		for (const c of all) expect(c.health).toBe("up");
		expect(rollUp(all)).toBe("operational");
	});

	it("sends the probe credential to the console health endpoint only, and only when it is set", () => {
		const consoleHealth = ENDPOINTS.find((e) => e.key === "console-health");
		expect(consoleHealth?.headers?.({ STATUS_PROBE_TOKEN: "t0ken" })).toEqual({ authorization: "Bearer t0ken" });
		expect(consoleHealth?.headers?.({})).toEqual({});
		for (const e of ENDPOINTS.filter((x) => x.key !== "console-health")) expect(e.headers).toBeUndefined();
	});
});

/**
 * THE TRAP. The console answers 200 for `degraded`, and a reachable-but-empty database passes
 * `SELECT 1`. If these fail, the whole page is decorative.
 */
describe("the health body, not the status code, decides", () => {
	it("a 200 that says degraded is DEGRADED, not up", () => {
		const world = healthyWorld();
		world["console-health"] = res(200, probeBody("degraded", { db: true, schema: true, openfga: null }));
		expect(healthOf(world, "console").health).toBe("degraded");
	});

	it("reports the database DOWN on a reachable but EMPTY cluster", () => {
		const world = healthyWorld();
		world["console-health"] = res(503, probeBody("unhealthy", { db: true, schema: false, openfga: null }));
		expect(healthOf(world, "database")).toEqual({ health: "down", reason: "schema: missing" });
		expect(healthOf(world, "console").health).toBe("down");
	});

	it("reads the checks off an unhealthy 503 rather than stopping at the code", () => {
		const world = healthyWorld();
		world["console-health"] = res(503, probeBody("unhealthy", { db: false, schema: false, openfga: null }));
		expect(healthOf(world, "database")).toEqual({ health: "down", reason: "db: unreachable" });
	});

	it("never reports UP for an unreadable payload", () => {
		const world = healthyWorld();
		world["console-health"] = res(200, "<html>a proxy error page</html>");
		for (const id of ["console", "database", "authorization"]) {
			expect(healthOf(world, id).health).not.toBe("up");
		}
	});

	it("an anonymous answer (the credential was not accepted) is DEGRADED with a reason that says so", () => {
		const world = healthyWorld();
		world["console-health"] = res(200, LIVE_ANONYMOUS);
		// The aggregate is public, so the Console row can still be read…
		expect(healthOf(world, "console").health).toBe("up");
		// …but the detail rows cannot, and "I could not tell" is not "it is fine".
		expect(healthOf(world, "database")).toEqual({ health: "degraded", reason: NO_CREDENTIAL });
		expect(healthOf(world, "authorization")).toEqual({ health: "degraded", reason: NO_CREDENTIAL });
	});

	it("a non-boolean check is DEGRADED, never up", () => {
		const world = healthyWorld();
		world["console-health"] = res(
			200,
			JSON.stringify({ status: "healthy", checks: { db: "ok", schema: true, openfga: null } }),
		);
		expect(healthOf(world, "database").health).toBe("degraded");
	});

	it("a transport failure is DOWN for all three rows", () => {
		const world = healthyWorld();
		world["console-health"] = { status: 0, body: "", ms: 8000, error: "The operation timed out." };
		for (const id of ["console", "database", "authorization"]) {
			expect(healthOf(world, id)).toEqual({ health: "down", reason: "The operation timed out." });
		}
	});
});

describe("authorization follows the engine that is actually deciding", () => {
	it("with OpenFGA configured, it is judged on the OpenFGA boolean", () => {
		const world = healthyWorld();
		world["console-health"] = res(200, probeBody("degraded", { db: true, schema: true, openfga: false }));
		expect(healthOf(world, "authorization")).toEqual({ health: "down", reason: "openfga: unreachable" });
		world["console-health"] = res(200, probeBody("healthy", { db: true, schema: true, openfga: true }));
		expect(healthOf(world, "authorization").health).toBe("up");
	});

	it("without OpenFGA (openfga: null), the Postgres engine is up exactly when the database is", () => {
		const world = healthyWorld();
		world["console-health"] = res(503, probeBody("unhealthy", { db: false, schema: false, openfga: null }));
		expect(healthOf(world, "authorization")).toEqual({
			health: "down",
			reason: "postgres engine — db: unreachable",
		});
	});

	it("a payload with no openfga key at all is DEGRADED — absence is not 'not configured'", () => {
		expect(readConsoleHealth('{"status":"healthy","checks":{"db":true,"schema":true}}')?.checks?.openfga).toBeUndefined();
		const world = healthyWorld();
		world["console-health"] = res(200, '{"status":"healthy","checks":{"db":true,"schema":true}}');
		expect(healthOf(world, "authorization")).toEqual({ health: "degraded", reason: "openfga: missing" });
	});
});

describe("pages are judged strictly — a redirect is down", () => {
	it("reports News DOWN on the 307 to /login production answered on 2026-11-21, naming the target", () => {
		const world = healthyWorld();
		world.news = res(307, "", "https://alethialabs.io/login?next=%2Fnews");
		expect(healthOf(world, "news")).toEqual({
			health: "down",
			reason: "HTTP 307 → https://alethialabs.io/login?next=%2Fnews",
		});
	});

	it("a 5xx page is down; a non-critical row down is DEGRADED overall, not an outage", () => {
		const world = healthyWorld();
		world.docs = res(502);
		expect(healthOf(world, "docs")).toEqual({ health: "down", reason: "HTTP 502" });
		const all = COMPONENTS.map((c) => ({ id: c.id, ...healthOf(world, c.id) }));
		expect(rollUp(all)).toBe("degraded");
	});

	it("a critical row down is an OUTAGE", () => {
		expect(
			rollUp([
				{ id: "database", health: "down" },
				{ id: "website", health: "up" },
			]),
		).toBe("outage");
	});
});

describe("the installer is judged on its body", () => {
	it("is up when it serves the install script", () => {
		expect(healthOf(healthyWorld(), "installer")).toEqual({ health: "up" });
	});

	it("is DOWN when a routing regression serves a web page with a 200", () => {
		const world = healthyWorld();
		world.installer = res(200, "<!DOCTYPE html><html><head><title>Alethia</title></head></html>");
		const v = healthOf(world, "installer");
		expect(v.health).toBe("down");
		expect(v.reason).toMatch(/not the install script/);
	});

	it("is DOWN for a shell script that is not this installer", () => {
		const world = healthyWorld();
		world.installer = res(200, "#!/bin/sh\necho hello\n");
		expect(healthOf(world, "installer")).toEqual({ health: "down", reason: "a shell script, but not the Alethia installer" });
	});

	it("keeps the page rules: a redirect is down with its target, before the body is read", () => {
		const world = healthyWorld();
		world.installer = res(301, "", "https://alethialabs.io/");
		expect(healthOf(world, "installer")).toEqual({ health: "down", reason: "HTTP 301 → https://alethialabs.io/" });
	});
});
