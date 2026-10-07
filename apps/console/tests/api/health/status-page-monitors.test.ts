// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// THE STATUS PAGE'S /api/health ROWS MUST BE ABLE TO PASS (#5629).
//
// deploy/status/config.yaml is a Gatus config. Its API row asserted `[BODY].status == ok` against
// the READINESS path, whose status is healthy | degraded | unhealthy — `ok` is liveness only. So the
// row could never pass, and the public status page would have shown the API DOWN from the moment it
// was deployed. Nothing type-checks a YAML string against a TypeScript union, and the page was not
// live, so nobody saw it.
//
// This test does not keep a list of the values the route returns. It RUNS the real GET handler, as
// an anonymous caller (Gatus sends no bearer), at each Gatus row's own URL (so `?shallow=1`,
// `?strict=1` etc. take effect exactly as in production), once for every HealthStatus, and reads the
// statuses and bodies that actually come back. Then it evaluates each row's conditions the way Gatus
// does. A value named in a `[BODY].status` condition that no run produced is a row that can never
// match that value — the defect class above.
//
// HealthStatus is enumerated by ALL_STATUSES below, a mapped type over the union: a value added to or
// removed from `HealthStatus` fails `tsc` here until this map matches, so the enumeration cannot
// drift from the type.
//
// BOUNDARY — what this does NOT see, on purpose:
//  - Only rows whose URL path is /api/health. Website / Console / Documentation assert `[STATUS] ==
//    200` on pages, which no unit test can serve.
//  - `[RESPONSE_TIME]` is a latency budget; it is treated as satisfied (there is no network here).
//  - The deep health compute is replaced by a fixed document per HealthStatus; what is real is the
//    route's mode selection, its sanitising, and httpStatusFor's status-code scheme. How a state is
//    REACHED (DB down, a loop stuck) is route.test.ts's and health.test.ts's job.
//  - Any condition shape, header, method or body this evaluator does not understand FAILS the test
//    instead of being skipped — extend the evaluator rather than letting a row go unchecked.
//
// IT MUST RE-RUN WHEN ONLY THE CONFIG CHANGES. Turbo's default inputs for console#test are the files
// under apps/console, so a PR editing deploy/status/config.yaml alone would get a cache hit and this
// file would never read it. apps/console/turbo.json adds that one file to the task's inputs.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import { z } from "zod";
import type { DeepHealth, HealthStatus } from "@/lib/observability/health";

const current = vi.hoisted(() => {
	const state: { status: HealthStatus } = { status: "healthy" };
	return state;
});

vi.mock("@/lib/observability/health", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/lib/observability/health")>();
	return {
		...actual,
		getDeepHealth: async (): Promise<DeepHealth> => ({
			status: current.status,
			ts: "2026-10-07T00:00:00.000Z",
			version: "test",
			db: { reachable: current.status !== "unhealthy", latencyMs: 1 },
			loops: [],
			otel: { configured: false, reachable: null },
		}),
	};
});

import { GET } from "@/app/api/health/route";

/** Every HealthStatus, exactly once — `tsc` fails here if the union and this map disagree. */
const ALL_STATUSES: { [S in HealthStatus]: S } = {
	healthy: "healthy",
	degraded: "degraded",
	unhealthy: "unhealthy",
};

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "..");
const CONFIG_PATH = join(REPO, "deploy", "status", "config.yaml");

const endpointSchema = z.object({
	name: z.string(),
	url: z.string(),
	method: z.string().optional(),
	headers: z.record(z.string(), z.string()).optional(),
	body: z.string().optional(),
	conditions: z.array(z.string()).min(1),
});
const configSchema = z.object({ endpoints: z.array(endpointSchema).min(1) });
type Endpoint = z.infer<typeof endpointSchema>;

/** One observed answer from the route. */
interface Observed {
	status: number;
	bodyStatus: unknown;
}

/** A parsed Gatus condition this evaluator understands. */
type Condition =
	| { kind: "status"; expected: number }
	| { kind: "body-status"; accepted: string[] }
	| { kind: "response-time" }
	/** No operator Gatus recognises: Gatus records "invalid condition" and the row is DOWN forever. */
	| { kind: "invalid"; raw: string };

/** Load and validate the Gatus endpoints from deploy/status/config.yaml. */
function loadEndpoints(): Endpoint[] {
	return configSchema.parse(parse(readFileSync(CONFIG_PATH, "utf8"))).endpoints;
}

/** The rows that probe the console's /api/health route. */
function healthEndpoints(): Endpoint[] {
	return loadEndpoints().filter((e) => new URL(e.url).pathname === "/api/health");
}

/** Throw for a condition shape this evaluator does not model, so a row is never silently skipped. */
function unsupported(raw: string): never {
	throw new Error(
		`unsupported Gatus condition on an /api/health row: ${JSON.stringify(raw)} — extend parseCondition`,
	);
}

/**
 * Parse one Gatus condition string the way Gatus v5 does (config/endpoint/condition.go): it looks for
 * the operator WITH its surrounding spaces — `" == "` first, then `" != "`, `" <= "`, `" >= "`,
 * `" > "`, `" < "` — splits on it, and trims each side. A condition containing none of them is
 * "invalid" and always fails, so `[BODY].status==healthy` is a row that is down forever, not a
 * spelling of `== healthy`. Supports `[STATUS] == N`, `[BODY].status == v`,
 * `[BODY].status == any(a, b)` and `[RESPONSE_TIME] < N`; any other operand or operator throws.
 */
function parseCondition(raw: string): Condition {
	if (raw.includes(" == ")) {
		const sides = raw.split(" == ").map((s) => s.trim());
		if (sides.length !== 2) unsupported(raw);
		const [lhs, rhs] = sides;
		if (lhs === "[STATUS]" && /^\d+$/.test(rhs)) return { kind: "status", expected: Number(rhs) };
		if (lhs === "[BODY].status") {
			const any = /^any\((.*)\)$/.exec(rhs);
			const accepted = any ? any[1].split(",").map((o) => o.trim()) : [rhs];
			return { kind: "body-status", accepted };
		}
		unsupported(raw);
	}
	if ([" != ", " <= ", " >= ", " > "].some((op) => raw.includes(op))) unsupported(raw);
	if (raw.includes(" < ")) {
		const sides = raw.split(" < ").map((s) => s.trim());
		if (sides.length === 2 && sides[0] === "[RESPONSE_TIME]" && /^\d+$/.test(sides[1])) {
			return { kind: "response-time" };
		}
		unsupported(raw);
	}
	return { kind: "invalid", raw };
}

/** Refuse a row whose request this test cannot reproduce faithfully. */
function assertReproducible(endpoint: Endpoint): void {
	if (endpoint.method && endpoint.method.toUpperCase() !== "GET") {
		throw new Error(`${endpoint.name}: method ${endpoint.method} is not modelled`);
	}
	if (endpoint.headers || endpoint.body) {
		throw new Error(`${endpoint.name}: request headers/body are not modelled (a bearer changes the body)`);
	}
}

/** Run the real route at the row's URL with the deep health forced to `state`. */
async function observe(url: string, state: HealthStatus): Promise<Observed> {
	current.status = state;
	const res = await GET(new Request(url));
	const json: unknown = await res.json();
	const parsed = z.object({ status: z.unknown() }).safeParse(json);
	return { status: res.status, bodyStatus: parsed.success ? parsed.data.status : undefined };
}

/** Whether a row's conditions all pass against one observed answer, as Gatus would judge it. */
function passes(conditions: Condition[], seen: Observed): boolean {
	return conditions.every((c) => {
		if (c.kind === "status") return seen.status === c.expected;
		if (c.kind === "body-status") {
			return typeof seen.bodyStatus === "string" && c.accepted.includes(seen.bodyStatus);
		}
		if (c.kind === "invalid") return false;
		return true;
	});
}

/** The row's verdict in every HealthStatus. */
async function verdicts(endpoint: Endpoint): Promise<Map<HealthStatus, { up: boolean; seen: Observed }>> {
	assertReproducible(endpoint);
	const conditions = endpoint.conditions.map(parseCondition);
	const out = new Map<HealthStatus, { up: boolean; seen: Observed }>();
	for (const state of Object.values(ALL_STATUSES)) {
		const seen = await observe(endpoint.url, state);
		out.set(state, { up: passes(conditions, seen), seen });
	}
	return out;
}

describe("parseCondition — reads a condition the way Gatus does", () => {
	it("an operator without its spaces is an INVALID condition, which Gatus fails on every check", () => {
		const c = parseCondition("[BODY].status==healthy");
		expect(c).toEqual({ kind: "invalid", raw: "[BODY].status==healthy" });
		expect(passes([c], { status: 200, bodyStatus: "healthy" })).toBe(false);
	});

	it("extra whitespace around a spaced operator is trimmed, as Gatus trims it", () => {
		expect(parseCondition("[BODY].status  ==  any(healthy,degraded)")).toEqual({
			kind: "body-status",
			accepted: ["healthy", "degraded"],
		});
	});

	it("an operator or operand it does not model throws instead of being skipped", () => {
		expect(() => parseCondition("[BODY].status != unhealthy")).toThrow(/unsupported/);
		expect(() => parseCondition("[BODY].db.reachable == true")).toThrow(/unsupported/);
	});
});

describe("deploy/status/config.yaml — the /api/health rows match what the route returns", () => {
	it("finds at least one /api/health row (an empty selection would pass everything below)", () => {
		expect(healthEndpoints().length).toBeGreaterThan(0);
	});

	it("names no [BODY].status value the route cannot return at that URL", async () => {
		const impossible: string[] = [];
		for (const endpoint of healthEndpoints()) {
			const v = await verdicts(endpoint);
			const returnable = new Set([...v.values()].map((x) => String(x.seen.bodyStatus)));
			for (const c of endpoint.conditions.map(parseCondition)) {
				if (c.kind !== "body-status") continue;
				for (const value of c.accepted) {
					if (!returnable.has(value)) {
						impossible.push(
							`${endpoint.name} (${endpoint.url}): "${value}" — the route returns only ${[...returnable].join(", ")}`,
						);
					}
				}
			}
		}
		expect(impossible).toEqual([]);
	});

	it("every row is UP while the platform is healthy", async () => {
		const downWhenHealthy: string[] = [];
		for (const endpoint of healthEndpoints()) {
			const healthy = (await verdicts(endpoint)).get("healthy");
			if (healthy?.up) continue;
			const invalid = endpoint.conditions.filter((c) => parseCondition(c).kind === "invalid");
			downWhenHealthy.push(
				`${endpoint.name} saw ${JSON.stringify(healthy?.seen)}` +
					(invalid.length ? ` — Gatus cannot parse ${JSON.stringify(invalid)} (operators need spaces)` : ""),
			);
		}
		expect(downWhenHealthy).toEqual([]);
	});

	it("every READINESS row (its answer depends on health) goes DOWN when unhealthy (DB unreachable or the health compute failed)", async () => {
		const blind: string[] = [];
		for (const endpoint of healthEndpoints()) {
			const v = await verdicts(endpoint);
			const answers = new Set([...v.values()].map((x) => JSON.stringify(x.seen)));
			if (answers.size === 1) continue; // liveness: same answer in every state, by design
			if (v.get("unhealthy")?.up) blind.push(endpoint.name);
		}
		expect(blind).toEqual([]);
	});

	// The decision #5629 made, pinned: a degraded API still serves, so the API row stays up and the
	// Background jobs row carries the degradation. Changing this is a policy change — change it here.
	it("API is down only when unhealthy; Background jobs is down whenever not healthy", async () => {
		const byName = new Map(healthEndpoints().map((e) => [e.name, e]));
		const api = byName.get("API");
		const jobs = byName.get("Background jobs");
		expect(api).toBeDefined();
		expect(jobs).toBeDefined();
		if (!api || !jobs) return;
		const apiV = await verdicts(api);
		const jobsV = await verdicts(jobs);
		expect(Object.fromEntries([...apiV].map(([s, x]) => [s, x.up]))).toEqual({
			healthy: true,
			degraded: true,
			unhealthy: false,
		});
		expect(Object.fromEntries([...jobsV].map(([s, x]) => [s, x.up]))).toEqual({
			healthy: true,
			degraded: false,
			unhealthy: false,
		});
	});
});
