// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// #5670: `authorizeCliQuiet` makes `authorizeCli`'s decision WITHOUT recording it, which is right for
// exactly one request — the kubeconfig mint poll, which waits on a mint whose start was recorded. On
// any route that DOES something it would silently drop that action from the org's activity log and
// from its alert rules, and nothing about the call would look wrong. So its production users are a
// closed list, and this file is the list: adding a caller, or the poll route dropping it, is red here
// and has to be argued in a diff.
//
// BOUNDARY, stated so a green is not read as more than it is:
// - It reads every .ts/.tsx file under apps/console/{app,lib,components,hooks} and ee/src, skipping
//   node_modules and *.test.* files. Production code anywhere else in the repo is not read.
// - It matches the IDENTIFIER `authorizeCliQuiet` anywhere in a file — not only an `import` line — so
//   a namespace import (`guard.authorizeCliQuiet`), a re-export, and a destructure all count. A caller
//   that reached it WITHOUT spelling the name (e.g. `guard[name]` built from a string) is not seen.
// - lib/authz/guard.ts, which defines it, is the one expected non-caller; the walk must find that
//   definition, so a walk that read nothing cannot pass.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const CONSOLE = resolve(__dirname, "../../..");
const REPO = resolve(CONSOLE, "../..");
const ROOTS = ["app", "lib", "components", "hooks"].map((d) => join(CONSOLE, d)).concat(join(REPO, "ee/src"));
const DEFINITION = "apps/console/lib/authz/guard.ts";
const ALLOWED = ["apps/console/app/api/cli/clusters/[id]/kubeconfig/[mintId]/route.ts"];

/** Every production .ts/.tsx file under `dir`, recursively (no node_modules, no tests). */
function sources(dir: string): string[] {
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return [];
	}
	return entries.flatMap((name) => {
		if (name === "node_modules") return [];
		const path = join(dir, name);
		if (statSync(path).isDirectory()) return sources(path);
		return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
	});
}

/** Repo-relative paths of the production files that name `authorizeCliQuiet`. */
function namers(): string[] {
	return ROOTS.flatMap(sources)
		.filter((path) => /\bauthorizeCliQuiet\b/.test(readFileSync(path, "utf8")))
		.map((path) => relative(REPO, path))
		.sort();
}

describe("authorizeCliQuiet's production callers are exactly the kubeconfig mint poll (#5670)", () => {
	it("scans for the name the guard really exports", async () => {
		// The identifier this file greps for must be the real export, or a rename would leave the scan
		// matching nothing and the closed list guarding a function that no longer exists.
		const guard = await import("@/lib/authz/guard");
		expect(typeof guard.authorizeCliQuiet).toBe("function");
	});

	it("is named by its definition and the mint poll route, and by nothing else", () => {
		expect(namers()).toEqual([...ALLOWED, DEFINITION].sort());
	});
});
