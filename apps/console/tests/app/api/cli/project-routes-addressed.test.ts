// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// Every CLI route whose permission is the org-wide project question also asks about THE project.
//
// `authorizeCli(req, action, { type: "project" })` carries no id, so it answers for the org: may this
// caller `action` projects here at all? A grant or deny scoped to one project is not part of that
// answer. The second half lives in lib/cli/project-access.ts:
//   - `resolveCliProjectAuthorized` (or `resolveByoScope`, which calls it) — resolve the addressed
//     project in the caller's org, then ask the SAME action about its id;
//   - `cliMayActOnProject` — the same question, for a route that found the project id another way
//     (a configuration by name, a cluster by id);
//   - `cliViewableProjectIds` — the projects the caller may view, for a LIST of project-owned rows.
// This file holds the routes to that structurally, so a new route — or an edit that goes back to
// answering for the org — is red here. tests/integration/cli-project-routes-addressed.test.ts drives
// the real decisions.
//
// BOUNDARY, stated so a green is not read as more than it is:
// - HANDLERS: every `route.ts` under app/api/cli/, found by walking the directory. Each exported
//   `export async function GET|POST|PUT|PATCH|DELETE` is read as the text from that line to the next
//   such export, with comments stripped (so a helper's name in a comment does not count). Any other
//   export form for a handler (`export const GET =`, `export { x as GET }`) is red, because this
//   reader cannot see into it.
// - THE RULE: a handler that calls `authorizeCli(req, "<a>", { type: "project" })` must also call
//   `resolveCliProjectAuthorized(…, "<a>")`, `resolveByoScope(…, "<a>")` or
//   `cliMayActOnProject(…, "<a>")` with the SAME action, or — only when <a> is "view" —
//   `cliViewableProjectIds(…)`. Under app/api/cli/projects/[id]/ every handler must call that
//   `authorizeCli` at all. A handler that reached a helper only through another function in the file
//   is red (the conservative direction).
// - NOT PROVEN: that the handler returns on the helper's answer, or that a list actually filters on
//   the ids it fetched. The integration file drives that for the routes it names; every current
//   handler answers a refusal with its not-found.
// - NOT READ: a handler that authorizes some other way (an `authorizeCli` with an id, another
//   resource type, `authorizeCliOrg`). Those ask a different question and are outside this rule.
// - DIRECT RESOLUTION: every .ts file under app/ and lib/ (no tests) is read for an `import` of
//   `resolveCliProject` from @/lib/cli/resolve-project, or a namespace import of that module. Only
//   lib/cli/project-access.ts may do either, besides the files in the exemption ledger.
// - EXEMPT: a closed, handler-keyed ledger with a reason each, checked in both directions — an entry
//   whose handler no longer exists, or that now goes through a helper, is red.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const CONSOLE = resolve(__dirname, "../../../..");
const CLI_ROUTES = join(CONSOLE, "app/api/cli");
const PROJECT_ROUTES_PREFIX = "app/api/cli/projects/[id]/";
const HELPER = "lib/cli/project-access.ts";
const METHODS = "GET|POST|PUT|PATCH|DELETE";

/** Handlers ("<path> <METHOD>") that ask the org-wide project question and nothing more, and why. */
const EXEMPT: Record<string, string> = {
	"app/api/cli/projects/route.ts POST": "creates a project: there is no existing project to ask about",
	"app/api/cli/schema/addons/route.ts GET": "the static add-on catalogue: reads no project",
	"app/api/cli/schema/components/route.ts GET": "the static component catalogue: reads no project",
	"app/api/cli/projects/[id]/drift/route.ts GET":
		"changed by #6238, which asks view of the addressed project inline; moves onto the helper after it lands",
};

/** Files that may import `resolveCliProject` directly besides the helper, and why. */
const DIRECT_IMPORT_EXEMPT: Record<string, string> = {
	"app/api/cli/projects/[id]/drift/route.ts": "see EXEMPT",
};

/** The calls that answer the addressed-project question with an action argument. */
const PER_PROJECT_HELPERS = ["resolveCliProjectAuthorized", "resolveByoScope", "cliMayActOnProject"];
/** Every helper name, for "does this handler use any of them". */
const ALL_HELPERS = [...PER_PROJECT_HELPERS, "cliViewableProjectIds"];

/** Every file under `dir` whose name matches `keep`, recursively (no node_modules, no tests). */
function walk(dir: string, keep: (name: string) => boolean): string[] {
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return [];
	}
	return entries.flatMap((name) => {
		if (name === "node_modules") return [];
		const path = join(dir, name);
		if (statSync(path).isDirectory()) return walk(path, keep);
		return keep(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
	});
}

/** Console-relative paths of every route file under app/api/cli/. */
function cliRoutes(): string[] {
	return walk(CLI_ROUTES, (n) => n === "route.ts")
		.map((p) => relative(CONSOLE, p))
		.sort();
}

/** `source` without its comments. Over-strips a `//` inside a string, which can only remove a match. */
function stripComments(source: string): string {
	return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

/** The exported HTTP handlers of a route file, each as [method, body text]. */
function handlers(source: string): [string, string][] {
	const re = new RegExp(`^export async function (${METHODS})\\b`, "gm");
	const starts = [...source.matchAll(re)];
	return starts.map((m, i) => [
		m[1] ?? "",
		source.slice(m.index ?? 0, starts[i + 1]?.index ?? source.length),
	]);
}

/** True when `source` exports a handler in a form {@link handlers} cannot read. */
function hasUnreadableHandlerExport(source: string): boolean {
	return (
		new RegExp(`^export\\s+(const|let|var)\\s+(${METHODS})\\b`, "m").test(source) ||
		new RegExp(`export\\s*\\{[^}]*\\bas\\s+(${METHODS})\\b`).test(source)
	);
}

/** The action of a handler's org-wide project authorization, or null if it makes none. */
function orgWideProjectAction(body: string): string | null {
	const m = body.match(/authorizeCli\(\s*req,\s*"(\w+)",\s*\{\s*type:\s*"project"\s*\}\s*\)/);
	return m?.[1] ?? null;
}

/** Why one handler does not ask its own action about the project, or null if it does. */
function handlerFinding(body: string, action: string): string | null {
	const asked = PER_PROJECT_HELPERS.flatMap((name) =>
		[...body.matchAll(new RegExp(`\\b${name}\\([^)]*?,\\s*"(\\w+)"\\s*\\)`, "g"))].map((m) => m[1]),
	);
	const lists = /\bcliViewableProjectIds\(/.test(body);
	if (asked.length === 0 && !lists) {
		return "asks only the org-wide project question (no resolveCliProjectAuthorized / resolveByoScope / cliMayActOnProject / cliViewableProjectIds)";
	}
	const other = asked.filter((a) => a !== action);
	if (other.length > 0) {
		return `authorizes "${action}" but asks the project about ${other.map((a) => `"${a}"`).join(", ")}`;
	}
	if (lists && action !== "view") return `filters on the viewable projects but authorizes "${action}"`;
	return null;
}

/** Every handler of every CLI route: [key "<path> <METHOD>", path, comment-stripped body]. */
function allHandlers(): [string, string, string][] {
	return cliRoutes().flatMap((path) =>
		handlers(stripComments(readFileSync(join(CONSOLE, path), "utf8"))).map(
			([method, body]): [string, string, string] => [`${path} ${method}`, path, body],
		),
	);
}

/** True when `source` imports resolveCliProject itself, or the whole resolve-project module. */
function resolvesDirectly(source: string): boolean {
	const named = /import\s*(?:type\s*)?\{[^}]*\bresolveCliProject\b[^}]*\}\s*from\s*"@\/lib\/cli\/resolve-project"/;
	const namespace = /import\s*\*\s*as\s+\w+\s+from\s*"@\/lib\/cli\/resolve-project"/;
	return named.test(source) || namespace.test(source);
}

describe("CLI project routes ask about the addressed project", () => {
	it("scans for the helpers the modules really export", async () => {
		// A rename would otherwise leave the scan matching nothing and this file guarding a name.
		const mod = await import("@/lib/cli/project-access");
		expect(typeof mod.resolveCliProjectAuthorized).toBe("function");
		expect(typeof mod.cliMayActOnProject).toBe("function");
		expect(typeof mod.cliViewableProjectIds).toBe("function");
		const byo = await import("@/lib/cli/byo-write");
		expect(typeof byo.resolveByoScope).toBe("function");
	});

	it("finds the routes and their handlers (a walk that read nothing cannot pass)", () => {
		const keys = allHandlers().map(([key]) => key);
		expect(keys).toEqual(
			expect.arrayContaining([
				"app/api/cli/projects/[id]/cost/route.ts GET",
				"app/api/cli/projects/[id]/environments/route.ts POST",
				"app/api/cli/configurations/[name]/route.ts GET",
				"app/api/cli/clusters/[id]/route.ts GET",
				"app/api/cli/clusters/route.ts GET",
			]),
		);
	});

	it("every route exports its handlers in the one form this file can read", () => {
		const unreadable = cliRoutes().filter((path) =>
			hasUnreadableHandlerExport(stripComments(readFileSync(join(CONSOLE, path), "utf8"))),
		);
		expect(unreadable).toEqual([]);
	});

	it("every handler under projects/[id]/ makes the org-wide project authorization the rule reads", () => {
		const missing = allHandlers()
			.filter(([key, path, body]) => path.startsWith(PROJECT_ROUTES_PREFIX) && !(key in EXEMPT) && orgWideProjectAction(body) === null)
			.map(([key]) => key);
		expect(missing).toEqual([]);
	});

	it("every non-exempt handler that asks the org-wide project question also asks about the project", () => {
		const findings = allHandlers().flatMap(([key, , body]) => {
			if (key in EXEMPT) return [];
			const action = orgWideProjectAction(body);
			if (action === null) return [];
			const finding = handlerFinding(body, action);
			return finding ? [`${key}: ${finding}`] : [];
		});
		expect(findings).toEqual([]);
	});

	it("no production file resolves a project directly except the helper (and its ledger)", () => {
		const offenders = ["app", "lib"]
			.flatMap((d) => walk(join(CONSOLE, d), (n) => /\.tsx?$/.test(n)))
			.filter((path) => resolvesDirectly(readFileSync(path, "utf8")))
			.map((path) => relative(CONSOLE, path))
			.sort();
		expect(offenders).toEqual([HELPER, ...Object.keys(DIRECT_IMPORT_EXEMPT)].sort());
	});

	it("the exemption ledgers hold only live entries", () => {
		const byKey = new Map(allHandlers().map(([key, , body]) => [key, body]));
		for (const key of Object.keys(EXEMPT)) {
			const body = byKey.get(key);
			expect(body, `${key} is exempt but no such handler exists`).toBeDefined();
			expect(
				ALL_HELPERS.some((name) => body?.includes(`${name}(`)),
				`${key} now goes through a helper — delete its exemption`,
			).toBe(false);
		}
		for (const path of Object.keys(DIRECT_IMPORT_EXEMPT)) {
			expect(cliRoutes(), `${path} is exempt but no longer exists`).toContain(path);
		}
	});
});
