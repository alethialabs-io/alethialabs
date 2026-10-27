// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// Every CLI route that addresses ONE project asks its permission about THAT project.
//
// `authorizeCli(req, action, { type: "project" })` runs before a route knows which project it is
// about, so it answers for the org. The second half is `resolveCliProjectAuthorized` (or
// `resolveByoScope`, which calls it): resolve the project in the caller's org, then ask the SAME
// action about its id. This file holds the routes to that structurally, so a new route — or an
// edit that goes back to resolving the project directly — is red here rather than quietly
// answering for the org. tests/integration/cli-project-routes-addressed.test.ts drives the real
// decision for one read and one write.
//
// BOUNDARY, stated so a green is not read as more than it is:
// - ROUTES: every `route.ts` under app/api/cli/projects/[id]/, found by walking the directory — not
//   a hand-written list. Each exported GET/POST/PUT/PATCH/DELETE handler is read as the text from
//   its `export async function` to the next one. Within it there must be an
//   `authorizeCli(req, "<action>", { type: "project" })` AND a `resolveCliProjectAuthorized(…, "<action>")`
//   or `resolveByoScope(…, "<action>")` naming the SAME action. A handler that reached the helper
//   only through another function in the file is red (the conservative direction). What this does
//   NOT prove: that the handler returns on the helper's null — the integration file does that for
//   the two routes it drives, and every current handler answers it with the same 404.
// - DIRECT RESOLUTION: every .ts file under app/ and lib/ (no tests) is read for an `import` of
//   `resolveCliProject` from @/lib/cli/resolve-project, or a namespace import of that module. Only
//   lib/cli/project-access.ts (the helper) may do either. A caller that reached it without importing
//   it by name — a re-export under another name — is not seen.
// - EXEMPT: a closed ledger, checked in both directions — an exempt file must exist and must NOT
//   already go through the helper, so an entry that outlived its reason is red too.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const CONSOLE = resolve(__dirname, "../../../..");
const PROJECT_ROUTES = join(CONSOLE, "app/api/cli/projects/[id]");
const HELPER = "lib/cli/project-access.ts";

/** Routes that answer the addressed-project question some other way, and why. Closed. */
const EXEMPT: Record<string, string> = {
	"app/api/cli/projects/[id]/drift/route.ts":
		"asks view of the addressed project inline (#6238); move it onto the helper once that lands",
};

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

/** Console-relative paths of every route file under app/api/cli/projects/[id]/. */
function projectRoutes(): string[] {
	return walk(PROJECT_ROUTES, (n) => n === "route.ts")
		.map((p) => relative(CONSOLE, p))
		.sort();
}

/** The exported HTTP handlers of a route file, each as [method, body text]. */
function handlers(source: string): [string, string][] {
	const re = /^export async function (GET|POST|PUT|PATCH|DELETE)\b/gm;
	const starts = [...source.matchAll(re)];
	return starts.map((m, i) => [
		m[1] ?? "",
		source.slice(m.index ?? 0, starts[i + 1]?.index ?? source.length),
	]);
}

/** Why one handler does not ask its own action about the addressed project, or null if it does. */
function handlerFinding(body: string): string | null {
	const auth = body.match(/authorizeCli\(\s*req,\s*"(\w+)",\s*\{\s*type:\s*"project"\s*\}\s*\)/);
	if (!auth) return 'no authorizeCli(req, "<action>", { type: "project" })';
	const action = auth[1];
	const asked = [
		...body.matchAll(/resolveCliProjectAuthorized\([^)]*?,\s*"(\w+)"\s*\)/g),
		...body.matchAll(/resolveByoScope\([^)]*?,\s*"(\w+)"\s*\)/g),
	].map((m) => m[1]);
	if (asked.length === 0) return "does not resolve the project through resolveCliProjectAuthorized / resolveByoScope";
	const other = asked.filter((a) => a !== action);
	if (other.length > 0) return `authorizes "${action}" but asks the project about ${other.map((a) => `"${a}"`).join(", ")}`;
	return null;
}

/** True when `source` imports resolveCliProject itself, or the whole resolve-project module. */
function resolvesDirectly(source: string): boolean {
	const named = /import\s*(?:type\s*)?\{[^}]*\bresolveCliProject\b[^}]*\}\s*from\s*"@\/lib\/cli\/resolve-project"/;
	const namespace = /import\s*\*\s*as\s+\w+\s+from\s*"@\/lib\/cli\/resolve-project"/;
	return named.test(source) || namespace.test(source);
}

describe("CLI project routes ask about the addressed project", () => {
	it("scans for the helper the module really exports", async () => {
		// A rename would otherwise leave the scan matching nothing and this file guarding a name.
		const mod = await import("@/lib/cli/project-access");
		expect(typeof mod.resolveCliProjectAuthorized).toBe("function");
		const byo = await import("@/lib/cli/byo-write");
		expect(typeof byo.resolveByoScope).toBe("function");
	});

	it("finds the routes (a walk that read nothing cannot pass)", () => {
		const routes = projectRoutes();
		expect(routes).toEqual(
			expect.arrayContaining([
				"app/api/cli/projects/[id]/cost/route.ts",
				"app/api/cli/projects/[id]/environments/route.ts",
			]),
		);
	});

	it("every handler of every non-exempt route asks its own action about the resolved project", () => {
		const findings = projectRoutes()
			.filter((path) => !(path in EXEMPT))
			.flatMap((path) => {
				const source = readFileSync(join(CONSOLE, path), "utf8");
				const hs = handlers(source);
				if (hs.length === 0) return [`${path}: no exported handler found`];
				return hs.flatMap(([method, body]) => {
					const finding = handlerFinding(body);
					return finding ? [`${path} ${method}: ${finding}`] : [];
				});
			});
		expect(findings).toEqual([]);
	});

	it("no production file resolves a project directly except the helper (and the exempt ledger)", () => {
		const offenders = ["app", "lib"]
			.flatMap((d) => walk(join(CONSOLE, d), (n) => /\.tsx?$/.test(n)))
			.filter((path) => resolvesDirectly(readFileSync(path, "utf8")))
			.map((path) => relative(CONSOLE, path))
			.sort();
		expect(offenders).toEqual([HELPER, ...Object.keys(EXEMPT)].sort());
	});

	it("the exempt ledger holds only live entries", () => {
		const routes = projectRoutes();
		for (const path of Object.keys(EXEMPT)) {
			expect(routes, `${path} is exempt but no longer exists`).toContain(path);
			const source = readFileSync(join(CONSOLE, path), "utf8");
			expect(
				/resolveCliProjectAuthorized|resolveByoScope/.test(source),
				`${path} now goes through the helper — delete its exemption`,
			).toBe(false);
		}
	});
});
