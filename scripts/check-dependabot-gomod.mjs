#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
//
// EVERY go.work MODULE GETS DEPENDABOT VERSION UPDATES (#5948).
//
// `.github/dependabot.yml`'s gomod entry listed /apps/cli, /apps/runner and /packages/core, and left
// out /test/e2e — the fourth go.work module, which `replace`s packages/core with ../../packages/core.
// A grouped Go bump that moved core's requirements therefore left test/e2e/go.mod untidy, CI's
// GOWORK=off tidy check went red, and a maintainer had to hand-push a tidy (#5612, #5877).
//
// This holds the two lists against each other: every `use` entry in go.work must appear in the
// gomod `directories` list. Extra Dependabot directories are not an error — a module may be bumped
// without being in the workspace — only a workspace module Dependabot never visits is.
//
// ── WHAT IT READS, AND HOW ───────────────────────────────────────────────────────────────────────
//
// There is no YAML library in a de-hydrated worktree, so dependabot.yml is read by a small reader
// that knows exactly one shape: an `updates:` list item `- package-ecosystem: gomod`, and under it a
// `directories:` key whose value is a block list of `- /path` lines. Comments and blank lines inside
// the list are skipped. Anything else — no gomod entry, a `directory:` (singular) key, a flow list
// `[...]`, or an empty list — is a REFUSAL (exit 1), not an empty result: a reader that cannot find
// the list must not report that no module is missing from it.
//
// go.work is read the same way: the `use (` … `)` block, plus single-line `use ./x` directives, with
// `//` comments stripped. A go.work with no `use` entries is also a refusal.
//
// Usage:
//   node scripts/check-dependabot-gomod.mjs --self-test   # hermetic fixtures + mutation controls
//   node scripts/check-dependabot-gomod.mjs               # live: reads go.work and dependabot.yml

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const GO_WORK = "go.work";
const DEPENDABOT = ".github/dependabot.yml";

/**
 * Normalises a module path to Dependabot's form: leading `/`, no `./`, no trailing `/`.
 *
 * @param {string} p a path such as `./test/e2e` or `/test/e2e/`
 * @returns {string} e.g. `/test/e2e`
 */
export function normalise(p) {
	const bare = p.trim().replace(/^\.\//, "").replace(/^\/+/, "").replace(/\/+$/, "");
	return `/${bare}`;
}

/**
 * The module directories go.work `use`s.
 *
 * @param {string} text contents of go.work
 * @returns {string[]} normalised directories, in file order
 * @throws when no `use` entry is found
 */
export function goWorkModules(text) {
	const lines = text.split("\n").map((l) => l.replace(/\/\/.*$/, "").trim());
	const out = [];
	let inBlock = false;
	for (const line of lines) {
		if (inBlock) {
			if (line === ")") {
				inBlock = false;
				continue;
			}
			if (line) out.push(normalise(line));
			continue;
		}
		if (/^use\s*\($/.test(line)) {
			inBlock = true;
			continue;
		}
		const single = /^use\s+(\S+)$/.exec(line);
		if (single) out.push(normalise(single[1]));
	}
	if (inBlock) throw new Error(`${GO_WORK}: a \`use (\` block is never closed`);
	if (out.length === 0) throw new Error(`${GO_WORK}: no \`use\` entries found`);
	return out;
}

/**
 * The `directories` list of dependabot.yml's gomod update entry.
 *
 * @param {string} text contents of .github/dependabot.yml
 * @returns {string[]} normalised directories, in file order
 * @throws when the gomod entry or its block-list `directories` cannot be found, or it is empty
 */
export function dependabotGomodDirs(text) {
	const lines = text.split("\n");
	const start = lines.findIndex((l) => /^\s*-\s+package-ecosystem:\s*["']?gomod["']?\s*$/.test(l));
	if (start === -1) throw new Error(`${DEPENDABOT}: no \`- package-ecosystem: gomod\` entry`);
	const itemIndent = lines[start].indexOf("-");
	// The entry runs until the next list item at the same indent (or less).
	let end = lines.length;
	for (let i = start + 1; i < lines.length; i += 1) {
		const l = lines[i];
		if (!l.trim() || l.trim().startsWith("#")) continue;
		const indent = l.length - l.trimStart().length;
		if (indent <= itemIndent) {
			end = i;
			break;
		}
	}
	const entry = lines.slice(start + 1, end);
	const key = entry.findIndex((l) => /^\s*directories:\s*$/.test(l));
	if (key === -1) {
		throw new Error(
			`${DEPENDABOT}: the gomod entry has no block-list \`directories:\` key (a singular ` +
				`\`directory:\` or a flow list is a shape this reader does not know — refusing rather ` +
				`than reporting nothing missing)`,
		);
	}
	const keyIndent = entry[key].length - entry[key].trimStart().length;
	const out = [];
	for (let i = key + 1; i < entry.length; i += 1) {
		const l = entry[i];
		const t = l.trim();
		if (!t || t.startsWith("#")) continue;
		const indent = l.length - l.trimStart().length;
		const item = /^-\s+["']?([^"'#\s]+)["']?\s*(#.*)?$/.exec(t);
		// The list ends at the first line that is not a `- item` at or below the key's indent.
		if (indent < keyIndent || !item) break;
		out.push(normalise(item[1]));
	}
	if (out.length === 0) throw new Error(`${DEPENDABOT}: the gomod \`directories\` list is empty`);
	return out;
}

/**
 * The go.work modules Dependabot's gomod entry does not visit.
 *
 * @param {string} goWork contents of go.work
 * @param {string} dependabot contents of .github/dependabot.yml
 * @returns {string[]} missing directories, in go.work order
 */
export function missingModules(goWork, dependabot) {
	const dirs = new Set(dependabotGomodDirs(dependabot));
	return goWorkModules(goWork).filter((m) => !dirs.has(m));
}

/**
 * Hermetic fixtures with mutation controls; the exit code is the result.
 *
 * @returns {boolean} true when every case passed
 */
function selfTest() {
	let fails = 0;
	/** @param {string} name @param {boolean} cond @param {string} [detail] */
	const ok = (name, cond, detail) => {
		if (cond) {
			console.log(`ok   ${name}`);
			return;
		}
		fails += 1;
		console.error(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
	};
	/** @param {() => unknown} fn @returns {boolean} whether fn threw */
	const throws = (fn) => {
		try {
			fn();
			return false;
		} catch {
			return true;
		}
	};

	const work = [
		"go 1.27.1",
		"",
		"use (",
		"\t./apps/cli",
		"\t./packages/core",
		"\t// a comment line inside the block",
		"\t./test/e2e",
		")",
		"",
	].join("\n");
	const bot = (dirs) =>
		[
			"version: 2",
			"updates:",
			"  - package-ecosystem: npm",
			"    directories:",
			"      - /",
			"      - /test/e2e",
			"  - package-ecosystem: gomod",
			"    directories:",
			// A fixture entry that is a comment or blank is written as that raw line, not as an item.
			...dirs.map((d) => (d === "" || d.startsWith("#") ? (d ? `      ${d}` : "") : `      - ${d}`)),
			"    target-branch: dev",
			"  - package-ecosystem: github-actions",
			"    directory: /test/e2e",
			"",
		].join("\n");

	ok(
		"go.work's block entries are read, comments skipped",
		goWorkModules(work).join() === "/apps/cli,/packages/core,/test/e2e",
	);
	ok("a single-line `use ./x` is read", goWorkModules("go 1.27\nuse ./a\n").join() === "/a");
	ok("a go.work with no `use` REFUSES", throws(() => goWorkModules("go 1.27\n")));
	ok("an unclosed `use (` REFUSES", throws(() => goWorkModules("use (\n./a\n")));

	ok(
		"every module listed — nothing missing",
		missingModules(work, bot(["/apps/cli", "/packages/core", "/test/e2e"])).length === 0,
	);
	// THE DEFECT, as it stood: /test/e2e absent from gomod. The npm and github-actions entries in the
	// fixture both name /test/e2e, so a reader that is not scoped to the gomod entry passes this.
	const missing = missingModules(work, bot(["/apps/cli", "/packages/core"]));
	ok(
		"MUTATION: dropping /test/e2e from gomod is caught, other ecosystems' entries notwithstanding",
		missing.join() === "/test/e2e",
		`got [${missing.join()}]`,
	);
	ok(
		"comments and blank lines inside the list are skipped",
		missingModules(
			work,
			bot(["/apps/cli", "# a comment", "/packages/core", "", "/test/e2e"]),
		).length === 0,
	);
	ok(
		"an extra Dependabot directory is not an error",
		missingModules(work, bot(["/apps/cli", "/packages/core", "/test/e2e", "/tools"])).length === 0,
	);
	ok("no gomod entry REFUSES", throws(() => dependabotGomodDirs("updates:\n  - package-ecosystem: npm\n")));
	ok(
		"a singular `directory:` REFUSES rather than reporting nothing missing",
		throws(() =>
			dependabotGomodDirs("updates:\n  - package-ecosystem: gomod\n    directory: /\n"),
		),
	);
	ok(
		"an empty `directories:` REFUSES",
		throws(() =>
			dependabotGomodDirs(
				"updates:\n  - package-ecosystem: gomod\n    directories:\n    target-branch: dev\n",
			),
		),
	);

	console.log(
		fails === 0
			? "\ncheck-dependabot-gomod self-test: all passed"
			: `\ncheck-dependabot-gomod self-test: ${fails} FAILED`,
	);
	return fails === 0;
}

/** Live run against the repository's go.work and dependabot.yml. */
function main() {
	const argv = process.argv.slice(2);
	if (argv.includes("--self-test")) process.exit(selfTest() ? 0 : 1);
	if (argv.length > 0) {
		console.error(`::error::check-dependabot-gomod: unknown argument(s): ${argv.join(" ")}`);
		process.exit(2);
	}
	let missing;
	let modules;
	try {
		const goWork = readFileSync(resolve(ROOT, GO_WORK), "utf8");
		const dependabot = readFileSync(resolve(ROOT, DEPENDABOT), "utf8");
		modules = goWorkModules(goWork);
		missing = missingModules(goWork, dependabot);
	} catch (err) {
		console.error(
			`::error::check-dependabot-gomod: ${err instanceof Error ? err.message : String(err)}. ` +
				`That is no measurement, not a clean one.`,
		);
		process.exit(1);
	}
	if (missing.length > 0) {
		for (const m of missing) {
			console.error(
				`::error::check-dependabot-gomod: ${m} is a go.work module but not in ${DEPENDABOT}'s ` +
					`gomod \`directories\`. A bump that moves a module it requires leaves its go.mod ` +
					`untidy, and CI's GOWORK=off tidy check fails until someone hand-pushes a tidy.`,
			);
		}
		process.exit(1);
	}
	console.log(
		`check-dependabot-gomod: all ${modules.length} go.work module(s) are in the gomod directories.`,
	);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
