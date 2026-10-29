// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The release-notes popover is imported by the jobs table, the job detail and the runners page,
// but its markdown renderer (streamdown and its unified pipeline, ~150 KB gzip) is needed only once
// someone opens a popover. #5849 took streamdown out of first hydration because evaluating it lost
// filter-bar clicks, so these routes must reach it only through a dynamic `import()`.
//
// This walks the STATIC import graph from each route's entry files, following console-local
// specifiers (`@/…` and relative), and fails if it reaches a `streamdown`/`@streamdown/*` specifier
// or the renderer module itself. Bounds, stated: `import type` is skipped (erased at build), and
// workspace packages (`@repo/*`) and npm packages are not entered, only named. A dynamic `import()`
// is not followed: that is the point.

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

// The runtime half: evaluating the popover module must not evaluate streamdown. The mock factory
// runs only when something imports "streamdown", so the flag records whether anything did.
const streamdownEvaluated = vi.hoisted(() => ({ value: false }));
vi.mock("streamdown", () => {
	streamdownEvaluated.value = true;
	return { defaultRehypePlugins: {}, Streamdown: () => null };
});
vi.mock("@/app/server/actions/runners", () => ({ getReleaseNotes: vi.fn() }));
vi.mock("@/lib/query/use-runners-query", () => ({
	useUpdateRunner: () => ({ mutateAsync: vi.fn() }),
}));

const ROOT = path.resolve(__dirname, "../../..");
const RENDERER = path.join(ROOT, "components/runners/release-notes-markdown.tsx");

/** Static `import … from "x"`, `export … from "x"` and bare `import "x"`; never `import type`. */
const STATIC_IMPORT =
	/^\s*(?:import|export)\s+(?!type\s)(?:[^"';]*?\sfrom\s+)?["']([^"']+)["']/gm;

/** Resolves a console-local specifier to a file, or null for a package. */
function resolveLocal(spec: string, from: string): string | null {
	let base: string;
	if (spec.startsWith("@/")) base = path.join(ROOT, spec.slice(2));
	else if (spec.startsWith(".")) base = path.resolve(path.dirname(from), spec);
	else return null;
	const candidates = [
		base,
		`${base}.ts`,
		`${base}.tsx`,
		path.join(base, "index.ts"),
		path.join(base, "index.tsx"),
	];
	return candidates.find((c) => fs.existsSync(c) && fs.statSync(c).isFile()) ?? null;
}

/** Walks the static graph from `entries`; returns every package specifier and every file seen. */
function walk(entries: string[]) {
	const seen = new Set<string>();
	const packages = new Map<string, string>();
	const queue = [...entries];
	while (queue.length > 0) {
		const file = queue.pop();
		if (file === undefined || seen.has(file)) continue;
		seen.add(file);
		const source = fs.readFileSync(file, "utf8");
		for (const match of source.matchAll(STATIC_IMPORT)) {
			const spec = match[1];
			const local = resolveLocal(spec, file);
			if (local) queue.push(local);
			else if (!spec.startsWith("@/") && !spec.startsWith(".")) packages.set(spec, file);
		}
	}
	return { seen, packages };
}

const ROUTES = {
	"/~/jobs": ["app/(private)/[org]/~/jobs/(list)/page.tsx", "app/(private)/[org]/~/jobs/jobs-client.tsx"],
	"/~/jobs/[id]": [
		"app/(private)/[org]/~/jobs/[id]/page.tsx",
		"app/(private)/[org]/~/jobs/[id]/layout.tsx",
	],
	"/~/runners": [
		"app/(private)/[org]/~/runners/page.tsx",
		"app/(private)/[org]/~/runners/runners-client.tsx",
	],
};

describe("release-notes renderer stays out of first hydration", () => {
	it("evaluating the popover module does not evaluate streamdown; the renderer module does", async () => {
		await import("@/components/runners/release-notes-popover");
		expect(streamdownEvaluated.value).toBe(false);
		await import("@/components/runners/release-notes-markdown");
		expect(streamdownEvaluated.value).toBe(true);
	});

	it("the walker can see a static streamdown import (the instrument is live)", () => {
		const { packages } = walk([RENDERER]);
		expect(packages.has("streamdown")).toBe(true);
	});

	it("the popover is on each route's static graph (so the next assertion means something)", () => {
		const popover = path.join(ROOT, "components/runners/release-notes-popover.tsx");
		for (const entries of Object.values(ROUTES)) {
			const { seen } = walk(entries.map((e) => path.join(ROOT, e)));
			expect(seen.has(popover)).toBe(true);
		}
	});

	for (const [route, entries] of Object.entries(ROUTES)) {
		it(`${route} reaches neither streamdown nor the renderer module statically`, () => {
			const { seen, packages } = walk(entries.map((e) => path.join(ROOT, e)));
			expect(seen.has(RENDERER)).toBe(false);
			const markdown = [...packages].filter(
				([spec]) => spec === "streamdown" || spec.startsWith("@streamdown/"),
			);
			expect(markdown).toEqual([]);
		});
	}
});
