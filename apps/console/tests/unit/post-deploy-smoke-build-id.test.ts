// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The post-deploy smoke's `build-id` check must read the CONSOLE (#5620).
//
// Deploy run 37760242162 (merge 87ddeb534) failed with "the browser is running build unset" after
// #5621 had fixed the console's runner stage, because the check visited `/` — and on the public host
// an anonymous `/` is routed to the MARKETING container, whose image never sets
// NEXT_PUBLIC_APP_VERSION. Nothing in a unit suite could have said so, because nothing asked WHICH
// app serves the path the check visits.
//
// This test asks. It runs the real check (scripts/e2e/build-id-check.ts) against a fake browser that
// records the path visited, then resolves that path through the edge router production actually
// runs — deploy/prod/Caddyfile.tunnel, mounted by deploy/prod/docker-compose.tunnel.yml, which
// .github/workflows/deploy-console.yml layers on every production deploy — for an ANONYMOUS request
// to the public host, and requires the console upstream.
//
// WHAT THE RESOLVER RANGES OVER, stated so nobody reads it as Caddy:
//   - only the `handle` blocks directly inside the `:80` site, and only their `reverse_proxy`. Any
//     other site-level directive except `encode` (`handle_path`, `route`, `redir`, …) THROWS.
//   - NOT the browser probe in post-deploy-smoke.ts: that it passes its `pathname` to `ctx.visit`
//     is read there, not tested here.
//   - matchers: `path` (exact, `prefix*`, `*suffix`), `host`, and `header` / `header_regexp`, which an
//     anonymous request with no cookies never satisfies. Any other matcher type THROWS, so a new
//     routing rule the resolver cannot read fails this test rather than being silently skipped.
//   - Caddy orders `handle` blocks by its own directive-sort rules. The resolver does not model them:
//     it refuses (throws) when more than one matcher-bearing block matches, and falls to the bare
//     `handle {}` only when none does. That makes order irrelevant for every answer it gives.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	assertServedBuild,
	BUILD_ID_PATH,
	CONSOLE_BUILD,
	MARKETING_BUILD,
	type BuildTarget,
	type ServedBuild,
} from "../../scripts/e2e/build-id-check";

const CONSOLE = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const REPO = join(CONSOLE, "..", "..");
const CADDYFILE = readFileSync(join(REPO, "deploy/prod/Caddyfile.tunnel"), "utf8");
const PROD_COMPOSE = readFileSync(join(REPO, "deploy/prod/docker-compose.prod.yml"), "utf8");
const PUBLIC_HOST = "alethialabs.io";

/** One matcher condition; a matcher is the AND of its conditions. */
type Condition =
	| { kind: "path"; patterns: string[] }
	| { kind: "host"; hosts: string[] }
	| { kind: "header" };

/** A `handle` block: its conditions (empty for the catch-all) and the upstream it proxies to. */
interface Route {
	label: string;
	conditions: Condition[] | null;
	upstream: string;
}

/** Parses one matcher line (`path /a /b`, `host x`, `header_regexp …`) into a condition. */
function parseCondition(line: string): Condition {
	const [kind, ...args] = line.trim().split(/\s+/);
	if (kind === "path") return { kind: "path", patterns: args };
	if (kind === "host") return { kind: "host", hosts: args };
	if (kind === "header" || kind === "header_regexp") return { kind: "header" };
	throw new Error(`Caddyfile.tunnel uses matcher "${kind}", which this resolver cannot read`);
}

/** Reads the `handle` routes of the `:80` site in a Caddyfile, in source order. */
function parseRoutes(caddyfile: string): Route[] {
	const lines = caddyfile
		.split("\n")
		.map((l) => l.replace(/#.*$/, "").trimEnd())
		.filter((l) => l.trim() !== "");
	const matchers = new Map<string, Condition[]>();
	const routes: Route[] = [];
	let depth = 0;
	let i = 0;
	while (i < lines.length) {
		const line = lines[i].trim();
		if (depth === 1 && line.startsWith("@")) {
			const [name, ...rest] = line.split(/\s+/);
			if (rest.join(" ") === "{") {
				const conds: Condition[] = [];
				i += 1;
				while (lines[i].trim() !== "}") {
					conds.push(parseCondition(lines[i]));
					i += 1;
				}
				matchers.set(name, conds);
			} else {
				matchers.set(name, [parseCondition(rest.join(" "))]);
			}
			i += 1;
			continue;
		}
		const handle = depth === 1 ? /^handle(?:\s+(\S+))?\s*\{$/.exec(line) : null;
		if (handle) {
			const arg = handle[1];
			let upstream: string | null = null;
			i += 1;
			while (lines[i].trim() !== "}") {
				const proxy = /^reverse_proxy\s+(\S+)$/.exec(lines[i].trim());
				if (proxy) upstream = proxy[1];
				i += 1;
			}
			if (!upstream) throw new Error(`handle ${arg ?? "{}"} has no reverse_proxy`);
			let conditions: Condition[] | null = null;
			if (arg?.startsWith("@")) {
				const named = matchers.get(arg);
				if (!named) throw new Error(`handle ${arg} names an undefined matcher`);
				conditions = named;
			} else if (arg) {
				conditions = [{ kind: "path", patterns: [arg] }];
			}
			routes.push({ label: arg ?? "{catch-all}", conditions, upstream });
			i += 1;
			continue;
		}
		// Any other site-level directive (`handle_path`, `route`, `redir`, …) could route a path this
		// resolver would then misattribute, so it is refused rather than walked past.
		if (depth === 1 && !/^encode\s/.test(line) && line !== "}") {
			throw new Error(`Caddyfile.tunnel has site-level directive "${line}", which this resolver cannot read`);
		}
		if (line.endsWith("{")) depth += 1;
		if (line === "}") depth -= 1;
		i += 1;
	}
	return routes;
}

/** Caddy path matching for the three shapes the resolver supports. */
function pathMatches(pattern: string, pathname: string): boolean {
	if (pattern.endsWith("*")) return pathname.startsWith(pattern.slice(0, -1));
	if (pattern.startsWith("*")) return pathname.endsWith(pattern.slice(1));
	return pathname === pattern;
}

/** Whether an anonymous request (no cookies) for `host` + `pathname` satisfies a condition. */
function conditionHolds(c: Condition, host: string, pathname: string): boolean {
	if (c.kind === "path") return c.patterns.some((p) => pathMatches(p, pathname));
	if (c.kind === "host") return c.hosts.includes(host);
	return false;
}

/** The upstream an anonymous request to the public host is proxied to. Throws when ambiguous. */
function upstreamFor(pathname: string): string {
	const routes = parseRoutes(CADDYFILE);
	const hits = routes.filter(
		(r) => r.conditions !== null && r.conditions.every((c) => conditionHolds(c, PUBLIC_HOST, pathname)),
	);
	if (hits.length > 1) {
		throw new Error(`${pathname} matches ${hits.map((h) => h.label).join(", ")} — order would decide`);
	}
	if (hits.length === 1) return hits[0].upstream;
	const fallback = routes.find((r) => r.conditions === null);
	if (!fallback) throw new Error("Caddyfile.tunnel has no catch-all handle");
	return fallback.upstream;
}

/** Runs the real build-id check against a fake browser; returns what it visited and reported. */
async function runCheck(
	served: ServedBuild,
	expected: string | undefined,
	target: BuildTarget = CONSOLE_BUILD,
) {
	const visited: string[] = [];
	const failures: string[] = [];
	const notes: string[] = [];
	await assertServedBuild(
		target,
		{
			/** Records the visit and answers with the canned page. */
			async read(pathname) {
				visited.push(pathname);
				return served;
			},
		},
		expected,
		{ fail: (why) => failures.push(why), note: (what) => notes.push(what) },
	);
	return { visited, failures, notes };
}

const SHA = "87ddeb5348b9c0ffee0000000000000000000000";

describe("the edge resolver can tell the apps apart (the controls)", () => {
	it("routes an anonymous / to marketing — the route the check used to read", () => {
		expect(upstreamFor("/")).toBe("marketing:3000");
	});

	it("routes the other zones to their own upstreams", () => {
		expect(upstreamFor("/pricing")).toBe("marketing:3000");
		expect(upstreamFor("/legal/dpa")).toBe("marketing:3000");
		expect(upstreamFor("/docs/cli")).toBe("docs:3000");
		expect(upstreamFor("/dashboard")).toBe("app:3000");
	});

	it("names the console image as the `app` service production runs", () => {
		expect(PROD_COMPOSE).toMatch(/^ {2}app:\n {4}image: "ghcr\.io\/alethialabs-io\/console:/m);
	});

	it("names the marketing image as the `marketing` service production runs", () => {
		expect(PROD_COMPOSE).toMatch(
			/^ {2}marketing:\n(?: {4}\S.*\n)*? {4}image: "ghcr\.io\/alethialabs-io\/marketing:/m,
		);
	});
});

describe("post-deploy smoke: build-id", () => {
	it("reads the build id from exactly one page, and the console serves it", async () => {
		const { visited } = await runCheck({ version: SHA, finalPathname: BUILD_ID_PATH }, SHA);
		expect(visited).toEqual([BUILD_ID_PATH]);
		expect(upstreamFor(visited[0])).toBe("app:3000");
	});

	it("passes only on an exact match", async () => {
		const r = await runCheck({ version: SHA, finalPathname: BUILD_ID_PATH }, SHA);
		expect(r.failures).toEqual([]);
		expect(r.notes.join()).toContain(SHA);
	});

	it("fails when the page carries no build id — it cannot pass on a page that rendered none", async () => {
		const r = await runCheck({ version: null, finalPathname: BUILD_ID_PATH }, SHA);
		expect(r.failures).toHaveLength(1);
		expect(r.failures[0]).toContain("unset");
	});

	it("fails on a different build", async () => {
		const r = await runCheck({ version: "0".repeat(40), finalPathname: BUILD_ID_PATH }, SHA);
		expect(r.failures).toHaveLength(1);
		expect(r.failures[0]).toContain("stale bytes");
	});

	it("fails when the browser was redirected off the console route, even on a matching id", async () => {
		const r = await runCheck({ version: SHA, finalPathname: "/" }, SHA);
		expect(r.failures).toHaveLength(1);
		expect(r.notes).toEqual([]);
	});

	it("says NOT ASSERTED, rather than passing silently, when no SHA was promoted", async () => {
		const r = await runCheck({ version: SHA, finalPathname: BUILD_ID_PATH }, undefined);
		expect(r.failures).toEqual([]);
		expect(r.notes.join()).toContain("NOT ASSERTED");
	});
});

// #5697: the same check, aimed at the marketing site. Its image now sets NEXT_PUBLIC_APP_VERSION in
// the runner stage (dockerfile-runtime-public-env.test.ts), so `/` has a build id worth asserting.
describe("post-deploy smoke: marketing-build-id", () => {
	it("reads the build id from exactly one page, and marketing serves it", async () => {
		const { visited } = await runCheck({ version: SHA, finalPathname: "/" }, SHA, MARKETING_BUILD);
		expect(visited).toEqual([MARKETING_BUILD.path]);
		expect(upstreamFor(visited[0])).toBe("marketing:3000");
	});

	it("passes only on an exact match, and names marketing", async () => {
		const r = await runCheck({ version: SHA, finalPathname: "/" }, SHA, MARKETING_BUILD);
		expect(r.failures).toEqual([]);
		expect(r.notes.join()).toContain(`marketing build ${SHA}`);
	});

	it("fails when marketing's page carries no build id", async () => {
		const r = await runCheck({ version: null, finalPathname: "/" }, SHA, MARKETING_BUILD);
		expect(r.failures).toHaveLength(1);
		expect(r.failures[0]).toContain("the marketing at / is running build unset");
	});

	it("fails on a different marketing build", async () => {
		const r = await runCheck({ version: "0".repeat(40), finalPathname: "/" }, SHA, MARKETING_BUILD);
		expect(r.failures).toHaveLength(1);
		expect(r.failures[0]).toContain("stale bytes");
	});

	it("fails when `/` redirected elsewhere, even on a matching id", async () => {
		const r = await runCheck({ version: SHA, finalPathname: "/login" }, SHA, MARKETING_BUILD);
		expect(r.failures).toHaveLength(1);
		expect(r.notes).toEqual([]);
	});

	it("says NOT ASSERTED when the apps group was retagged rather than rebuilt", async () => {
		const r = await runCheck({ version: "0".repeat(40), finalPathname: "/" }, undefined, MARKETING_BUILD);
		expect(r.failures).toEqual([]);
		expect(r.notes.join()).toContain("NOT ASSERTED");
	});

	it("the two checks read different apps — neither can stand in for the other", () => {
		expect(upstreamFor(CONSOLE_BUILD.path)).toBe("app:3000");
		expect(upstreamFor(MARKETING_BUILD.path)).toBe("marketing:3000");
	});
});
