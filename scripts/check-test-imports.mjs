// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Anti-"bullshit-test" guard. A unit/component/action test that NEVER imports a real source module
// (`@/…`, `@repo/…`, or a relative `./…`/`../…` path) cannot be testing real code — it's asserting
// on inline re-implementations or JS built-ins (the exact pattern of the 5 vacuous tests we found:
// they imported only `vitest`). Such files are flagged here and in CI. Mutation testing is the deep
// check; this is the cheap, instant tripwire.
//
// Usage: node scripts/check-test-imports.mjs   (exits 1 if any offender is found)

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOTS = [
	"apps/console/tests",
	"packages/ui/tests",
	"packages/plan-catalog/tests",
];

/** Recursively collect *.test.ts/tsx files under a dir. */
function testFiles(dir) {
	let out = [];
	let entries;
	try {
		entries = readdirSync(dir);
	} catch {
		return out;
	}
	for (const name of entries) {
		const p = join(dir, name);
		if (statSync(p).isDirectory()) out = out.concat(testFiles(p));
		else if (/\.test\.tsx?$/.test(name)) out.push(p);
	}
	return out;
}

// A test must reference at least one real source module: a static `from "X"` or a dynamic
// `import("X")` whose specifier is `@/…`, `@repo/…`, or relative (`.`).
const SPECIFIER_RE = /(?:from\s*|import\s*\(\s*)["'`]([^"'`]+)["'`]/g;
const isSource = (s) => s.startsWith("@/") || s.startsWith("@repo/") || s.startsWith(".");

const offenders = [];
for (const root of ROOTS) {
	for (const file of testFiles(root)) {
		const src = readFileSync(file, "utf8");
		const specs = [...src.matchAll(SPECIFIER_RE)].map((m) => m[1]);
		if (!specs.some(isSource)) offenders.push(file);
	}
}

if (offenders.length > 0) {
	console.error(
		`✗ ${offenders.length} test file(s) import no real source module (likely vacuous — they test inline re-implementations or built-ins):`,
	);
	for (const f of offenders) console.error(`   ${f}`);
	console.error(
		"\nA real test must import the System Under Test from @/…, @repo/…, or a relative path.",
	);
	process.exit(1);
}

console.log("✓ check-test-imports: every test file imports a real source module.");
