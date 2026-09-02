#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
//
// The console UI conformance scoreboard — `apps/console/docs/ui-conformance/RUBRIC.md`'s STATIC
// families, scored over the derived private route set and rendered into two generated artifacts:
//
//   apps/console/docs/ui-conformance/scoreboard.md   the report a person reads (marker-spliced)
//   apps/console/ui-conformance-baseline.json        the same view, machine-readable
//
//   pnpm -C apps/console run audit:report            check both are in sync with the tree; exit 2 if not
//   pnpm -C apps/console run audit:report --write    regenerate them
//   pnpm -C apps/console run audit:report --json     print the derived view, write nothing
//   pnpm -C apps/console run audit:report --self-test
//
// Do NOT pipe it. `node scripts/audit-report.mjs | tail` reports TAIL's exit code.
//
// ── THIS IS A REPORT, NOT A THIRD BASELINE ───────────────────────────────────────────────────
//
// Two files in this repo are the source of truth for console conformance, and this is neither of
// them: `apps/console/route-states-baseline.yaml` (the S1–S4 / T1–T4 ratchet) and
// `apps/console/shared-surface-allowlist.yaml` (the H-family ledgers). Every number below is
// DERIVED from those two plus the tree. If you find yourself wanting to record a fact here that
// neither of them holds, that fact belongs in one of them.
//
// What the two generated files buy that the two ledgers do not: the ledgers are per-FILE and
// per-PREDICATE, and nothing joined them to a ROUTE. "Which pages are worst" was an impression.
// The rebuild lanes are supposed to be ranked by it.
//
// ── THE ORDERING THIS UNIT EXISTS FOR ────────────────────────────────────────────────────────
//
// The numbers committed alongside this file were measured on an unmodified `dev`, before any
// conformance lane changed a component. A guard shipped in the same commit as its fix is
// tautological, and this repo has paid for that more than once.
//
// ── WHAT IS SCORED, AND WHAT IS EXPLICITLY NOT ───────────────────────────────────────────────
//
// The rubric defines 33 predicates in five families. This file scores 15 of them: S1–S4 and
// T1–T4 through `scripts/check-route-states.mjs`, and seven of the eight H rows through
// `scripts/check-shared-surface.mjs`. The other 18 are rendered as `—` with the reason and the
// issue that owns them, NEVER omitted and never rendered as a pass:
//
//   T5–T7, R1–R7   live predicates. The Playwright `audit` project measures them; #3634 joins
//                  its records to this scoreboard. Ten predicates.
//   H3             `StatusBadge`. There is no matcher and there cannot easily be one — a page
//                  that should have shown a status pill and showed a `<Badge>` has no negative
//                  form to grep for, which `check-shared-surface.mjs`'s own header records as
//                  the reason it stays prose.
//   F1–F7          the filter standard. Nothing in the tree implements this family at all, and
//                  F7 is a unit test by design (RUBRIC.md's own note).
//
// A report whose "nothing found" branch is indistinguishable from "nothing measured" is the
// dominant defect class in this repo, so the classification above is CHECKED rather than
// documented: `partitionPredicates()` raises unless every predicate the rubric defines is in
// exactly one of {scored here, declared live, declared un-instrumented}, and unless every entry
// in the declared tables is a predicate the rubric actually defines. Add a row to the rubric and
// this file refuses to run until somebody says which of the three it is.
//
// ── THE RULE-ID → PREDICATE MAPPING, AND THE ONE RULE THAT MAPS TO NOTHING ────────────────────
//
// `check-shared-surface.mjs` names its rules after CLAUDE.md §6's table rows, not after the
// rubric: `format`, `page_title`, `section_header`, `type_scale`, `empty_state`, `stat_strip`,
// `layer_token`, `data_table`. Seven of those eight are an H row. `empty_state` is not: the
// rubric's H table has no empty-state row, because it files the empty state as **T5**, which it
// declares LIVE ("driven against an empty org, the rendered empty region resolves to
// `@repo/ui/empty`"). The static matcher asks a different question — "does this file hand-roll a
// centred empty region?" — and reporting its findings under T5 would be an instrument measuring
// one thing and reported as another.
//
// So `empty_state` is scored NOWHERE, and its findings are visible anyway: the reconciliation
// section accounts for every finding the guard produced, by rule, and this one is listed under
// its own heading with the issue that will reconcile the rubric. That is the whole point of the
// reconciliation — the totals must add up to what `scan()` returned, so a rule falling out of the
// mapping cannot be quiet.
//
// ── HOW AN H FINDING BECOMES A ROUTE'S VERDICT ───────────────────────────────────────────────
//
// The shared-surface guard is per FILE. A route is a page file. The join is the page's own module
// closure: every `@/…` or relative import reachable from `page.tsx`, transitively.
//
// The LAYOUT CHAIN IS DELIBERATELY NOT IN IT, and the reason is measured. Adding the layouts
// pulls in `AppShell` → the sidebar → the org switcher → very nearly the whole console: every
// route's closure lands between 477 and 563 files and the H column stops discriminating between
// pages entirely. Page-only closures run from 1 to 383. The S family already measures the shell,
// which is the half a layout owns.
//
// The cost of that choice, stated rather than left for a reader to discover: a defect that lives
// ONLY in the shared chrome is in no route's H column. It is not invisible — the reconciliation
// counts it under "reachable only from the shared layout chain" and names every file — but it is
// not scored, because attributing the sidebar's drift to all 40 routes would say the console is
// 40 times worse than it is and would move all 40 numbers when one file is fixed.
//
// An occurrence is a defect unless a `reason:` entry in the allowlist covers it. A `lifts:` entry
// does NOT excuse it: `lifts:` is measured drift a named lane will remove, and RUBRIC.md says so
// for H8 in as many words — "a page scores FAIL on H8 today and the number can only shrink". The
// two ledgers being different things is CLAUDE.md §6's own rule; this is that rule, applied.
//
// ── THE STATIC H HALF EMITS NO N/A AT ALL ────────────────────────────────────────────────────
//
// The rubric declares content-derived N/A reasons for four H rows — `renders-no-table`,
// `renders-no-formatted-value`, `declares-no-z-index`, `renders-no-status`. A static matcher
// cannot produce any of them: "this page has no table" and "this page's table is correct" are the
// same observation, zero findings. Claiming the N/A would shrink the denominator on evidence that
// does not bear on it, which is precisely the escape RUBRIC.md's rule 2 exists to close.
//
// So the static H half emits PASS or FAIL and nothing else. A page with no table PASSES H4 — it
// does not hand-roll a table. That widens the denominator, which is the conservative direction: it
// can only lower a score, never raise one. The four redirect-only routes therefore pass every H
// row trivially, on a closure of one file that renders nothing; the totals row separates them out.
//
// ── WHY check-shared-surface.mjs IS READ THROUGH A CHILD PROCESS ─────────────────────────────
//
// That module has no entrypoint guard: importing it RUNS the whole guard at import time and can
// `process.exit(1)` before a single line of this file executes. `scripts/lib/console-routes.mjs`
// records the same obstacle in its own header. So it is imported in a child, with `process.argv`
// arranged so the module takes its `--self-test` branch — which returns normally instead of
// scanning — and the child then calls the exported `scan()` and `parseAllowlist()` itself and
// prints JSON after a sentinel.
//
// That shape is worth more than a workaround: it makes the shared-surface guard's own fixture
// suite a PRECONDITION of this report. Two instruments, two positive controls, both run before
// anything is scored — `positiveControl()` from `check-route-states.mjs` is called directly for
// the same reason.
//
// It is a shim, and it has an owner: **#3788 / PR #3794** adds that entrypoint guard. It was open
// and unmerged when this landed — `dev` was still at 5b48fbc4 — which is why the shim is here and
// not a plain `import`. The moment #3794 lands, `readSharedSurface()` collapses to
// `import { scan, parseAllowlist } from "…/check-shared-surface.mjs"` and everything else in this
// file stays as it is.
//
// The argv line is written so that landing #3794 changes nothing about CORRECTNESS in the
// meantime: with an entrypoint guard, `argv[1]` does not resolve to that module, so it runs
// NOTHING at import and the child still reaches the exported `scan()`. What is lost in that world
// is the self-test precondition, and the vacuity assertions below — which this file computes for
// itself out of `scan()`'s own census — are what still refuse a scan that read nothing. Neither
// control is load-bearing alone, which is the point of having both.
//
// `check()` is deliberately NOT the export used. It returns `{problems, census, perRule, allowed,
// entries, decisions, debt}` and no findings, so it cannot answer "which occurrence is in which
// file" — which is the entire join this report is built on. `scan()` and `parseAllowlist()` are
// exported both before and after #3794.
//
// ── NO WALL CLOCK, AND NO UNCOMMITTED INPUT ──────────────────────────────────────────────────
//
// Two constraints inherited from `scripts/programme-rollup.mjs`, which learned both the hard way:
//
//   · nothing time-dependent may be rendered into a diff-gated region, or every PR is stale on
//     arrival. `--self-test` asserts the rendered text carries no date;
//   · the only inputs are COMMITTED files. `test-results/ui-audit*.json` is deliberately not read
//     even when it exists, because an artifact that appears only after somebody ran Playwright
//     locally would make the generated files disagree between two clean checkouts. #3634 owns
//     joining the live records, and owns deciding how they get committed.

import { execFileSync } from "node:child_process";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { collectConsoleRoutes, stripCommentLines } from "../../../scripts/lib/console-routes.mjs";
import {
	NA_REASONS as ROUTE_STATE_NA_REASONS,
	PREDICATES as ROUTE_STATE_PREDICATES,
	positiveControl,
	runOver,
} from "../../../scripts/check-route-states.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONSOLE_DIR = path.resolve(HERE, "..");
const REPO_ROOT = path.resolve(CONSOLE_DIR, "..", "..");

const RUBRIC = "apps/console/docs/ui-conformance/RUBRIC.md";
const SCOREBOARD = "apps/console/docs/ui-conformance/scoreboard.md";
const BASELINE_JSON = "apps/console/ui-conformance-baseline.json";
const ALLOWLIST = "apps/console/shared-surface-allowlist.yaml";
const ROUTE_STATES_BASELINE = "apps/console/route-states-baseline.yaml";
const SHARED_SURFACE = "scripts/check-shared-surface.mjs";

const BEGIN = "<!-- BEGIN GENERATED: audit-report · tree-derived · DO NOT EDIT BELOW -->";
const END = "<!-- END GENERATED: audit-report -->";

/**
 * The joiner for this file's own composite map keys (`rule` + `file`). Written as an escape rather
 * than as a literal, because a raw NUL byte in a source file makes `rg` and `grep -r` report
 * "binary file matches" and print nothing — `check-shared-surface.mjs` carries that incident in its
 * own self-test.
 */
const KEY = "\u0000";

/** Any control character, for splitting a separator another module owns and does not export. */
const CONTROL_CHAR = /[\u0000-\u001f]/;

/** The rubric's five families, in the order it declares them. */
export const FAMILIES = /** @type {const} */ ({
	S: "shell & width",
	T: "states",
	H: "shared surface",
	F: "filter standard",
	R: "rendered integrity",
});

/**
 * `check-shared-surface.mjs`'s rule ids → the RUBRIC.md predicate each one measures.
 *
 * Written out rather than inferred, because the two vocabularies genuinely differ: the guard is
 * named after CLAUDE.md §6's table rows and the rubric after its own families, and the H table
 * lists them in the order H1, H2, H8, H3…H7. `--self-test` pins every pair.
 */
export const RULE_PREDICATE = /** @type {const} */ ({
	page_title: "H1",
	section_header: "H2",
	data_table: "H4",
	format: "H5",
	stat_strip: "H6",
	layer_token: "H7",
	type_scale: "H8",
});

/**
 * The guard rules that map to NO rubric predicate, each with the reason and the issue that owns
 * it. A rule id observed in the tree that is in neither this table nor `RULE_PREDICATE` RAISES —
 * a matcher whose findings fall out of the report must not be able to do so quietly.
 */
export const RULES_WITHOUT_A_PREDICATE = /** @type {const} */ ({
	empty_state: {
		owner: "#3798",
		why:
			"CLAUDE.md §6's EmptyState row. RUBRIC.md's H table has no row for it — the rubric files " +
			"the empty state as T5, which it declares LIVE. The static matcher asks a different " +
			"question (does this file hand-roll a centred empty region?), so reporting it as T5 would " +
			"be one instrument reported as another. Counted in the table above, scored nowhere.",
	},
});

/**
 * Every rubric predicate this file does NOT score, and why. Checked against the rubric in both
 * directions by `partitionPredicates()`.
 *
 * `kind: "live"` — an instrument exists and runs elsewhere (the Playwright `audit` project).
 * `kind: "none"` — nothing measures this predicate anywhere, today.
 */
export const NOT_SCORED_HERE = /** @type {const} */ ({
	T5: { kind: "live", owner: "#3634", why: "the empty state as RENDERED, against a seeded empty org." },
	T6: { kind: "live", owner: "#3634", why: "the error state as RENDERED, under fault injection." },
	T7: { kind: "live", owner: "#3634", why: "permission-denied as RENDERED, as the `member` persona." },
	R1: { kind: "live", owner: "#3634", why: "horizontal overflow at four viewport widths." },
	R2: { kind: "live", owner: "#3634", why: "overlay stacking, by hit-testing — a class name is a rendering of the intent, not the stacking." },
	R3: { kind: "live", owner: "#3634", why: "exactly one scroll container." },
	R4: { kind: "live", owner: "#3634", why: "no two interactive elements overlap." },
	R5: { kind: "live", owner: "#3634", why: "axe, at wcag2a/wcag2aa." },
	R6: { kind: "live", owner: "#3634", why: "console errors and failed requests." },
	R7: { kind: "live", owner: "#3634", why: "interactive within the route's budget." },
	H3: {
		kind: "none",
		owner: "#3797",
		why:
			"StatusBadge. `check-shared-surface.mjs` records why this row stays prose: a page that " +
			"should have shown a status pill and showed a `<Badge>` has no negative form to grep for.",
	},
	F1: { kind: "none", owner: "#3796", why: "the filter standard — a `createFilterStore` store exists for the page." },
	F2: { kind: "none", owner: "#3796", why: "the filter standard — `useFilterUrlSync` is wired." },
	F3: { kind: "none", owner: "#3796", why: "the filter standard — search is debounced and the normalized query is the TanStack key." },
	F4: { kind: "none", owner: "#3796", why: "the filter standard — the bar is built from the shared filter components." },
	F5: { kind: "none", owner: "#3796", why: "the filter standard — the result count is a `CountPill`." },
	F6: { kind: "none", owner: "#3796", why: "the filter standard — `keepPreviousData` plus the placeholder dim." },
	F7: { kind: "none", owner: "#3796", why: "the filter standard — the server builder's separate unfiltered facet pass. A unit test by design, per RUBRIC.md." },
});

// ── the rubric is the predicate universe ─────────────────────────────────────────────────────

/**
 * The predicates RUBRIC.md defines, read out of its own tables.
 *
 * DERIVED, not typed. A hand-kept list of what a report covers stops covering silently, and this
 * file's whole subject is a rubric whose own stated count was wrong three different ways at once:
 * the header said twenty-six, the seeding commit said 25, and the tables define 33. Reading the
 * tables makes that class of drift impossible: add a row and the report's denominator moves.
 *
 * The stated count is checked against the rows for the same reason — it is the sentence a reader
 * quotes, so it is the one that must not be able to rot.
 *
 * @param {string} text RUBRIC.md
 * @returns {{stated: number, predicates: {id: string, family: string}[]}}
 */
export function parseRubric(text) {
	/** @type {{id: string, family: string}[]} */
	const predicates = [];
	/** @type {Set<string>} */
	const seen = new Set();
	for (const [i, line] of text.split("\n").entries()) {
		const m = line.match(/^\|\s*\*\*([STHFR])(\d+)\*\*\s*\|/);
		if (m === null) continue;
		const id = `${m[1]}${m[2]}`;
		if (seen.has(id)) {
			throw new Error(`${RUBRIC}:${i + 1}: ${id} is defined twice. Two rows for one predicate is two verdict definitions.`);
		}
		seen.add(id);
		predicates.push({ id, family: m[1] });
	}
	if (predicates.length === 0) {
		throw new Error(
			`${RUBRIC}: no predicate rows (\`| **S1** | …\`) found. That is a broken read of the rubric, ` +
				`not a rubric with nothing in it — every score below would have an empty denominator.`,
		);
	}
	const count = text.match(/\*\*(\d+) predicates\*\*/);
	if (count === null) {
		throw new Error(
			`${RUBRIC}: does not state its own predicate count as \`**N predicates**\`. The count is the ` +
				`sentence readers quote; it is checked against the tables so that it cannot rot.`,
		);
	}
	const stated = Number(count[1]);
	if (stated !== predicates.length) {
		throw new Error(
			`${RUBRIC}: says **${stated} predicates** and its tables define ${predicates.length}. ` +
				`Fix the sentence, or the row that was added without one.`,
		);
	}
	return { stated, predicates };
}

/**
 * Split the rubric's predicates three ways, and refuse anything that does not land in exactly one.
 *
 * Both directions are checked. A rubric row missing from every table means a predicate silently
 * dropped out of the report; a table entry naming a predicate the rubric does not define means the
 * report is describing something that no longer exists.
 *
 * @param {{id: string, family: string}[]} rubricPredicates
 * @param {string[]} scoredHere
 * @param {Record<string, {kind: string, owner: string, why: string}>} notScored
 */
export function partitionPredicates(rubricPredicates, scoredHere, notScored) {
	const defined = new Set(rubricPredicates.map((p) => p.id));
	/** @type {string[]} */
	const problems = [];

	for (const id of scoredHere) {
		if (!defined.has(id)) problems.push(`${id} is scored by this report and RUBRIC.md does not define it.`);
		if (id in notScored) problems.push(`${id} is both scored here and declared not-scored. It cannot be both.`);
	}
	for (const id of Object.keys(notScored)) {
		if (!defined.has(id)) problems.push(`${id} is declared not-scored and RUBRIC.md does not define it.`);
	}
	const scored = new Set(scoredHere);
	for (const p of rubricPredicates) {
		if (scored.has(p.id) || p.id in notScored) continue;
		problems.push(
			`${p.id} is defined by RUBRIC.md and this report neither scores it nor declares why not. ` +
				`Add it to the scored set, or to NOT_SCORED_HERE with its owner — a predicate that falls ` +
				`out of the report silently is the failure this table exists to prevent.`,
		);
	}
	if (problems.length > 0) {
		throw new Error(`the predicate partition is broken:\n  - ${problems.join("\n  - ")}`);
	}
	return { scored: [...scored], live: Object.keys(notScored).filter((k) => notScored[k].kind === "live"), none: Object.keys(notScored).filter((k) => notScored[k].kind === "none") };
}

// ── module closures ──────────────────────────────────────────────────────────────────────────

/** Extensions a module graph may traverse. A `.json` or `.css` import resolves and stops. */
const CODE_EXTS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];

/**
 * One import specifier per match, over COMMENT-STRIPPED source.
 *
 * `import(` is included so `next/dynamic(() => import("@/components/x"))` is followed — a lazily
 * mounted panel is still something the page renders. `require(` is included for the same reason
 * and finds nothing in the console today.
 */
const SPECIFIER = /(?:\bfrom|\bimport|\brequire)\s*\(?\s*["']([^"'\n]+)["']/g;

/**
 * Resolve one specifier the way the console's `moduleResolution: "bundler"` + `@/*` alias does.
 *
 * Anything that is not `@/…` or relative is EXTERNAL and is not followed: `@repo/ui`, `react`,
 * `next/*` are outside the guard's scope by construction, so following them would add files no
 * matcher looks at.
 *
 * A `@/…` or relative specifier that resolves to nothing RAISES. That is the loud direction on
 * purpose — the alternative is a page whose closure quietly lost a subtree, which reads exactly
 * like a page with no findings in it. Measured on `dev`: 0 unresolvable specifiers over the union
 * of all 40 route closures and every layout chain.
 *
 * @param {string} spec
 * @param {string} fromFile absolute
 * @param {(p: string) => "file"|"dir"|null} kindOf
 * @returns {{kind: "external"} | {kind: "code", file: string} | {kind: "asset", file: string}}
 */
export function resolveSpecifier(spec, fromFile, kindOf, consoleDir = CONSOLE_DIR) {
	/** @type {string} */
	let base;
	if (spec.startsWith("@/")) base = path.join(consoleDir, spec.slice(2));
	else if (spec.startsWith("./") || spec.startsWith("../")) base = path.resolve(path.dirname(fromFile), spec);
	else return { kind: "external" };

	for (const ext of CODE_EXTS) if (kindOf(base + ext) === "file") return { kind: "code", file: base + ext };
	if (kindOf(base) === "dir") {
		for (const ext of CODE_EXTS) {
			const idx = path.join(base, `index${ext}`);
			if (kindOf(idx) === "file") return { kind: "code", file: idx };
		}
	}
	if (kindOf(base) === "file") return { kind: "asset", file: base };
	throw new Error(
		`${fromFile}: cannot resolve \`${spec}\`. A module graph that quietly loses a subtree reads ` +
			`exactly like a page with no findings in it, so this raises rather than skipping.`,
	);
}

/**
 * Every console module transitively reachable from `entries`, as repo-relative POSIX paths.
 *
 * @param {string[]} entries absolute paths
 * @param {{readFile: (p: string) => string, kindOf: (p: string) => "file"|"dir"|null, repoRoot?: string, consoleDir?: string}} io
 * @returns {Set<string>}
 */
export function moduleClosure(entries, io) {
	const repoRoot = io.repoRoot ?? REPO_ROOT;
	const consoleDir = io.consoleDir ?? CONSOLE_DIR;
	/** @type {Set<string>} */
	const seen = new Set();
	const stack = [...entries];
	while (stack.length > 0) {
		const file = stack.pop();
		if (seen.has(file)) continue;
		seen.add(file);
		const { lines, unterminated } = stripCommentLines(io.readFile(file));
		if (unterminated) {
			throw new Error(
				`${file}: a block comment is still open at EOF. Everything after the opener was blanked, ` +
					`so this module's imports have NOT been read — refusing rather than reporting a short closure.`,
			);
		}
		const src = lines.join("\n");
		SPECIFIER.lastIndex = 0;
		let m;
		while ((m = SPECIFIER.exec(src)) !== null) {
			const hit = resolveSpecifier(m[1], file, io.kindOf, consoleDir);
			if (hit.kind === "code" && !seen.has(hit.file)) stack.push(hit.file);
		}
	}
	return new Set([...seen].map((f) => path.relative(repoRoot, f).split(path.sep).join("/")).sort());
}

// ── the shared-surface guard, read through a child process ───────────────────────────────────

const SENTINEL = "---audit-report-json---";

/**
 * `scan()` and `parseAllowlist()` from `scripts/check-shared-surface.mjs`, without that module's
 * import-time guard running in this process. See the header for why this is a child.
 *
 * @param {string} repoRoot
 * @returns {{findings: {rule: string, file: string, line: number, text: string}[], census: [string, number][], unterminated: string[], baseline: number, debt: number, entries: {section: string, path: string, hits: number, kind: string|null}[]}}
 */
export function readSharedSurface(repoRoot) {
	const moduleUrl = pathToFileURL(path.join(repoRoot, SHARED_SURFACE)).href;
	const script = [
		// argv[1] is deliberately NOT this module's path: today `check-shared-surface.mjs` dispatches
		// on `argv.includes("--self-test")` and takes the self-test branch, which RETURNS instead of
		// scanning; if it ever gains the entrypoint guard every other script here has, argv[1] fails
		// to resolve to it and the module runs nothing at import. Both outcomes are safe. What is not
		// safe — the default branch running the real check and calling process.exit(1) — needs argv
		// to carry neither, which is the one shape this line rules out.
		`process.argv = [process.argv[0], "audit-report-child", "--self-test"];`,
		`const m = await import(${JSON.stringify(moduleUrl)});`,
		`const fs = await import("node:fs");`,
		`const p = await import("node:path");`,
		`const ROOT = ${JSON.stringify(repoRoot)};`,
		`const readFile = (f) => fs.readFileSync(p.join(ROOT, f), "utf8");`,
		`const listDir = (dir) => {`,
		`  let entries;`,
		`  try { entries = fs.readdirSync(p.join(ROOT, dir), { withFileTypes: true }); }`,
		`  catch (err) { if (err && err.code === "ENOTDIR") return []; throw err; }`,
		`  return entries.filter((e) => e.isDirectory() || e.isFile()).map((e) => e.name);`,
		`};`,
		`const scanned = m.scan(readFile, listDir);`,
		`const list = m.parseAllowlist(readFile(${JSON.stringify(ALLOWLIST)}));`,
		`process.stdout.write("\\n" + ${JSON.stringify(SENTINEL)} + "\\n" + JSON.stringify({`,
		`  findings: scanned.findings.map((f) => ({ rule: f.rule, file: f.file, line: f.line, text: f.text })),`,
		`  census: [...scanned.census],`,
		`  unterminated: [...scanned.unterminated],`,
		`  baseline: list.baseline,`,
		`  debt: list.debt,`,
		`  entries: list.entries.map((e) => ({ section: e.section, path: e.path, hits: e.hits, kind: e.kind })),`,
		`}));`,
	].join("\n");

	/** @type {string} */
	let out;
	try {
		out = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
			cwd: repoRoot,
			encoding: "utf8",
			maxBuffer: 64 * 1024 * 1024,
			stdio: ["ignore", "pipe", "pipe"],
		});
	} catch (err) {
		throw new Error(
			`could not read ${SHARED_SURFACE}: the child exited ${err.status ?? "abnormally"}.\n` +
				`This is the shared-surface guard refusing to hand over a scan — its own fixture suite is ` +
				`the precondition of this report, and a scoreboard over a broken matcher is worse than none.\n` +
				`--- child stderr ---\n${String(err.stderr ?? "").trim()}\n${String(err.stdout ?? "").trim()}`,
		);
	}
	const at = out.indexOf(SENTINEL);
	if (at === -1) {
		throw new Error(
			`could not read ${SHARED_SURFACE}: the child exited 0 but emitted no \`${SENTINEL}\`. It has ` +
				`changed shape — the exported \`scan\`/\`parseAllowlist\` were not reached.\n--- child output ---\n${out.trim()}`,
		);
	}
	return JSON.parse(out.slice(at + SENTINEL.length));
}

/**
 * The vacuity controls this file computes for ITSELF, from the scan's own census.
 *
 * They duplicate what `check-shared-surface.mjs`'s `check()` asserts, on purpose: `check()` is not
 * what the child runs, and this report must not be able to conclude "no findings" from "read no
 * files" if the arrangement above ever stops running the guard's self-test.
 *
 * @param {[string, number][]} census keys are `scopeId SEP root SEP ext`
 * @param {string[]} unterminated
 * @returns {string[]} one line per problem
 */
export function scanVacuityProblems(census, unterminated) {
	/** @type {string[]} */
	const problems = [];
	if (census.length === 0) problems.push("the shared-surface scan reported an EMPTY census — it examined no scope at all.");
	/** @type {Map<string, Map<string, number>>} */
	const byScope = new Map();
	for (const [key, n] of census) {
		// The guard joins `scopeId`, `root` and `ext` with a control character it does not export.
		// Splitting on the CLASS, and refusing anything that is not three parts, means a change of
		// separator becomes the loud failure below rather than two silently mis-parsed axes — a
		// hand-copied constant that stopped matching would read as "every axis is fine".
		const parts = key.split(CONTROL_CHAR);
		if (parts.length !== 3) {
			problems.push(
				`the shared-surface census key ${JSON.stringify(key)} is not \`scope SEP root SEP ext\` — ` +
					"the scan's shape changed, so neither the root axis nor the extension axis can be read.",
			);
			continue;
		}
		const [scopeId, root, ext] = parts;
		if (!byScope.has(scopeId)) byScope.set(scopeId, new Map());
		const axes = byScope.get(scopeId);
		axes.set(`root ${root}`, (axes.get(`root ${root}`) ?? 0) + n);
		axes.set(`ext ${ext}`, (axes.get(`ext ${ext}`) ?? 0) + n);
	}
	for (const [scopeId, axes] of byScope) {
		for (const [axis, n] of axes) {
			if (n === 0) problems.push(`the \`${scopeId}\` scope examined ZERO files for \`${axis}\` — the scan is broken, not the tree.`);
		}
	}
	for (const f of unterminated) {
		problems.push(`${f}: an unterminated block comment — the guard blanked the rest of the file, so it has not read it.`);
	}
	return problems;
}

// ── the derived view ─────────────────────────────────────────────────────────────────────────

/** PASS ÷ (PASS + FAIL). N/A leaves the denominator — RUBRIC.md, "How a predicate is scored". */
export function scoreOf(pass, fail) {
	const denom = pass + fail;
	return denom === 0 ? null : pass / denom;
}

/**
 * Build everything both renderers need, from inputs that are all injectable so `--self-test` can
 * drive the whole pipeline over a fixture rather than over the console.
 *
 * @param {object} input
 * @param {{scored: Record<string, {pass: string[], fail: {route: string, detail: string}[], na: Record<string, string[]>}>, totals: {routes: number, redirectOnly: number, real: number}, manifest: {routes: object[]}}} input.run
 * @param {{id: string, family: string}[]} input.rubricPredicates
 * @param {{findings: {rule: string, file: string, line: number, text: string}[], entries: {section: string, path: string, hits: number, kind: string|null}[], baseline: number, debt: number}} input.surface
 * @param {Map<string, Set<string>>} input.pageClosures  route → repo-relative files
 * @param {Set<string>} input.chromeClosure  every file reachable from a layout chain
 */
export function buildView({ run, rubricPredicates, surface, pageClosures, chromeClosure }) {
	const scoredIds = [...ROUTE_STATE_PREDICATES, ...Object.values(RULE_PREDICATE)];
	partitionPredicates(rubricPredicates, scoredIds, NOT_SCORED_HERE);

	// Every rule id the tree or the allowlist actually names must be accounted for. A matcher whose
	// findings map to no predicate and are not declared unmapped would otherwise vanish.
	const known = new Set([...Object.keys(RULE_PREDICATE), ...Object.keys(RULES_WITHOUT_A_PREDICATE)]);
	const observed = new Set([...surface.findings.map((f) => f.rule), ...surface.entries.map((e) => e.section)]);
	const stray = [...observed].filter((id) => !known.has(id)).sort();
	if (stray.length > 0) {
		throw new Error(
			`shared-surface rule(s) ${stray.join(", ")} are neither mapped to a rubric predicate nor ` +
				`declared unmapped. Add each to RULE_PREDICATE or to RULES_WITHOUT_A_PREDICATE with its ` +
				`reason — a matcher whose findings fall out of this report must not be able to do so quietly.`,
		);
	}

	// ── which occurrences a `reason:` entry excuses ────────────────────────────────────────────
	// A `lifts:` (debt) entry excuses NOTHING: it is measured drift a named lane will remove, and
	// RUBRIC.md says a page scores FAIL on H8 today for exactly that reason.
	/** @type {Map<string, number>} rule + KEY + file → occurrences a recorded DECISION covers */
	const excused = new Map();
	for (const e of surface.entries) {
		if (e.kind !== "decision") continue;
		const key = `${e.section}${KEY}${e.path}`;
		excused.set(key, (excused.get(key) ?? 0) + e.hits);
	}
	/** @type {Map<string, {rule: string, file: string, hits: number}>} unexcused occurrences per rule+file */
	const unexcused = new Map();
	/** @type {Map<string, number>} */
	const perRuleTotal = new Map();
	/** @type {Map<string, number>} */
	const perRuleExcused = new Map();
	for (const f of surface.findings) {
		const key = `${f.rule}${KEY}${f.file}`;
		perRuleTotal.set(f.rule, (perRuleTotal.get(f.rule) ?? 0) + 1);
		const row = unexcused.get(key) ?? { rule: f.rule, file: f.file, hits: 0 };
		row.hits += 1;
		unexcused.set(key, row);
	}
	for (const [key, row] of unexcused) {
		const cover = Math.min(excused.get(key) ?? 0, row.hits);
		row.hits -= cover;
		perRuleExcused.set(row.rule, (perRuleExcused.get(row.rule) ?? 0) + cover);
		if (row.hits === 0) unexcused.delete(key);
	}

	// ── verdicts ──────────────────────────────────────────────────────────────────────────────
	/** @type {{route: string, predicate: string, verdict: "PASS"|"FAIL"|"N/A", reason?: string, detail?: string}[]} */
	const verdicts = [];
	const routeOrder = run.manifest.routes.map((r) => r.route);

	for (const id of ROUTE_STATE_PREDICATES) {
		const s = run.scored[id];
		for (const route of s.pass) verdicts.push({ route, predicate: id, verdict: "PASS" });
		for (const f of s.fail) verdicts.push({ route: f.route, predicate: id, verdict: "FAIL", detail: f.detail });
		for (const [reason, routes] of Object.entries(s.na)) {
			for (const route of routes) verdicts.push({ route, predicate: id, verdict: "N/A", reason });
		}
	}

	for (const route of routeOrder) {
		const surfaceFiles = pageClosures.get(route) ?? new Set();
		for (const [ruleId, predicate] of Object.entries(RULE_PREDICATE)) {
			/** @type {{file: string, hits: number}[]} */
			const hits = [];
			for (const file of surfaceFiles) {
				const row = unexcused.get(`${ruleId}${KEY}${file}`);
				if (row !== undefined) hits.push({ file, hits: row.hits });
			}
			hits.sort((a, b) => (b.hits - a.hits) || a.file.localeCompare(b.file));
			if (hits.length === 0) {
				verdicts.push({ route, predicate, verdict: "PASS" });
				continue;
			}
			const total = hits.reduce((n, h) => n + h.hits, 0);
			verdicts.push({
				route,
				predicate,
				verdict: "FAIL",
				detail: `${total} occurrence(s) in ${hits.length} file(s), worst ${hits[0].file} (${hits[0].hits})`,
			});
		}
	}
	verdicts.sort((a, b) => a.route.localeCompare(b.route) || a.predicate.localeCompare(b.predicate));

	// ── tallies ───────────────────────────────────────────────────────────────────────────────
	/** @type {Record<string, {family: string, instrument: string, owner: string|null, pass: number, fail: number, na: number, naReasons: Record<string, number>, score: number|null}>} */
	const predicates = {};
	for (const p of rubricPredicates) {
		const notScored = NOT_SCORED_HERE[p.id];
		predicates[p.id] = {
			family: p.family,
			instrument: notScored === undefined
				? (ROUTE_STATE_PREDICATES.includes(p.id) ? "check-route-states" : "check-shared-surface")
				: notScored.kind,
			owner: notScored?.owner ?? null,
			pass: 0,
			fail: 0,
			na: 0,
			naReasons: {},
			score: null,
		};
	}
	for (const v of verdicts) {
		const row = predicates[v.predicate];
		if (v.verdict === "PASS") row.pass += 1;
		else if (v.verdict === "FAIL") row.fail += 1;
		else {
			row.na += 1;
			row.naReasons[v.reason] = (row.naReasons[v.reason] ?? 0) + 1;
		}
	}
	for (const row of Object.values(predicates)) row.score = scoreOf(row.pass, row.fail);

	// ── per route, per family ─────────────────────────────────────────────────────────────────
	/** @type {Map<string, {route: string, redirectOnly: boolean, surfaceFiles: number, families: Record<string, {pass: number, fail: number, na: number, score: number|null, instrumented: number, of: number}>, overall: {pass: number, fail: number, na: number, score: number|null}}>} */
	const routes = new Map();
	const familyOf = Object.fromEntries(rubricPredicates.map((p) => [p.id, p.family]));
	const familySize = {};
	for (const p of rubricPredicates) familySize[p.family] = (familySize[p.family] ?? 0) + 1;
	const familyInstrumented = {};
	for (const p of rubricPredicates) {
		familyInstrumented[p.family] = (familyInstrumented[p.family] ?? 0) + (NOT_SCORED_HERE[p.id] === undefined ? 1 : 0);
	}
	for (const r of run.manifest.routes) {
		/** @type {Record<string, {pass: number, fail: number, na: number, score: number|null, instrumented: number, of: number}>} */
		const families = {};
		for (const key of Object.keys(FAMILIES)) {
			families[key] = { pass: 0, fail: 0, na: 0, score: null, instrumented: familyInstrumented[key] ?? 0, of: familySize[key] ?? 0 };
		}
		routes.set(r.route, {
			route: r.route,
			redirectOnly: r.isRedirectOnly,
			surfaceFiles: (pageClosures.get(r.route) ?? new Set()).size,
			families,
			overall: { pass: 0, fail: 0, na: 0, score: null },
		});
	}
	for (const v of verdicts) {
		const row = routes.get(v.route);
		const fam = row.families[familyOf[v.predicate]];
		const bucket = v.verdict === "PASS" ? "pass" : v.verdict === "FAIL" ? "fail" : "na";
		fam[bucket] += 1;
		row.overall[bucket] += 1;
	}
	for (const row of routes.values()) {
		for (const fam of Object.values(row.families)) fam.score = scoreOf(fam.pass, fam.fail);
		row.overall.score = scoreOf(row.overall.pass, row.overall.fail);
	}

	// ── reconciliation: every finding is accounted for, twice over ────────────────────────────
	const inSomePage = new Set();
	for (const files of pageClosures.values()) for (const f of files) inSomePage.add(f);
	// SEEDED WITH EVERY KNOWN RULE, not built from the findings. `data_table` and `stat_strip` find
	// nothing on this tree — #3717 and #3718 fixed the last of each — and a table built only from
	// findings would simply not have a row for them. "Found nothing" would then be rendered exactly
	// like "was not run", in the one section whose whole job is that they never look the same.
	/** @type {Record<string, {total: number, decision: number, debt: number, unlisted: number, inPageClosure: number, chromeOnly: number, offTree: number, predicate: string|null, owner: string|null}>} */
	const byRule = {};
	for (const id of [...Object.keys(RULE_PREDICATE), ...Object.keys(RULES_WITHOUT_A_PREDICATE)]) {
		byRule[id] = {
			total: 0, decision: 0, debt: 0, unlisted: 0, inPageClosure: 0, chromeOnly: 0, offTree: 0,
			predicate: RULE_PREDICATE[id] ?? null,
			owner: RULES_WITHOUT_A_PREDICATE[id]?.owner ?? null,
		};
	}
	// PER OCCURRENCE, NOT PER FILE. The allowlist grants its exception per occurrence — an entry
	// says `hits: 2`, and a third occurrence in that file is new drift. Reading the ledger as "this
	// file is listed" would absorb that third one into `debt` and leave `unlisted` at 0, which is
	// the one column this section tells a reader to look at first. Verified by mutation: appending
	// one raw `<h2>` to an already-listed file must move `unlisted` from 0 to 1.
	/** @type {Map<string, {kind: string|null, left: number}>} */
	const listedBudget = new Map();
	for (const e of surface.entries) {
		const key = `${e.section}${KEY}${e.path}`;
		const prior = listedBudget.get(key);
		if (prior === undefined) listedBudget.set(key, { kind: e.kind, left: e.hits });
		else prior.left += e.hits;
	}
	/** @type {Map<string, number>} */
	const chromeFiles = new Map();
	/** @type {Map<string, number>} */
	const offTreeFiles = new Map();
	for (const f of surface.findings) {
		const row = (byRule[f.rule] ??= {
			total: 0, decision: 0, debt: 0, unlisted: 0, inPageClosure: 0, chromeOnly: 0, offTree: 0,
			predicate: RULE_PREDICATE[f.rule] ?? null,
			owner: RULES_WITHOUT_A_PREDICATE[f.rule]?.owner ?? null,
		});
		row.total += 1;
		const budget = listedBudget.get(`${f.rule}${KEY}${f.file}`);
		if (budget !== undefined && budget.left > 0) {
			budget.left -= 1;
			if (budget.kind === "decision") row.decision += 1;
			else row.debt += 1;
		} else {
			row.unlisted += 1;
		}
		if (inSomePage.has(f.file)) row.inPageClosure += 1;
		else if (chromeClosure.has(f.file)) {
			row.chromeOnly += 1;
			chromeFiles.set(f.file, (chromeFiles.get(f.file) ?? 0) + 1);
		} else {
			row.offTree += 1;
			offTreeFiles.set(f.file, (offTreeFiles.get(f.file) ?? 0) + 1);
		}
	}

	return {
		totals: {
			...run.totals,
			predicates: rubricPredicates.length,
			scoredHere: scoredIds.length,
			live: Object.values(NOT_SCORED_HERE).filter((v) => v.kind === "live").length,
			notInstrumented: Object.values(NOT_SCORED_HERE).filter((v) => v.kind === "none").length,
			findings: surface.findings.length,
			findingFiles: new Set(surface.findings.map((f) => f.file)).size,
		},
		ledgers: { baseline: surface.baseline, debt: surface.debt },
		predicates,
		routes: [...routes.values()].sort((a, b) => a.route.localeCompare(b.route)),
		verdicts,
		reconciliation: {
			byRule,
			chromeOnlyFiles: [...chromeFiles].sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0])).map(([file, hits]) => ({ file, hits })),
			offTreeFiles: [...offTreeFiles].sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0])).map(([file, hits]) => ({ file, hits })),
		},
	};
}

// ── rendering ────────────────────────────────────────────────────────────────────────────────

const pct = (v) => (v === null ? "—" : v.toFixed(2));
/**
 * One family cell.
 *
 * Three states, and they must not collapse into each other: a family with no instrument is `—`,
 * a family every one of whose predicates was N/A for this route is `all N/A` (a real answer, and
 * not a zero), and everything else is `PASS/scored · score`.
 */
const cell = (f) => {
	if (f.instrumented === 0) return "—";
	if (f.pass + f.fail === 0) return "all N/A";
	return `${f.pass}/${f.pass + f.fail} · ${pct(f.score)}`;
};

/** The generated region of `scoreboard.md`. No wall clock, no absolute path, no uncommitted input. */
export function renderScoreboard(view) {
	const L = [];
	const t = view.totals;

	L.push("## What this scored");
	L.push("");
	L.push(`**${t.routes} private routes** · ${t.redirectOnly} redirect-only · ${t.real} real pages.`);
	L.push("");
	L.push(`RUBRIC.md defines **${t.predicates} predicates**. This report scores **${t.scoredHere}** of them.`);
	L.push(`${t.live} are live and land here with #3634; ${t.notInstrumented} have no instrument anywhere today.`);
	L.push("");
	L.push("| source | what it contributes |");
	L.push("|---|---|");
	L.push("| `scripts/lib/console-routes.mjs` | the route set — the denominator of every number below |");
	L.push("| `scripts/check-route-states.mjs` | S1–S4, T1–T4, per route |");
	L.push(`| \`${ROUTE_STATES_BASELINE}\` | the ratchet those eight predicates are held to |`);
	L.push("| `scripts/check-shared-surface.mjs` | every H-family occurrence, per file |");
	L.push(`| \`${ALLOWLIST}\` | which occurrences are a recorded decision (\`baseline: ${view.ledgers.baseline}\`) and which are measured drift (\`debt: ${view.ledgers.debt}\`) |`);
	L.push(`| \`${RUBRIC}\` | the predicate set itself, read out of its own tables |`);
	L.push("");

	// ── instrument inventory ──────────────────────────────────────────────────────────────────
	L.push("## Which predicates have an instrument");
	L.push("");
	L.push("An un-instrumented predicate is rendered `—` everywhere below, never as a pass and never");
	L.push("omitted. The generator refuses to run unless every rubric predicate lands in exactly one row");
	L.push("of this table.");
	L.push("");
	L.push("| family | predicates | scored here | live (#3634) | no instrument |");
	L.push("|---|---:|---:|---:|---:|");
	const famRows = Object.entries(FAMILIES).map(([key, label]) => {
		const ids = Object.entries(view.predicates).filter(([, p]) => p.family === key);
		return {
			key,
			label,
			all: ids.length,
			here: ids.filter(([, p]) => p.instrument === "check-route-states" || p.instrument === "check-shared-surface").length,
			live: ids.filter(([, p]) => p.instrument === "live").length,
			none: ids.filter(([, p]) => p.instrument === "none").length,
		};
	});
	for (const r of famRows) L.push(`| **${r.key}** — ${r.label} | ${r.all} | ${r.here} | ${r.live} | ${r.none} |`);
	L.push(`| **total** | ${t.predicates} | ${t.scoredHere} | ${t.live} | ${t.notInstrumented} |`);
	L.push("");
	L.push("The un-instrumented eight, each with the issue that owns it:");
	L.push("");
	L.push("| id | owner | what is not being measured |");
	L.push("|---|---|---|");
	for (const [id, meta] of Object.entries(NOT_SCORED_HERE)) {
		if (meta.kind !== "none") continue;
		L.push(`| **${id}** | ${meta.owner} | ${meta.why} |`);
	}
	L.push("");

	// ── per predicate ─────────────────────────────────────────────────────────────────────────
	L.push("## Per predicate");
	L.push("");
	L.push("`score = PASS ÷ (PASS + FAIL)`. N/A leaves the denominator, so the N/A column is first-class:");
	L.push("a predicate whose N/A count grows is a predicate being escaped.");
	L.push("");
	L.push("| id | family | instrument | PASS | FAIL | N/A | score | N/A reasons |");
	L.push("|---|---|---|---:|---:|---:|---:|---|");
	const order = Object.keys(FAMILIES);
	const ids = Object.keys(view.predicates).sort((a, b) => {
		const fa = order.indexOf(view.predicates[a].family);
		const fb = order.indexOf(view.predicates[b].family);
		return fa - fb || Number(a.slice(1)) - Number(b.slice(1));
	});
	for (const id of ids) {
		const p = view.predicates[id];
		const instrument =
			p.instrument === "check-route-states" ? "`check-route-states`"
			: p.instrument === "check-shared-surface" ? "`check-shared-surface`"
			: p.instrument === "live" ? `live — ${p.owner}`
			: `**none** — ${p.owner}`;
		const scored = p.instrument === "check-route-states" || p.instrument === "check-shared-surface";
		const reasons = Object.entries(p.naReasons).sort().map(([r, n]) => `\`${r}\` ${n}`).join(", ");
		L.push(
			`| **${id}** | ${p.family} | ${instrument} | ${scored ? p.pass : "—"} | ${scored ? p.fail : "—"} | ` +
				`${scored ? p.na : "—"} | ${scored ? pct(p.score) : "—"} | ${reasons || "—"} |`,
		);
	}
	L.push("");
	L.push("The static H half emits **no N/A at all**, which is why those rows are empty rather than");
	L.push("carrying the rubric's `renders-no-table` / `renders-no-formatted-value` / `declares-no-z-index`.");
	L.push("A matcher cannot tell \"this page has no table\" from \"this page's table is correct\" — both are");
	L.push("zero findings — so claiming the N/A would shrink the denominator on evidence that does not bear");
	L.push("on it. Every page is asked, and a page with no table passes H4 by not hand-rolling one.");
	L.push("");

	// ── per route ─────────────────────────────────────────────────────────────────────────────
	L.push("## Per route");
	L.push("");
	L.push("Each cell is `PASS/scored · score` over that family's instrumented predicates —");
	L.push(`S ${famRows[0].here}/${famRows[0].all}, T ${famRows[1].here}/${famRows[1].all}, H ${famRows[2].here}/${famRows[2].all}, F ${famRows[3].here}/${famRows[3].all}, R ${famRows[4].here}/${famRows[4].all}. \`surface\` is the number of console modules the`);
	L.push("page's own import graph reaches, which is the denominator the H column was measured over.");
	L.push("");
	L.push("| route | surface | S | T | H | F | R | overall |");
	L.push("|---|---:|---|---|---|---|---|---|");
	for (const r of [...view.routes].sort((a, b) => (a.overall.score ?? 1) - (b.overall.score ?? 1) || a.route.localeCompare(b.route))) {
		L.push(
			`| \`${r.route}\`${r.redirectOnly ? " ·" : ""} | ${r.surfaceFiles} | ${cell(r.families.S)} | ${cell(r.families.T)} | ` +
				`${cell(r.families.H)} | ${cell(r.families.F)} | ${cell(r.families.R)} | **${pct(r.overall.score)}** |`,
		);
	}
	L.push("");
	L.push("`·` marks a redirect-only route: no JSX, a `redirect()` call. It is N/A for six of the eight");
	L.push("route-state predicates and passes the H rows on a closure of one file that renders nothing.");
	L.push("");

	// ── reconciliation ────────────────────────────────────────────────────────────────────────
	L.push("## Where every shared-surface occurrence landed");
	L.push("");
	L.push(`\`check-shared-surface\` found **${t.findings} occurrences across ${t.findingFiles} files**. This section`);
	L.push("accounts for all of them twice — once by ledger, once by reach — so a rule or a file falling out");
	L.push("of the scoreboard cannot be quiet.");
	L.push("");
	L.push("| rule | predicate | total | recorded decision | measured drift | unlisted | in a page's surface | shared chrome only | outside the private tree |");
	L.push("|---|---|---:|---:|---:|---:|---:|---:|---:|");
	const ruleIds = Object.keys(view.reconciliation.byRule).sort();
	const sum = { total: 0, decision: 0, debt: 0, unlisted: 0, inPageClosure: 0, chromeOnly: 0, offTree: 0 };
	for (const id of ruleIds) {
		const r = view.reconciliation.byRule[id];
		for (const k of Object.keys(sum)) sum[k] += r[k];
		L.push(
			`| \`${id}\` | ${r.predicate ?? `**none** — ${r.owner}`} | ${r.total} | ${r.decision} | ${r.debt} | ` +
				`${r.unlisted} | ${r.inPageClosure} | ${r.chromeOnly} | ${r.offTree} |`,
		);
	}
	L.push(
		`| **total** | | ${sum.total} | ${sum.decision} | ${sum.debt} | ${sum.unlisted} | ` +
			`${sum.inPageClosure} | ${sum.chromeOnly} | ${sum.offTree} |`,
	);
	L.push("");
	L.push("**`unlisted` is the column to read first.** A non-zero value means the guard is red — an");
	L.push("occurrence neither a `reason:` nor a `lifts:` entry accounts for. It is not a defect of this");
	L.push("report; run `pnpm check:shared-surface`.");
	L.push("");
	const em = RULES_WITHOUT_A_PREDICATE.empty_state;
	L.push(`**\`empty_state\` maps to no rubric predicate** (${em.owner}). ${em.why}`);
	L.push("");
	L.push(`**Reachable only from the shared layout chain** — ${view.reconciliation.chromeOnlyFiles.length} files. These are real`);
	L.push("occurrences in the sidebar, topbar, breadcrumbs and shells that every route renders. They are not");
	L.push("in any route's H column, because attributing the chrome's drift to all 40 routes would say the");
	L.push("console is 40 times worse than it is. The full list is in `ui-conformance-baseline.json`.");
	L.push("");
	L.push(`**Outside every private route's module graph** — ${view.reconciliation.offTreeFiles.length} files. Public routes (sign-in,`);
	L.push("onboarding, OAuth consent, accepting terms) and modules no private page imports. The route manifest");
	L.push("is scoped to `app/(private)`, so these are outside the rubric's stated subject and are listed here");
	L.push("rather than scored:");
	L.push("");
	L.push("| file | occurrences |");
	L.push("|---|---:|");
	for (const f of view.reconciliation.offTreeFiles) L.push(`| \`${f.file}\` | ${f.hits} |`);
	L.push("");
	L.push(`_Generated by \`apps/console/scripts/audit-report.mjs\`. Do not edit below the marker — run \`pnpm -C apps/console run audit:report --write\`._`);
	return L.join("\n");
}

/** The machine-readable half. Fully generated, so a merge conflict is resolved by regenerating. */
export function renderJson(view) {
	const round = (v) => (v === null ? null : Number(v.toFixed(4)));
	const body = {
		$comment: [
			"DERIVED — a report, not a source of truth. Never hand-edit; run `pnpm -C apps/console run audit:report --write`.",
			`The two ledgers this view is derived from are ${ROUTE_STATES_BASELINE} and ${ALLOWLIST}.`,
			"A merge conflict in this file is resolved by taking either side and regenerating.",
		],
		version: 1,
		generator: "apps/console/scripts/audit-report.mjs",
		sources: {
			routes: "scripts/lib/console-routes.mjs",
			routeStates: `scripts/check-route-states.mjs · ${ROUTE_STATES_BASELINE}`,
			sharedSurface: `${SHARED_SURFACE} · ${ALLOWLIST}`,
			rubric: RUBRIC,
		},
		totals: view.totals,
		ledgers: view.ledgers,
		predicates: Object.fromEntries(
			Object.entries(view.predicates).map(([id, p]) => [
				id,
				{
					family: p.family,
					instrument: p.instrument,
					owner: p.owner,
					...(p.instrument === "live" || p.instrument === "none"
						? {}
						: { pass: p.pass, fail: p.fail, na: p.na, naReasons: p.naReasons, score: round(p.score) }),
				},
			]),
		),
		routes: view.routes.map((r) => ({
			route: r.route,
			redirectOnly: r.redirectOnly,
			surfaceFiles: r.surfaceFiles,
			families: Object.fromEntries(
				Object.entries(r.families).map(([k, f]) => [
					k,
					{ instrumented: f.instrumented, of: f.of, pass: f.pass, fail: f.fail, na: f.na, score: round(f.score) },
				]),
			),
			overall: { ...r.overall, score: round(r.overall.score) },
		})),
		verdicts: view.verdicts,
		reconciliation: view.reconciliation,
	};
	return `${JSON.stringify(body, null, "\t")}\n`;
}

/** Replace the generated region. Hard-errors on a missing or duplicated marker. */
export function splice(existing, generated) {
	const begins = existing.split(BEGIN).length - 1;
	const ends = existing.split(END).length - 1;
	if (begins === 0 || ends === 0) {
		throw new Error(`${SCOREBOARD}: missing the generated-region markers. Expected exactly one ${BEGIN} and one ${END}.`);
	}
	if (begins > 1 || ends > 1) {
		throw new Error(
			`${SCOREBOARD}: found ${begins} BEGIN and ${ends} END markers — expected exactly one of each. ` +
				`Splicing into the first of two silently orphans everything after the second; refusing to guess.`,
		);
	}
	const head = existing.slice(0, existing.indexOf(BEGIN) + BEGIN.length);
	const tail = existing.slice(existing.indexOf(END));
	return `${head}\n\n${generated}\n\n${tail}`;
}

// ── the run ──────────────────────────────────────────────────────────────────────────────────

/**
 * Score one tree. Raises rather than reporting a clean board on any broken input — the manifest's
 * own zero-route raise passes straight through, and the four controls below are checked first.
 *
 * @param {string} repoRoot
 */
export function runReport(repoRoot) {
	const control = positiveControl();
	if (control.length > 0) {
		throw new Error(
			`the route-state positive control is BROKEN — refusing to score the tree.\n  ${control.join("\n  ")}\n` +
				`A predicate that no longer fires cannot tell a clean tree from a tree it stopped reading.`,
		);
	}

	const abs = (rel) => path.join(repoRoot, rel);
	const consoleDir = path.join(repoRoot, "apps", "console");
	const readFile = (p) => readFileSync(p, "utf8");
	/** @param {string} p @returns {"file"|"dir"|null} */
	const kindOf = (p) => {
		try {
			const s = statSync(p);
			return s.isDirectory() ? "dir" : "file";
		} catch {
			return null;
		}
	};

	const rubric = parseRubric(readFile(abs(RUBRIC)));
	const run = runOver(repoRoot);
	if (run.manifest.routes.length === 0) {
		throw new Error("the route manifest returned zero routes — a broken scan, not an empty app.");
	}

	const surface = readSharedSurface(repoRoot);
	const vacuity = scanVacuityProblems(surface.census, surface.unterminated);
	if (vacuity.length > 0) {
		throw new Error(`the shared-surface scan did not read the console:\n  - ${vacuity.join("\n  - ")}`);
	}

	const io = { readFile, kindOf, repoRoot, consoleDir };
	/** @type {Map<string, Set<string>>} */
	const pageClosures = new Map();
	/** @type {Set<string>} */
	const chromeClosure = new Set();
	for (const r of run.manifest.routes) {
		pageClosures.set(r.route, moduleClosure([abs(r.file)], io));
		for (const f of moduleClosure(r.layoutChain.map(abs), io)) chromeClosure.add(f);
	}

	return buildView({ run, rubricPredicates: rubric.predicates, surface, pageClosures, chromeClosure });
}

// ── self-test ────────────────────────────────────────────────────────────────────────────────

function selfTest() {
	let failures = 0;
	/** @param {string} what @param {boolean} cond */
	const ok = (what, cond) => {
		if (cond) {
			console.log(`ok   - ${what}`);
			return;
		}
		failures += 1;
		console.error(`FAIL - ${what}`);
	};
	/** @param {string} what @param {() => unknown} fn @param {string} needle */
	const raises = (what, fn, needle) => {
		try {
			fn();
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			ok(`${what} (${needle})`, msg.includes(needle));
			return;
		}
		failures += 1;
		console.error(`FAIL - ${what}: it did not raise`);
	};

	// ── the rubric is the predicate universe ─────────────────────────────────────────────────
	const RUBRIC_FIXTURE = [
		"# r",
		"**5 predicates** over every private route.",
		"| id | predicate | PASS when | N/A when |",
		"|---|---|---|---|",
		"| **S1** | a | b | c |",
		"| **T1** | a | b | c |",
		"| **H1** | a | b | c |",
		"| **F1** | a | b | c |",
		"| **R1** | a | b | c |",
		"| `/x` | not a predicate row | 1 | FAIL |",
	].join("\n");
	const parsed = parseRubric(RUBRIC_FIXTURE);
	ok("the rubric's tables are the predicate set", parsed.predicates.length === 5 && parsed.stated === 5);
	ok("...and a non-predicate table row is not mistaken for one", parsed.predicates.every((p) => /^[STHFR]\d+$/.test(p.id)));
	raises("a stated count that disagrees with the tables RAISES", () => parseRubric(RUBRIC_FIXTURE.replace("**5 predicates**", "**26 predicates**")), "and its tables define 5");
	raises("a rubric with no predicate rows RAISES rather than scoring 0/0", () => parseRubric("# r\n**5 predicates**\nno tables"), "no predicate rows");
	raises("a rubric that states no count RAISES", () => parseRubric(RUBRIC_FIXTURE.replace("**5 predicates**", "twenty-six predicates")), "does not state its own predicate count");
	raises("a predicate defined twice RAISES", () => parseRubric(RUBRIC_FIXTURE.replace("| **T1** |", "| **S1** |")), "S1 is defined twice");

	// THE REAL RUBRIC, because the fixture above proves the parser and not the file it will read.
	const realRubric = parseRubric(readFileSync(path.join(REPO_ROOT, RUBRIC), "utf8"));
	ok(
		`the real ${RUBRIC} defines 33 predicates, in five families`,
		realRubric.predicates.length === 33 &&
			[...new Set(realRubric.predicates.map((p) => p.family))].sort().join("") === "FHRST",
	);
	const perFamily = {};
	for (const p of realRubric.predicates) perFamily[p.family] = (perFamily[p.family] ?? 0) + 1;
	ok(
		"...S1-S4 (4), T1-T7 (7), H1-H8 (8), F1-F7 (7), R1-R7 (7)",
		perFamily.S === 4 && perFamily.T === 7 && perFamily.H === 8 && perFamily.F === 7 && perFamily.R === 7,
	);

	// ── the partition: every predicate lands in exactly one bucket ───────────────────────────
	const scoredIds = [...ROUTE_STATE_PREDICATES, ...Object.values(RULE_PREDICATE)];
	const part = partitionPredicates(realRubric.predicates, scoredIds, NOT_SCORED_HERE);
	ok("15 predicates are scored here — S1-S4, T1-T4 and seven H rows", part.scored.length === 15);
	ok("10 are live and owned by #3634", part.live.length === 10 && part.live.every((id) => NOT_SCORED_HERE[id].owner === "#3634"));
	ok("8 have no instrument anywhere — H3 and all seven F rows", part.none.sort().join(",") === "F1,F2,F3,F4,F5,F6,F7,H3");
	ok("...and every one of those eight names an owning issue", part.none.every((id) => /^#\d+$/.test(NOT_SCORED_HERE[id].owner)));
	raises(
		"a rubric predicate in NEITHER table RAISES rather than vanishing from the report",
		() => partitionPredicates([...realRubric.predicates, { id: "S9", family: "S" }], scoredIds, NOT_SCORED_HERE),
		"S9 is defined by RUBRIC.md and this report neither scores it",
	);
	raises(
		"a declared predicate the rubric does not define RAISES",
		() => partitionPredicates(realRubric.predicates, scoredIds, { ...NOT_SCORED_HERE, Z1: { kind: "none", owner: "#1", why: "x" } }),
		"Z1 is declared not-scored and RUBRIC.md does not define it",
	);
	raises(
		"a predicate that is both scored and declared not-scored RAISES",
		() => partitionPredicates(realRubric.predicates, [...scoredIds, "H3"], NOT_SCORED_HERE),
		"H3 is both scored here and declared not-scored",
	);

	// ── the rule-id → H-family mapping, pinned pair by pair ──────────────────────────────────
	ok("page_title → H1", RULE_PREDICATE.page_title === "H1");
	ok("section_header → H2", RULE_PREDICATE.section_header === "H2");
	ok("data_table → H4", RULE_PREDICATE.data_table === "H4");
	ok("format → H5", RULE_PREDICATE.format === "H5");
	ok("stat_strip → H6", RULE_PREDICATE.stat_strip === "H6");
	ok("layer_token → H7", RULE_PREDICATE.layer_token === "H7");
	ok("type_scale → H8", RULE_PREDICATE.type_scale === "H8");
	ok("H3 is mapped by NO rule — StatusBadge has no matcher", !Object.values(RULE_PREDICATE).includes("H3"));
	ok(
		"empty_state maps to no predicate, and says so with an owner",
		!("empty_state" in RULE_PREDICATE) && /^#\d+$/.test(RULES_WITHOUT_A_PREDICATE.empty_state.owner),
	);
	ok(
		"the seven mapped rules are exactly the seven instrumented H rows",
		[...new Set(Object.values(RULE_PREDICATE))].sort().join(",") === "H1,H2,H4,H5,H6,H7,H8",
	);

	// ── import resolution ────────────────────────────────────────────────────────────────────
	/** A fake tree: paths → contents. Directories are inferred from the paths. */
	const tree = (files) => {
		const dirs = new Set();
		for (const p of Object.keys(files)) {
			const parts = p.split("/");
			for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join("/"));
		}
		return {
			readFile: (p) => {
				const key = p.split(path.sep).join("/");
				if (!(key in files)) throw new Error(`fixture has no ${key}`);
				return files[key];
			},
			kindOf: (p) => {
				const key = p.split(path.sep).join("/");
				if (key in files) return "file";
				if (dirs.has(key)) return "dir";
				return null;
			},
			repoRoot: "/r",
			consoleDir: "/r/apps/console",
		};
	};

	const graph = tree({
		"/r/apps/console/app/(private)/x/page.tsx": 'import { A } from "@/components/a";\nimport { B } from "./local";\n',
		"/r/apps/console/components/a.tsx": 'import { C } from "@/lib/c";\nconst dyn = () => import("@/components/lazy");\n',
		"/r/apps/console/components/lazy.tsx": "export const L = 1;",
		"/r/apps/console/lib/c/index.ts": 'import { A } from "@/components/a";\n',
		"/r/apps/console/app/(private)/x/local.tsx": '// import { Ghost } from "@/components/ghost";\nexport const B = 1;',
	});
	const closed = moduleClosure(["/r/apps/console/app/(private)/x/page.tsx"], graph);
	ok(
		"a page's closure follows @/ and relative imports, and a directory index",
		closed.has("apps/console/components/a.tsx") && closed.has("apps/console/lib/c/index.ts") && closed.has("apps/console/app/(private)/x/local.tsx"),
	);
	ok("...and a dynamic import(), because a lazily mounted panel is still rendered", closed.has("apps/console/components/lazy.tsx"));
	ok("...and an import inside a COMMENT is not followed", !closed.has("apps/console/components/ghost.tsx"));
	ok("...and an import cycle terminates", closed.size === 5);
	raises(
		"an unresolvable @/ specifier RAISES rather than silently shortening the closure",
		() => moduleClosure(["/r/a.tsx"], tree({ "/r/a.tsx": 'import { X } from "@/components/gone";' })),
		"cannot resolve `@/components/gone`",
	);
	ok(
		"an external specifier is not followed and does not raise",
		moduleClosure(["/r/a.tsx"], tree({ "/r/a.tsx": 'import { Button } from "@repo/ui/button";\nimport React from "react";' })).size === 1,
	);
	raises(
		"a file whose block comment never closes RAISES rather than reporting no imports",
		() => moduleClosure(["/r/a.tsx"], tree({ "/r/a.tsx": '/* never closed\nimport { X } from "@/components/x";' })),
		"still open at EOF",
	);

	// ── vacuity ──────────────────────────────────────────────────────────────────────────────
	const NUL = "\u0000";
	ok("a healthy census is clean", scanVacuityProblems([[`s${NUL}apps/console/components${NUL}.tsx`, 10]], []).length === 0);
	ok("an EMPTY census is a problem, not a pass", scanVacuityProblems([], []).some((p) => p.includes("EMPTY census")));
	ok(
		"a root that examined zero files is a problem",
		scanVacuityProblems([[`s${NUL}apps/console/components${NUL}.tsx`, 10], [`s${NUL}apps/console/app${NUL}.tsx`, 0]], [])
			.some((p) => p.includes("root apps/console/app")),
	);
	ok(
		"...and so is an extension that examined zero files",
		scanVacuityProblems([[`s${NUL}apps/console/components${NUL}.tsx`, 10], [`s${NUL}apps/console/components${NUL}.ts`, 0]], [])
			.some((p) => p.includes("ext .ts")),
	);
	ok("an unterminated file is a problem", scanVacuityProblems([[`s${NUL}r${NUL}.tsx`, 1]], ["apps/console/x.tsx"]).some((p) => p.includes("has not read it")));
	// The separator belongs to a module that does not export it. If it ever stops being a control
	// character, the axes must become unreadable LOUDLY rather than parse into one bucket and read
	// as "every axis is fine" — which is the same green-over-nothing this whole function exists for.
	ok(
		"a census key that is no longer scope-SEP-root-SEP-ext is a problem, not a silent mis-parse",
		scanVacuityProblems([["s|apps/console/components|.tsx", 10]], []).some((p) => p.includes("the scan's shape changed")),
	);

	// ── the merge, on a fixture that separates every case ────────────────────────────────────
	const fixtureRubric = parseRubric(readFileSync(path.join(REPO_ROOT, RUBRIC), "utf8")).predicates;
	const fixtureRun = {
		totals: { routes: 3, redirectOnly: 1, real: 2 },
		manifest: {
			routes: [
				{ route: "/a", isRedirectOnly: false },
				{ route: "/b", isRedirectOnly: false },
				{ route: "/r", isRedirectOnly: true },
			],
		},
		scored: Object.fromEntries(
			ROUTE_STATE_PREDICATES.map((id) => [
				id,
				id === "S2"
					? { pass: ["/a"], fail: [{ route: "/b", detail: "two widths" }], na: { "redirect-only": ["/r"] } }
					: { pass: ["/a", "/b", "/r"], fail: [], na: {} },
			]),
		),
	};
	const fixtureSurface = {
		baseline: 2,
		debt: 1,
		findings: [
			// /a's own component: two type_scale hits, both recorded DEBT — still a FAIL.
			{ rule: "type_scale", file: "apps/console/components/a.tsx", line: 1, text: "text-[13px]" },
			{ rule: "type_scale", file: "apps/console/components/a.tsx", line: 2, text: "text-[13px]" },
			// /b's own component: one page_title, a recorded DECISION — excused, so PASS.
			{ rule: "page_title", file: "apps/console/components/b.tsx", line: 1, text: "<h1" },
			// a shared chrome file: in no page closure.
			{ rule: "format", file: "apps/console/components/shell/side.tsx", line: 1, text: ".toFixed(" },
			// outside the private tree entirely.
			{ rule: "format", file: "apps/console/components/auth/form.tsx", line: 1, text: ".toFixed(" },
			// mapped to no predicate: counted, scored nowhere.
			{ rule: "empty_state", file: "apps/console/components/a.tsx", line: 9, text: "text-center py-8" },
		],
		entries: [
			{ section: "page_title", path: "apps/console/components/b.tsx", hits: 1, kind: "decision" },
			{ section: "type_scale", path: "apps/console/components/a.tsx", hits: 2, kind: "debt" },
			{ section: "empty_state", path: "apps/console/components/a.tsx", hits: 1, kind: "debt" },
		],
	};
	const view = buildView({
		run: fixtureRun,
		rubricPredicates: fixtureRubric,
		surface: fixtureSurface,
		pageClosures: new Map([
			["/a", new Set(["apps/console/app/a/page.tsx", "apps/console/components/a.tsx"])],
			["/b", new Set(["apps/console/app/b/page.tsx", "apps/console/components/b.tsx"])],
			["/r", new Set(["apps/console/app/r/page.tsx"])],
		]),
		chromeClosure: new Set(["apps/console/components/shell/side.tsx"]),
	});
	const verdict = (route, predicate) => view.verdicts.find((v) => v.route === route && v.predicate === predicate);
	ok("a finding in a page's own surface FAILS that page", verdict("/a", "H8").verdict === "FAIL");
	ok("...and does NOT fail a page that does not import it", verdict("/b", "H8").verdict === "PASS");
	ok("a `lifts:` (debt) entry does NOT excuse the occurrence — RUBRIC.md's H8 rule", view.predicates.H8.fail === 1);
	ok("a `reason:` (decision) entry DOES excuse it", verdict("/b", "H1").verdict === "PASS" && view.predicates.H1.fail === 0);
	ok("a chrome-only finding fails NO route", verdict("/a", "H5").verdict === "PASS" && verdict("/b", "H5").verdict === "PASS");
	ok("a redirect-only route passes the H rows on an empty surface", verdict("/r", "H8").verdict === "PASS");
	ok(
		"the static H half emits no N/A at all",
		Object.values(RULE_PREDICATE).every((id) => view.predicates[id].na === 0 && Object.keys(view.predicates[id].naReasons).length === 0),
	);
	ok("a route-state N/A flows through with its reason", verdict("/r", "S2").verdict === "N/A" && verdict("/r", "S2").reason === "redirect-only");
	ok("...and N/A leaves the denominator: S2 is 1 PASS / 1 FAIL / 1 N/A = 0.50", view.predicates.S2.score === 0.5);
	ok("score is null, not 0, when nothing was measured", scoreOf(0, 0) === null && view.predicates.H3.score === null);
	ok(
		"an un-instrumented predicate is scored nowhere and carries its owner",
		view.predicates.F7.instrument === "none" && view.predicates.F7.owner === NOT_SCORED_HERE.F7.owner && view.predicates.F7.pass === 0,
	);
	ok("a live predicate is likewise not scored here", view.predicates.R2.instrument === "live" && view.predicates.R2.pass === 0);
	ok(
		"the F column reports as not-instrumented, not as a pass",
		view.routes.every((r) => r.families.F.instrumented === 0 && r.families.F.score === null) && cell(view.routes[0].families.F) === "—",
	);
	ok("...and the T column is 4 of the family's 7", view.routes[0].families.T.instrumented === 4 && view.routes[0].families.T.of === 7);

	// RECONCILIATION: every finding is accounted for on both axes, and the two axes agree.
	const rec = view.reconciliation.byRule;
	const total = Object.values(rec).reduce((n, r) => n + r.total, 0);
	const byLedger = Object.values(rec).reduce((n, r) => n + r.decision + r.debt + r.unlisted, 0);
	const byReach = Object.values(rec).reduce((n, r) => n + r.inPageClosure + r.chromeOnly + r.offTree, 0);
	ok("every finding is accounted for by ledger", total === fixtureSurface.findings.length && byLedger === total);
	ok("...and by reach, independently", byReach === total);
	ok("a chrome-only file is named", view.reconciliation.chromeOnlyFiles.some((f) => f.file.endsWith("shell/side.tsx")));
	ok("an off-tree file is named", view.reconciliation.offTreeFiles.some((f) => f.file.endsWith("auth/form.tsx")));
	ok("empty_state is counted with an owner and no predicate", rec.empty_state.total === 1 && rec.empty_state.predicate === null && rec.empty_state.owner === "#3798");
	// "Found nothing" and "was not run" must not render the same. The fixture trips six of the
	// eight rules; the other two must still have a row, reading 0.
	ok(
		"a rule that found NOTHING still gets a row reading 0, rather than no row at all",
		Object.keys(rec).length === 8 && rec.data_table.total === 0 && rec.stat_strip.total === 0,
	);
	ok("...and it is rendered", renderScoreboard(view).includes("| `stat_strip` | H6 | 0 |"));
	ok(
		"a family whose every predicate is N/A for a route reads `all N/A`, not `0/0`",
		cell({ instrumented: 4, of: 4, pass: 0, fail: 0, na: 4, score: null }) === "all N/A",
	);
	// THE LEDGER IS PER OCCURRENCE. An entry declaring 2 hits does not absorb a third — that third
	// is new drift, `check-shared-surface` is red on it, and `unlisted` is the column this report
	// tells a reader to look at first. Reading the ledger per FILE hides it, and hides it in the
	// direction that reports a clean board.
	const overflowed = buildView({
		run: fixtureRun,
		rubricPredicates: fixtureRubric,
		surface: {
			...fixtureSurface,
			findings: [...fixtureSurface.findings, { rule: "type_scale", file: "apps/console/components/a.tsx", line: 3, text: "text-[13px]" }],
		},
		pageClosures: new Map([["/a", new Set(["apps/console/components/a.tsx"])], ["/b", new Set()], ["/r", new Set()]]),
		chromeClosure: new Set(),
	});
	ok(
		"a third occurrence in a file whose entry declares two is UNLISTED, not absorbed into debt",
		overflowed.reconciliation.byRule.type_scale.debt === 2 && overflowed.reconciliation.byRule.type_scale.unlisted === 1,
	);
	raises(
		"a rule id that maps to nothing and is not declared unmapped RAISES",
		() =>
			buildView({
				run: fixtureRun,
				rubricPredicates: fixtureRubric,
				surface: { ...fixtureSurface, findings: [...fixtureSurface.findings, { rule: "brand_new_rule", file: "apps/console/components/a.tsx", line: 1, text: "x" }] },
				pageClosures: new Map([["/a", new Set()], ["/b", new Set()], ["/r", new Set()]]),
				chromeClosure: new Set(),
			}),
		"brand_new_rule",
	);
	raises(
		"...including one that only appears in the allowlist",
		() =>
			buildView({
				run: fixtureRun,
				rubricPredicates: fixtureRubric,
				surface: { ...fixtureSurface, entries: [...fixtureSurface.entries, { section: "ghost_rule", path: "x", hits: 1, kind: "debt" }] },
				pageClosures: new Map([["/a", new Set()], ["/b", new Set()], ["/r", new Set()]]),
				chromeClosure: new Set(),
			}),
		"ghost_rule",
	);

	// ── rendering ────────────────────────────────────────────────────────────────────────────
	const md = renderScoreboard(view);
	ok("the rendered scoreboard names the F family as un-instrumented, with its issue", md.includes("| **F7** |") && md.includes(NOT_SCORED_HERE.F7.owner));
	ok("...and H3 too", md.includes("| **H3** |") && md.includes(NOT_SCORED_HERE.H3.owner));
	// Not "does it say `—` somewhere" — every numeric column of every un-instrumented row must be
	// a dash. A 0.00 there would read as "measured, and failed everywhere", which is the opposite
	// of what is true and the exact confusion this column exists to prevent.
	const noneRows = md.split("\n").filter((l) => /^\| \*\*(?:F\d|H3)\*\* \| [FH] \| \*\*none\*\*/.test(l));
	ok(
		"...and every un-instrumented row's PASS / FAIL / N/A / score columns are all dashes",
		noneRows.length === 8 && noneRows.every((l) => l.endsWith("| — | — | — | — | — |")),
	);
	ok("rendering is deterministic", renderScoreboard(view) === md && renderJson(view) === renderJson(view));
	ok(
		"NO WALL CLOCK reaches the diff-gated region — a date there makes every PR stale on arrival",
		!/\d{4}-\d{2}-\d{2}/.test(md) && !/\d{4}-\d{2}-\d{2}/.test(renderJson(view)),
	);
	ok("...and no absolute path either", !md.includes(REPO_ROOT) && !renderJson(view).includes(REPO_ROOT));
	const parsedJson = JSON.parse(renderJson(view));
	ok("the JSON carries one record per (route, predicate) it scored", parsedJson.verdicts.length === 3 * 15);
	ok("...in the shape e2e/audit/report.ts writes, so #3634 can concatenate", parsedJson.verdicts.every((v) => "route" in v && "predicate" in v && "verdict" in v));

	// ── splice ───────────────────────────────────────────────────────────────────────────────
	const shell = `# t\n\nintent\n\n${BEGIN}\nold\n${END}\n\ntail\n`;
	ok("splice replaces only the generated region", splice(shell, "new").includes("new") && splice(shell, "new").includes("intent") && splice(shell, "new").includes("tail") && !splice(shell, "new").includes("old"));
	raises("a missing marker RAISES", () => splice("# t\nno markers\n", "new"), "missing the generated-region markers");
	raises("a DUPLICATED marker RAISES rather than orphaning the second region", () => splice(`${shell}${BEGIN}\n${END}\n`, "new"), "expected exactly one of each");

	console.log(failures === 0 ? "\nself-test: all passed" : `\nself-test: ${failures} FAILED`);
	return failures === 0 ? 0 : 1;
}

// ── CLI ──────────────────────────────────────────────────────────────────────────────────────

export const USAGE = [
	"Usage: node apps/console/scripts/audit-report.mjs [--write|--json|--self-test|--help]",
	"",
	"  (no argument)  check the generated files are in sync with the tree; exit 2 if not",
	"  --write        regenerate apps/console/docs/ui-conformance/scoreboard.md and",
	"                 apps/console/ui-conformance-baseline.json",
	"  --json         print the derived view; write nothing",
	"  --self-test    run the fixture suite; exit 1 on any failure",
	"  --help, -h     this text",
].join("\n");

/**
 * The whole argument parser. An unrecognised argument is an ERROR, never a fall-through to the
 * default mode: a caller's typo must not be indistinguishable from a successful run.
 */
export function parseCliArgs(argv) {
	const MODES = { "--write": "write", "--json": "json", "--self-test": "self-test", "--help": "help", "-h": "help" };
	if (argv.length === 0) return { mode: "check", error: null };
	const unknown = argv.filter((a) => !(a in MODES));
	if (unknown.length > 0) return { mode: null, error: `unrecognised argument${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")}` };
	if (argv.some((a) => MODES[a] === "help")) return { mode: "help", error: null };
	const distinct = [...new Set(argv.map((a) => MODES[a]))];
	if (distinct.length > 1) return { mode: null, error: `${distinct.join(" and ")} cannot both be asked for` };
	return { mode: distinct[0], error: null };
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
	const parsed = parseCliArgs(process.argv.slice(2));
	if (parsed.error !== null) {
		console.error(`audit-report: ${parsed.error}\n\n${USAGE}`);
		process.exit(2);
	}
	if (parsed.mode === "help") {
		console.log(USAGE);
		process.exit(0);
	}
	if (parsed.mode === "self-test") {
		try {
			process.exit(selfTest());
		} catch (err) {
			console.error(`\nFAIL - the self-test raised before it could report: ${err instanceof Error ? err.stack : err}`);
			console.error("self-test: 1 FAILED");
			process.exit(1);
		}
	}

	// Every raise below this line is a REFUSAL, not a finding, and it is printed as one. The three
	// that have been driven rather than reasoned about: the private route group renamed (the
	// manifest's own raise, passed straight through), a module a page imports deleted (the closure
	// refusing to shorten silently), and a scope root moved out from under the shared-surface scan.
	// A stack trace answers none of those; the message does, and exiting 1 keeps them distinct from
	// the staleness exit 2 that a lane sees every day.
	/** @type {ReturnType<typeof runReport>} */
	let view;
	try {
		view = runReport(REPO_ROOT);
	} catch (err) {
		console.error(`audit-report: ${err instanceof Error ? err.message : String(err)}`);
		console.error(
			"\nThis is a refusal to report, not a clean board. A scoreboard produced over a tree this " +
				"could not fully read would say the console is fine about pages it never looked at.",
		);
		process.exit(1);
	}

	if (parsed.mode === "json") {
		console.log(renderJson(view));
		process.exit(0);
	}

	const mdPath = path.join(REPO_ROOT, SCOREBOARD);
	const jsonPath = path.join(REPO_ROOT, BASELINE_JSON);
	const wantMd = splice(readFileSync(mdPath, "utf8"), renderScoreboard(view));
	const wantJson = renderJson(view);

	const t = view.totals;
	const summary =
		`${t.routes} routes · ${t.scoredHere} of ${t.predicates} predicates scored · ` +
		`${t.findings} shared-surface occurrence(s) across ${t.findingFiles} file(s)`;

	if (parsed.mode === "write") {
		writeFileSync(mdPath, wantMd);
		writeFileSync(jsonPath, wantJson);
		console.log(`wrote ${SCOREBOARD} and ${BASELINE_JSON} — ${summary}`);
		process.exit(0);
	}

	const stale = [];
	if (readFileSync(mdPath, "utf8") !== wantMd) stale.push(SCOREBOARD);
	if (readFileSync(jsonPath, "utf8") !== wantJson) stale.push(BASELINE_JSON);
	if (stale.length > 0) {
		for (const f of stale) console.error(`::error::audit-report: ${f} is STALE — run \`pnpm -C apps/console run audit:report --write\` and commit.`);
		console.error(`\naudit-report: ${stale.length} generated file(s) do not match the tree (${summary}).`);
		process.exit(2);
	}
	console.log(`audit-report: ${SCOREBOARD} and ${BASELINE_JSON} are in sync — ${summary}`);
}
