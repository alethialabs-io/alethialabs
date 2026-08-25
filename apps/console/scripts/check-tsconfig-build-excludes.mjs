// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// tsconfig.build.json exclude-list drift guard.
//
// `next build` type-checks against tsconfig.build.json (wired via `typescript.tsconfigPath` in
// next.config.ts), and its exclude list is what keeps un-shipped files out of the PRODUCTION
// IMAGE's type-check program. That matters because the image installs a pruned closure
// (`Dockerfile:23` --filter console... --filter @alethia/ee; `Dockerfile.community:15` narrower
// still, no @alethia/ee), while CI type-checks after an unfiltered install. A file in the program
// but not in the shipped closure is green in CI and fatal in the image — the TS2307 that broke
// every production deploy for 26 days (#2521, #2523).
//
// The config-file entries are a HAND-MAINTAINED ENUMERATION, not a glob: `exclude` has no
// negation and `*.config.ts` would swallow next.config.ts, which Next must load to perform the
// build. An enumeration nobody checks is a guard that reports green — add vitest.browser.config.ts
// tomorrow and it silently re-enters the program while the comment above the list still reads like
// a pattern. This is the check that makes the list keep its promise.
//
// Lives here rather than in tests/ deliberately: it asserts on a config file, imports no System
// Under Test, and `check:no-vacuous-tests` rightly refuses a vitest file that imports nothing.
// Run from apps/console (the `check:tsconfig-build` script): cwd is apps/console.

import { readdirSync, readFileSync } from "node:fs";

const CONFIG = "tsconfig.build.json";

/**
 * Parse JSONC by stripping WHOLE-LINE `//` comments only.
 *
 * Deliberately NOT a `/* … *␀/` block stripper, which is the obvious general solution and is
 * actively wrong here: the exclude list contains `**␀/*.test.ts`, whose `/` + `*` opens a block
 * comment as far as such a regex is concerned. It would swallow the glob and everything up to the
 * next `*␀/`, silently shortening the parsed list — so the guard would assert against a config
 * that does not exist and report failures for a correct file. Every comment in tsconfig.build.json
 * is a whole-line `//`; a block comment added there makes this throw rather than mis-read.
 */
function readJsonc(path) {
	return JSON.parse(readFileSync(path, "utf8").replace(/^\s*\/\/.*$/gm, ""));
}

const cfg = readJsonc(CONFIG);
const exclude = cfg.exclude ?? [];
const failures = [];

const rootConfigs = readdirSync(".").filter((f) => f.endsWith(".config.ts"));

// Non-vacuity: if this glob ever stops matching, the guard would pass by finding nothing to
// check. The console has carried several root config files for a long time.
if (rootConfigs.length < 2) {
	console.error(`✗ ${CONFIG}: found ${rootConfigs.length} root *.config.ts — the guard cannot be vacuous, check the cwd.`);
	process.exit(1);
}
if (!rootConfigs.includes("next.config.ts")) {
	console.error(`✗ ${CONFIG}: next.config.ts not found at the app root — the guard cannot be vacuous, check the cwd.`);
	process.exit(1);
}

const missing = rootConfigs.filter((f) => f !== "next.config.ts" && !exclude.includes(f));
if (missing.length > 0) {
	failures.push(
		`root config file(s) NOT excluded, so \`next build\` type-checks them inside the pruned ` +
			`image closure: ${missing.join(", ")}`,
	);
}

if (exclude.includes("next.config.ts")) {
	failures.push("next.config.ts is excluded — Next loads it to perform the build, so it must stay in.");
}

// `tests/` alone left nine CO-LOCATED *.test.ts under lib/cloud-providers/capabilities/ in the
// program. Next's ignore regex does not cover the fallout: it filters diagnostics ATTRIBUTED TO a
// *.test.ts file, while a co-located test importing a sibling app raises TS2307 in the IMPORTED
// file, which is unfiltered and fatal to `next build`.
for (const glob of ["**/*.test.ts", "**/*.test.tsx"]) {
	if (!exclude.includes(glob)) {
		failures.push(`\`${glob}\` is missing — co-located tests would re-enter the build's type-check program.`);
	}
}

if (failures.length > 0) {
	console.error(`✗ ${CONFIG} exclude list has drifted:`);
	for (const f of failures) console.error(`  ✗ ${f}`);
	console.error(
		`\nFix: add the file(s) to "exclude" in apps/console/${CONFIG}. See the comment block at the ` +
			`top of that file for why the list is an enumeration rather than a glob.`,
	);
	process.exit(1);
}

console.log(
	`✓ ${CONFIG} exclude list — ${rootConfigs.length - 1} root config file(s) excluded, ` +
		`next.config.ts retained, co-located test globs present.`,
);
