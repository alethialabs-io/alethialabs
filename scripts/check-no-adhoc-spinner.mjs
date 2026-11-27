#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
//
// Lists every ad-hoc spinner left in the product: a lucide `Loader2` / `Loader2Icon`, or an
// `animate-spin` class, anywhere outside the two files that own the loader (#7870, epic #7869).
//
// WHY THIS EXISTS. The product has one loader: the `[·]` mark. `@repo/ui/spinner` draws it inline
// (`Spinner`, and `<Button pending>` through it), `@repo/brand/loader` draws it at region and page
// size (`MarkLoader`), and `@repo/brand/thinking-indicator` draws it beside a rotating verb for an
// agent that is thinking. A spinning lucide glyph next to any of them tells the user the product is
// two products. The conversion lanes under #7869 replace the remaining sites; this is their census
// now and their ratchet later.
//
// REPORT MODE. Until the conversion lanes land, a plain run prints the census and EXITS 0 whatever
// it finds. `--enforce` makes any finding exit 1; the epic's last unit flips the package.json
// script to pass it. There is NO allowlist and there will not be one: a site is converted, never
// excused. A surface that genuinely needs a different wait gets the mark at a different size.
//
// WHAT IS MATCHED, after comments are stripped (strings are kept — a class list is a string):
//   · Loader2       — the identifier `Loader2` or `Loader2Icon` as a whole word: an import, a JSX
//                     element, an alias, a re-export. `Loader2Off`, `MyLoader2` and `Loader` are not.
//   · animate-spin  — the Tailwind class token `animate-spin`, bounded by anything that is not a
//                     word character or a hyphen, so a variant prefix (`motion-safe:animate-spin`)
//                     and a `cn()` argument both count. A custom `animate-spin-slow` is a different
//                     token and does not.
//
// WHAT IS READ. Tracked `.ts/.tsx/.js/.jsx/.mjs/.cjs` files under apps/ and packages/, minus:
//   · packages/ui/src/spinner.tsx and everything under packages/brand/src/loader/ — the loader;
//   · tests: any `tests/`, `__tests__/` or `e2e/` directory and any `*.test.*` / `*.spec.*` file.
//     Skeleton tests legitimately assert that `.animate-spin` is ABSENT, and a guard that counted
//     the assertion would push someone to delete it;
//   · type declarations and node_modules.
//
// WHAT IS DELIBERATELY NOT MATCHED, so nobody reads this as more than it is:
//   · other spinning icons (`LoaderCircle`, `RefreshCw` with a spin) and hand-written CSS
//     `animation: spin` — the census of #7869 found `Loader2` and `animate-spin` to be the forms in
//     use; a new form belongs in RULES below, with a self-test case;
//   · a class name built at run time (`"animate-" + kind`) — this reads text, not values;
//   · `.css`, `.mdx` and `.md` files: docs may name `Loader2` in prose;
//   · the comment stripper is the tokenizer from check-single-keydown.mjs, not a parser: an
//     apostrophe in JSX text can be misread as a quote, which can only KEEP text (add a finding).
//
// Usage:  node scripts/check-no-adhoc-spinner.mjs [--enforce] [--self-test]

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stripComments } from "./check-single-keydown.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The files that own the loader and may draw it however they like. */
export const LOADER_FILES = ["packages/ui/src/spinner.tsx"];
export const LOADER_DIRS = ["packages/brand/src/loader/"];

/** Each rule: its id and the pattern that finds it in comment-stripped source. */
export const RULES = [
	{ id: "Loader2", pattern: /\bLoader2(?:Icon)?\b/g },
	{ id: "animate-spin", pattern: /(?<![\w-])animate-spin(?![\w-])/g },
];

const FIX =
	"use the [·] mark: <Button pending> in a button, <Spinner /> from @repo/ui/spinner inline, <MarkLoader /> from @repo/brand/loader for a region or page, <ThinkingIndicator /> from @repo/brand/thinking-indicator for an agent thinking — or a skeleton where the layout is known";

const EXTS = /\.(ts|tsx|js|jsx|mjs|cjs)$/;

/** Is this tracked path one the guard reads (by location alone)? */
export function inScope(path) {
	if (!EXTS.test(path)) return false;
	if (!(path.startsWith("apps/") || path.startsWith("packages/"))) return false;
	if (/(^|\/)(tests|__tests__|e2e|node_modules)\//.test(path)) return false;
	if (/\.(test|spec)\.[a-z]+$/.test(path)) return false;
	if (/\.d\.ts$/.test(path)) return false;
	if (LOADER_FILES.includes(path)) return false;
	if (LOADER_DIRS.some((dir) => path.startsWith(dir))) return false;
	return true;
}

/** The 1-based line of an offset in a text. */
function lineAt(text, offset) {
	let n = 1;
	for (let i = 0; i < offset; i++) if (text.charCodeAt(i) === 10) n++;
	return n;
}

/** Findings for one source text, ignoring scope: `{ rule, line, text }` per match outside a comment, in source order. */
export function findSpinners(src) {
	const code = stripComments(src);
	const raw = src.split("\n");
	const out = [];
	for (const { id, pattern } of RULES) {
		for (const m of code.matchAll(pattern)) {
			const line = lineAt(code, m.index);
			out.push({ rule: id, line, offset: m.index, text: (raw[line - 1] ?? "").trim() });
		}
	}
	return out.sort((a, b) => a.offset - b.offset).map(({ offset: _offset, ...f }) => f);
}

/** Every finding across a set of `[path, source]` files, each tagged with its path. */
export function scan(files) {
	const findings = [];
	for (const [path, src] of files) {
		if (!inScope(path)) continue;
		for (const f of findSpinners(src)) findings.push({ path, ...f });
	}
	return findings;
}

/** Groups findings by file, largest first, then by path: `[{ path, findings }]`. */
export function census(findings) {
	const byFile = new Map();
	for (const f of findings) {
		const list = byFile.get(f.path) ?? [];
		list.push(f);
		byFile.set(f.path, list);
	}
	return [...byFile.entries()]
		.map(([path, list]) => ({ path, findings: list }))
		.sort((a, b) => b.findings.length - a.findings.length || a.path.localeCompare(b.path));
}

/** The exit code for a set of findings: 1 only when enforcing and something was found. */
export function exitCode(findings, enforce) {
	return enforce && findings.length > 0 ? 1 : 0;
}

/** The tracked files this guard reads, with their contents. */
function trackedSources(root) {
	const listed = execFileSync("git", ["ls-files", "-z", "apps", "packages"], {
		cwd: root,
		maxBuffer: 64 * 1024 * 1024,
	})
		.toString()
		.split("\0")
		.filter((p) => p && inScope(p));
	return listed.map((p) => [p, readFileSync(join(root, p), "utf8")]);
}

/** Prints the census and returns the exit code. */
function report(findings, scanned, enforce) {
	const groups = census(findings);
	const mark = enforce ? "✗" : "·";
	const print = enforce ? console.error : console.log;
	for (const { path, findings: list } of groups) {
		const counts = RULES.map(({ id }) => [id, list.filter((f) => f.rule === id).length])
			.filter(([, n]) => n > 0)
			.map(([id, n]) => `${id}×${n}`)
			.join(" ");
		print(`${mark} ${path}  (${list.length}: ${counts})`);
		for (const f of list) print(`    ${f.line}  [${f.rule}]  ${f.text}`);
	}
	const totals = RULES.map(({ id }) => `${id} ${findings.filter((f) => f.rule === id).length}`).join(", ");
	if (findings.length === 0) {
		console.log(`✓ check-no-adhoc-spinner: ${scanned} files, no ad-hoc spinner — the [·] mark is the only loader`);
		return 0;
	}
	print(`\n    fix: ${FIX}`);
	const summary = `check-no-adhoc-spinner: ${findings.length} ad-hoc spinner site(s) in ${groups.length} file(s) of ${scanned} read (${totals}).`;
	if (enforce) {
		console.error(`\n✗ ${summary}`);
	} else {
		console.log(`\n· ${summary}\n  REPORT MODE: exiting 0. Pass --enforce to fail on these (#7869's last unit flips it).`);
	}
	return exitCode(findings, enforce);
}

/** Each case is [description, path, source, expected rules]. The exit code is the test. */
function selfTest() {
	const C = "apps/console/components/x.tsx";
	const cases = [
		// Positive controls: each must be found.
		["a Loader2 import", C, 'import { Loader2 } from "lucide-react";', ["Loader2"]],
		["a Loader2Icon import", C, 'import { Loader2Icon } from "lucide-react";', ["Loader2"]],
		["a Loader2 element with animate-spin", C, '<Loader2 className="size-4 animate-spin" />', ["Loader2", "animate-spin"]],
		["animate-spin on a div", C, '<div className="animate-spin rounded-full" />', ["animate-spin"]],
		["a variant-prefixed animate-spin", C, '<span className="motion-safe:animate-spin" />', ["animate-spin"]],
		["animate-spin in a cn() argument", C, 'cn("size-4", busy && "animate-spin")', ["animate-spin"]],
		["animate-spin in a template literal", C, "const c = `h-4 ${x} animate-spin`;", ["animate-spin"]],
		["an aliased Loader2", C, 'import { Loader2 as Spin } from "lucide-react";', ["Loader2"]],
		["another app is read", "apps/marketing/app/x.tsx", "<Loader2 />", ["Loader2"]],
		["a package outside the loader is read", "packages/ui/src/button.tsx", '"animate-spin"', ["animate-spin"]],
		["a sibling of spinner.tsx is read", "packages/ui/src/spinner-x.tsx", "<Loader2Icon />", ["Loader2"]],
		["brand outside loader/ is read", "packages/brand/src/site/x.tsx", '"animate-spin"', ["animate-spin"]],
		// Negative controls: each must stay silent.
		["the inline loader is exempt", "packages/ui/src/spinner.tsx", "// replaced Loader2Icon\n<Loader2Icon />", []],
		["the brand loader dir is exempt", "packages/brand/src/loader/mark-loader.tsx", '"animate-spin"', []],
		["a tests/ dir is out of scope", "apps/console/tests/skeleton.test.tsx", 'expect(el.querySelector(".animate-spin")).toBeNull();', []],
		["a tests/ helper is out of scope", "apps/console/tests/helpers/render.ts", "<Loader2 />", []],
		["a colocated test is out of scope", "packages/ui/src/x.test.tsx", '"animate-spin"', []],
		["a spec is out of scope", "apps/console/components/x.spec.ts", "<Loader2 />", []],
		["an e2e dir is out of scope", "apps/console/e2e/x.ts", '".animate-spin"', []],
		["outside apps/ and packages/", "ee/console/x.tsx", "<Loader2 />", []],
		["a stylesheet is not read", "apps/console/app/globals.css", ".animate-spin {}", []],
		["a line comment is not code", C, "// <Loader2 className=\"animate-spin\" />", []],
		["a block comment is not code", C, "/* Loader2Icon, animate-spin */\nconst a = 1;", []],
		["other identifiers", C, "<Loader /> <LoaderCircle /> <Loader2Off /> const MyLoader2 = 1;", []],
		["another animation token", C, '"animate-spin-slow animate-pulse x-animate-spin"', []],
	];
	let failed = 0;
	for (const [name, path, src, want] of cases) {
		const got = scan([[path, src]]).map((f) => f.rule);
		if (JSON.stringify(got) !== JSON.stringify(want)) {
			failed++;
			console.error(`✗ self-test: ${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
		}
	}
	// Line numbers point at the match.
	const lined = scan([[C, "a;\nb;\n<Loader2 />"]])[0];
	if (lined?.line !== 3) {
		failed++;
		console.error(`✗ self-test: reported line ${lined?.line}, want 3`);
	}
	// The census groups by file, largest first.
	const grouped = census(
		scan([
			["apps/a.tsx", "<Loader2 />"],
			["apps/b.tsx", '<Loader2 className="animate-spin" />'],
		]),
	);
	if (grouped.length !== 2 || grouped[0].path !== "apps/b.tsx" || grouped[0].findings.length !== 2) {
		failed++;
		console.error(`✗ self-test: census grouped wrongly: ${JSON.stringify(grouped.map((g) => [g.path, g.findings.length]))}`);
	}
	// Report mode passes with findings; --enforce fails with them and passes without.
	const some = scan([[C, "<Loader2 />"]]);
	if (exitCode(some, false) !== 0 || exitCode(some, true) !== 1 || exitCode([], true) !== 0) {
		failed++;
		console.error("✗ self-test: exitCode does not tell report mode from --enforce");
	}
	if (failed) {
		console.error(`check-no-adhoc-spinner --self-test: ${failed} failure(s)`);
		return 1;
	}
	console.log(`✓ check-no-adhoc-spinner --self-test: ${cases.length} cases behave, both directions`);
	return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	if (process.argv.includes("--self-test")) process.exit(selfTest());
	const enforce = process.argv.includes("--enforce");
	const files = trackedSources(ROOT);
	process.exit(report(scan(files), files.length, enforce));
}
