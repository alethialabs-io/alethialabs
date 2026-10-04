// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The claim src/index.ts makes — that it is the only copy of the org-slug pattern — and what
// enforces it. #5509 found two drifted copies: the console's paid-setup schema (`*` for `+`) and the
// staff app's create flow (a 64-character cap against the console's 63). This reads the source of
// both apps and of every package for the pattern's text, so a new copy fails here.
//
// Its bound: it matches the pattern's EXACT source text in .ts/.tsx files under apps/console and
// apps/admin (app/, components/, lib/) and under packages/*/src. A copy re-spelled differently
// (another group, `[0-9a-z]`) is not seen, and neither is one in a test file or a script.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

import { ORG_SLUG_PATTERN } from "../src/index";

const repoRoot = join(__dirname, "..", "..", "..");
const home = join("packages", "org-slug", "src", "index.ts");

/** Every .ts/.tsx file under `dir`, recursively, skipping node_modules (none when `dir` is absent). */
function sources(dir: string): string[] {
	if (!existsSync(dir)) return [];
	return readdirSync(dir).flatMap((name) => {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) return name === "node_modules" ? [] : sources(path);
		return /\.tsx?$/.test(name) ? [path] : [];
	});
}

/** The directories scanned: both apps' source roots, and every package's src/. */
function scannedDirs(): string[] {
	const apps = ["console", "admin"].flatMap((app) =>
		["app", "components", "lib"].map((d) => join(repoRoot, "apps", app, d)),
	);
	const packages = readdirSync(join(repoRoot, "packages")).map((p) => join(repoRoot, "packages", p, "src"));
	return [...apps, ...packages];
}

describe("the org-slug pattern has one copy", () => {
	it("scans real directories in both apps (a renamed root would scan nothing and pass)", () => {
		for (const app of ["console", "admin"]) {
			expect(sources(join(repoRoot, "apps", app, "app")).length).toBeGreaterThan(0);
		}
	});

	it("appears only in packages/org-slug/src/index.ts", () => {
		const text = ORG_SLUG_PATTERN.source;
		const copies = scannedDirs()
			.flatMap(sources)
			.filter((path) => readFileSync(path, "utf8").includes(text))
			.map((path) => relative(repoRoot, path));
		expect(copies).toEqual([home]);
	});
});
