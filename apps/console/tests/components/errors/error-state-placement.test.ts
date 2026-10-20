// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// `ErrorState` is for ROUTES; a failed data region is `RegionError` (#6117).
//
// `ErrorState` renders the route's heading. It belongs in `error.tsx` / `global-error.tsx` /
// `not-found.tsx`, which replace the page. Rendered for a failed query inside a page it drew a
// second `<h1>` under the breadcrumb and looked unlike every other region's error. Seven region
// sites were moved to `RegionError`; this keeps an eighth from appearing.
//
// The exception ledger fails in BOTH directions: a site listed here that no longer uses
// `ErrorState` is itself a failure, so the list cannot outlive what it excuses.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const CONSOLE = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const ROOTS = ["app", "components"];
const ROUTE_FILES = new Set(["error.tsx", "global-error.tsx", "not-found.tsx"]);
const IMPORT = /from\s+["']@\/components\/errors\/error-state["']/;

/**
 * Region sites still on `ErrorState`, each owned by the page lane that converts it. Keyed by path
 * relative to apps/console.
 */
const OWED: Record<string, string> = {
	// In #6113's claimed scope at the time of #6117, so not touched there; #6121 (jobs) converts it.
	"app/(private)/[org]/~/jobs/jobs-client.tsx": "#6121",
};

/** Every .tsx file under `dir`, recursively. */
function walk(dir: string): string[] {
	const out: string[] = [];
	for (const name of readdirSync(dir)) {
		const p = join(dir, name);
		if (statSync(p).isDirectory()) out.push(...walk(p));
		else if (p.endsWith(".tsx")) out.push(p);
	}
	return out;
}

/** Console-relative paths of the files that import `ErrorState`. */
function importers(): string[] {
	return ROOTS.flatMap((r) => walk(join(CONSOLE, r)))
		.filter((f) => IMPORT.test(readFileSync(f, "utf8")))
		.map((f) => relative(CONSOLE, f));
}

describe("ErrorState placement", () => {
	const found = importers();

	it("finds the route boundaries, so an empty walk cannot pass", () => {
		expect(found.filter((f) => ROUTE_FILES.has(basename(f))).length).toBeGreaterThan(3);
	});

	it("is imported only by route boundaries and the owed sites", () => {
		const regions = found.filter((f) => !ROUTE_FILES.has(basename(f)) && !(f in OWED));
		expect(regions).toEqual([]);
	});

	it("lists no owed site that has already been converted", () => {
		const stale = Object.keys(OWED).filter((f) => !found.includes(f));
		expect(stale).toEqual([]);
	});
});
