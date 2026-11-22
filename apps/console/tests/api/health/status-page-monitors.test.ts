// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// THE STATUS PAGE'S /api/health ROWS MUST BE ABLE TO PASS — AND TO FAIL (#5629, #7148).
//
// This used to read deploy/status/config.yaml, a Gatus config whose API row asserted a value the route
// could never return, so the page would have shown the API down from the day it went live. That page was
// never applied and is gone; status.alethialabs.io is now a Cloudflare Worker (packages/status) whose
// rows are TypeScript assertions over this route's body.
//
// The defect class is unchanged: two sides of one contract, written in two places, that nothing compiles
// against each other. So this test does not restate either side. It RUNS the real GET handler with the
// status-probe credential (exactly as the Worker calls it), feeds the real Response into the Worker's
// REAL assertions (imported from packages/status/src/probes.ts), and checks the verdicts per platform
// state. A field renamed on either side, a boolean that becomes a string, a status value one side does
// not know — each turns a row here red instead of turning the public page wrong.
//
// HealthStatus is enumerated by ALL_STATUSES below, a mapped type over the union: a value added to or
// removed from `HealthStatus` fails `tsc` here until this map matches, so the enumeration cannot drift.
//
// BOUNDARY — what this does NOT see, on purpose:
//  - The page rows (Website, Docs, News, Installer) are status-code checks on pages no unit test serves;
//    packages/status/tests/probes.test.ts pins their strictness (a redirect is down).
//  - The deep compute is replaced by a fixed document per state; what is real is the route's audience
//    selection, statusProbeView's projection, httpStatusFor's codes and the Worker's assertions. How a
//    state is REACHED (DB down, schema missing, OpenFGA down) is health.test.ts's job.
//
// IT MUST RE-RUN WHEN ONLY THE WORKER CHANGES. Turbo's default inputs for console#test are the files
// under apps/console, so apps/console/turbo.json adds packages/status/src/probes.ts to the task's inputs.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeepHealth, HealthStatus } from "@/lib/observability/health";
// A relative import into another workspace package, deliberately: this test exists to compile the
// Worker's side of the contract against the route's, and the Worker ships as a bundle, not as a library.
import {
	assertAuthorization,
	assertConsole,
	assertDatabase,
	type EndpointResult,
	NO_CREDENTIAL,
	type Verdict,
} from "../../../../../packages/status/src/probes";

/** The platform state the mocked deep compute reports. */
interface World {
	status: HealthStatus;
	db: boolean;
	schema: boolean | null;
	/** null = OpenFGA not configured. */
	openfga: boolean | null;
}

const current = vi.hoisted(() => {
	const state: { world: World } = { world: { status: "healthy", db: true, schema: true, openfga: null } };
	return state;
});

vi.mock("@/lib/observability/health", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/lib/observability/health")>();
	return {
		...actual,
		getDeepHealth: async (): Promise<DeepHealth> => {
			const w = current.world;
			return {
				status: w.status,
				ts: "2026-11-21T00:00:00.000Z",
				version: "test",
				db: { reachable: w.db, latencyMs: w.db ? 1 : null, notifyQueueUsage: w.db ? 0 : null },
				schema: { ok: w.schema },
				openfga: w.openfga === null ? { configured: false, reachable: null } : { configured: true, reachable: w.openfga },
				loops: [],
				otel: { configured: false, reachable: null },
			};
		},
	};
});

import { GET } from "@/app/api/health/route";

/** Every HealthStatus, exactly once — `tsc` fails here if the union and this map disagree. */
const ALL_STATUSES: { [S in HealthStatus]: S } = {
	healthy: "healthy",
	degraded: "degraded",
	unhealthy: "unhealthy",
};

const TOKEN = "status-probe-token-for-tests";
const saved = process.env.ALETHIA_STATUS_PROBE_TOKEN;
beforeEach(() => {
	process.env.ALETHIA_STATUS_PROBE_TOKEN = TOKEN;
});
afterEach(() => {
	if (saved === undefined) delete process.env.ALETHIA_STATUS_PROBE_TOKEN;
	else process.env.ALETHIA_STATUS_PROBE_TOKEN = saved;
});

/** Call the real route as the Worker does (or anonymously) in `world`, and hand back what the Worker sees. */
async function probe(world: World, withToken = true): Promise<EndpointResult> {
	current.world = world;
	const headers: Record<string, string> = withToken ? { authorization: `Bearer ${TOKEN}` } : {};
	const res = await GET(new Request("https://alethialabs.io/api/health", { headers }));
	return { status: res.status, body: await res.text(), ms: 1 };
}

/** The three rows' verdicts for one answer. */
function rows(r: EndpointResult): { console: Verdict; database: Verdict; authorization: Verdict } {
	return { console: assertConsole(r), database: assertDatabase(r), authorization: assertAuthorization(r) };
}

describe("the console's /api/health and the status Worker agree", () => {
	it("every HealthStatus maps to a Console verdict the Worker understands — never 'unexpected status'", async () => {
		const expected: { [S in HealthStatus]: Verdict["health"] } = { healthy: "up", degraded: "degraded", unhealthy: "down" };
		for (const status of Object.values(ALL_STATUSES)) {
			const v = assertConsole(await probe({ status, db: status !== "unhealthy", schema: true, openfga: null }));
			expect(v.health, status).toBe(expected[status]);
			expect(v.reason ?? "", status).not.toMatch(/unexpected|unreadable/);
		}
	});

	it("a healthy platform reads all three rows UP", async () => {
		const v = rows(await probe({ status: "healthy", db: true, schema: true, openfga: null }));
		expect([v.console.health, v.database.health, v.authorization.health]).toEqual(["up", "up", "up"]);
	});

	it("a stuck background loop is DEGRADED on the Console row while the data rows stay up (the 200 trap)", async () => {
		const r = await probe({ status: "degraded", db: true, schema: true, openfga: null });
		expect(r.status).toBe(200);
		const v = rows(r);
		expect(v.console.health).toBe("degraded");
		expect(v.database.health).toBe("up");
	});

	it("a database that is down reads DOWN on all three rows, through the 503", async () => {
		const r = await probe({ status: "unhealthy", db: false, schema: null, openfga: null });
		expect(r.status).toBe(503);
		const v = rows(r);
		expect(v.console.health).toBe("down");
		expect(v.database).toEqual({ health: "down", reason: "db: unreachable" });
		expect(v.authorization.health).toBe("down"); // the Postgres engine is the database
	});

	it("a reachable but EMPTY database reads Database DOWN with the schema named", async () => {
		const v = rows(await probe({ status: "unhealthy", db: true, schema: false, openfga: null }));
		expect(v.database).toEqual({ health: "down", reason: "schema: missing" });
	});

	it("OpenFGA unreachable reads Authorization DOWN while the database stays up", async () => {
		const v = rows(await probe({ status: "degraded", db: true, schema: true, openfga: false }));
		expect(v.authorization).toEqual({ health: "down", reason: "openfga: unreachable" });
		expect(v.database.health).toBe("up");
	});

	it("without the credential the detail rows are DEGRADED with a reason — never up — and the route leaks nothing", async () => {
		const r = await probe({ status: "healthy", db: true, schema: true, openfga: null }, false);
		expect(JSON.parse(r.body)).toEqual({ status: "healthy", mode: "readiness", ts: "2026-11-21T00:00:00.000Z" });
		const v = rows(r);
		expect(v.console.health).toBe("up");
		expect(v.database).toEqual({ health: "degraded", reason: NO_CREDENTIAL });
		expect(v.authorization).toEqual({ health: "degraded", reason: NO_CREDENTIAL });
	});
});
