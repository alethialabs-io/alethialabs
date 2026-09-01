#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
//
// The route-state gate: predicates S1–S4 and T1–T4 of
// `apps/console/docs/ui-conformance/RUBRIC.md`, scored over every private console route.
//
//   node scripts/check-route-states.mjs                 # score the real tree against the baseline
//   node scripts/check-route-states.mjs --json          # the same, as JSON
//   node scripts/check-route-states.mjs --routes        # one line per route per predicate
//   node scripts/check-route-states.mjs --print-baseline# the YAML the current tree would need
//   node scripts/check-route-states.mjs --self-test     # the fixture suite
//   node scripts/check-route-states.mjs --help
//
// `pnpm check:route-states` DOES NOT EXIST YET. Adding the alias means editing the root
// `package.json`, which is outside this unit's scope (see #3616's `scope:` line), so the script is
// runnable as `node scripts/check-route-states.mjs` and whoever owns `package.json` adds the alias
// and the CI step. Stated here rather than implied, because a check nothing invokes is a check
// that reports green by never running.
//
// ── WHY IT READS THE MANIFEST AND DOES NOT WALK THE TREE ─────────────────────────────────────
//
// The route set comes from `scripts/lib/console-routes.mjs` and from nowhere else. Two definitions
// of "the console's private routes" means two denominators, and a score whose denominator came
// from somewhere else cannot distinguish a route that failed from a route that was never visited.
// The manifest RAISES on a zero-route tree; this file does not catch that into a green — a throw
// out of `collectConsoleRoutes()` exits non-zero here with the manifest's own message.
//
// ── WHAT THIS FILE READS THAT THE MANIFEST DOES NOT ──────────────────────────────────────────
//
// Predicates S2–S4 are about a max-width, and the manifest carries no width. So this file resolves
// one, from files the RECORD names: the page (`record.file`), the nearest loading boundary
// (`record.boundaries.loading.file`), the layouts (`record.layoutChain`) and the shells
// (`manifest.shells`). It never discovers a file by walking — every path it opens was handed to it.
//
// A "content width" is a centred block: a class list carrying BOTH `mx-auto` and a `max-w-*`.
// That discriminator is not decoration. `max-w-[380px]` on a table cell, `max-w-md` on an empty
// state and `max-w-xs` on a truncating column are widths of things inside the page, not of the
// page, and a predicate that counted them would report nearly every route as "sets a width" and
// measure nothing. Measured over the real tree, `mx-auto` + `max-w-*` selects exactly one width
// per file and zero of those inner constraints.
//
// Requiring `w-full` as well was tried and REJECTED: `[project]/environments/loading.tsx` is
// `mx-auto max-w-3xl` and `~/support/page.tsx` is `relative mx-auto max-w-4xl`, and both are page
// containers. A rule requiring `w-full` is blind to two of the defects this gate exists to find,
// including one the issue itself names.
//
// ── THE PERMANENT POSITIVE CONTROL ───────────────────────────────────────────────────────────
//
// EVERY run — not just `--self-test` — scores two fixture trees before it scores the real one:
// a `probe` tree in which each predicate has a route it MUST fail, and an `antiProbe` tree in
// which each has a route it MUST pass. If a predicate stops firing, the gate refuses to report on
// the real tree at all. This is what keeps the check honest after the baseline reaches zero: a
// predicate that can no longer fail is indistinguishable from a clean tree, and every other guard
// in this repo that got that wrong reported green for months.
//
// Do NOT pipe it. `node scripts/check-route-states.mjs | tail` reports TAIL's exit code.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { collectConsoleRoutes, stripCommentLines } from "./lib/console-routes.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..");
const BASELINE_FILE = path.join("apps", "console", "route-states-baseline.yaml");

/** The predicates this file implements, in rubric order. */
export const PREDICATES = /** @type {const} */ (["S1", "S2", "S3", "S4", "T1", "T2", "T3", "T4"]);

/** One line of the rubric's table, for the report. */
const TITLES = {
	S1: "the page renders inside a known shell",
	S2: "exactly one max-width governs the content, and it comes from the shell",
	S3: "the loading skeleton is the same width as the page",
	S4: "no page-local duplicate of a shell constraint",
	T1: "the loading skeleton is the page's own, or a correct ancestor's",
	T2: "an error boundary covers the segment",
	T3: "notFound() has a not-found.tsx scoped to the same resource",
	T4: "the page declares metadata",
};

/**
 * The FIXED set of N/A reasons each predicate may return — RUBRIC.md's "N/A is where a rubric goes
 * wrong", rule 1. A reason outside its predicate's set is an ERROR, not an N/A: the failure this
 * closes is a caveat added to make a hard page stop failing, which raises the score by shrinking
 * the denominator and shows up nowhere.
 *
 * T2 and T4 declare the EMPTY set on purpose. The rubric says "never" for both — every route can
 * throw, and a redirect still owns a title — so a redirect-only page is scored, not excused.
 */
export const NA_REASONS = /** @type {const} */ ({
	S1: ["redirect-only"],
	S2: ["redirect-only"],
	S3: ["redirect-only", "no-loading-boundary"],
	S4: ["redirect-only"],
	T1: ["redirect-only"],
	T2: [],
	T3: ["does-not-call-not-found"],
	T4: [],
});

// ── width resolution ─────────────────────────────────────────────────────────────────────────

/** A centred content container: one class list carrying both `mx-auto` and a `max-w-*`. */
const CONTAINER = /["`'][^"`']*?["`']/g;
const MAX_W = /\bmax-w-(?:\[[^\]\s]+\]|[a-z0-9]+)/;

/** Read a file through the manifest's comment stripper, or null when it does not exist. */
function readStripped(abs) {
	if (!existsSync(abs)) return null;
	const { lines, unterminated } = stripCommentLines(readFileSync(abs, "utf8"));
	if (unterminated) {
		throw new Error(
			`${abs}: a block comment is still open at EOF — refusing to read it, because everything ` +
				`after the opener has been blanked and would silently stop matching`,
		);
	}
	return lines.join("\n");
}

/**
 * Every content-width token declared by one file, as `max-w-…` strings.
 *
 * @param {string} abs absolute path
 * @returns {string[]} deduplicated, in source order
 */
function widthsIn(abs) {
	const src = readStripped(abs);
	if (src === null) return [];
	/** @type {string[]} */
	const out = [];
	for (const m of src.matchAll(CONTAINER)) {
		const s = m[0].slice(1, -1);
		if (!/\bmx-auto\b/.test(s)) continue;
		const w = s.match(MAX_W);
		if (w && !out.includes(w[0])) out.push(w[0]);
	}
	return out;
}

const MODULE_EXTENSIONS = ["tsx", "ts", "jsx", "js"];

/**
 * Resolve one import specifier to a file inside `apps/console`, or null.
 *
 * Only `./`, `../` and the `@/` alias are resolved, and only to a file that exists — a package
 * specifier (`@repo/ui/button`, `next/navigation`) is somebody else's tree and is not read.
 */
function resolveImport(repoRoot, fromFile, spec) {
	let base;
	if (spec.startsWith("./") || spec.startsWith("../")) {
		base = path.resolve(path.dirname(fromFile), spec);
	} else if (spec.startsWith("@/")) {
		base = path.resolve(repoRoot, "apps", "console", spec.slice(2));
	} else {
		return null;
	}
	const consoleDir = path.resolve(repoRoot, "apps", "console");
	if (!base.startsWith(consoleDir + path.sep)) return null;
	for (const ext of MODULE_EXTENSIONS) if (existsSync(`${base}.${ext}`)) return `${base}.${ext}`;
	for (const ext of MODULE_EXTENSIONS) {
		const idx = path.join(base, `index.${ext}`);
		if (existsSync(idx)) return idx;
	}
	return null;
}

/**
 * A routing file's own width, or the width of a module it DIRECTLY imports.
 *
 * ONE LEVEL, deliberately and statedly. A console page is overwhelmingly a server component whose
 * whole body is `return <SomethingClient … />`, so the container that owns the page width lives in
 * that one import — `~/alerts` is `<AlertsPage/>` and the 1200px is in `alerts-page.tsx`, `~/new`
 * is `<CreateProjectForm/>` and the `max-w-5xl` is in `create-project-form.tsx`. Reading the page
 * file alone would report 35 of 36 pages as "sets no width", which is not a measurement of
 * anything. Following the graph transitively would drag in the whole component tree and start
 * counting a dialog's `mx-auto max-w-md` as the page width. One level is where the signal is; a
 * container that hides two levels down is a miss this file does not claim to catch.
 *
 * @returns {{width: string|null, sites: string[]}}
 */
function resolveWidth(repoRoot, relFile) {
	const abs = path.join(repoRoot, relFile);
	const src = readStripped(abs);
	if (src === null) return { width: null, sites: [] };
	/** @type {string[]} */
	const sites = [];
	/** @type {string|null} */
	let width = null;
	const consider = (file) => {
		for (const w of widthsIn(file)) {
			if (width === null) width = w;
			sites.push(`${path.relative(repoRoot, file)}:${w}`);
		}
	};
	consider(abs);
	/** @type {Set<string>} */
	const seen = new Set();
	for (const m of src.matchAll(/from\s+["']([^"']+)["']/g)) {
		const resolved = resolveImport(repoRoot, abs, m[1]);
		if (resolved === null || seen.has(resolved)) continue;
		seen.add(resolved);
		consider(resolved);
	}
	return { width, sites };
}

/**
 * The innermost shell whose layout is an ancestor-or-self of `dir`, and the width it declares.
 *
 * Scoped rather than simply `record.shell`, because a `loading.tsx` inherited from an ancestor
 * segment renders where IT sits, not where the page sits: `[org]/loading.tsx` replaces everything
 * below `[org]/layout.tsx`, so it renders inside AppShell and NOT inside the SettingsShell that
 * wraps `~/settings/classification`. Comparing the skeleton against the page's own shell width
 * would silently attribute a width to a skeleton that never renders inside it.
 *
 * @returns {{shell: string|null, width: string|null}}
 */
function shellInScope(repoRoot, record, shellsByName, dirRel) {
	const dirAbs = path.resolve(repoRoot, dirRel);
	/** @type {string|null} */
	let shell = null;
	for (const layoutRel of record.layoutChain) {
		const layoutDir = path.resolve(repoRoot, path.dirname(layoutRel));
		const applies = dirAbs === layoutDir || dirAbs.startsWith(layoutDir + path.sep);
		if (!applies) continue;
		const src = readStripped(path.join(repoRoot, layoutRel));
		if (src === null) continue;
		const mounted = [...shellsByName.keys()]
			.map((name) => ({ name, at: src.search(new RegExp(`<${name}\\b`)) }))
			.filter((hit) => hit.at >= 0)
			.sort((a, b) => a.at - b.at);
		// Layouts are walked outermost-first and each layout's mounts are ordered by position, so
		// the last one assigned is the innermost — the same rule the manifest uses for `shell`.
		for (const hit of mounted) shell = hit.name;
	}
	return { shell, width: shell === null ? null : (shellsByName.get(shell) ?? null) };
}

// ── the evaluation context ───────────────────────────────────────────────────────────────────

/**
 * Everything the eight predicates read, resolved once per route.
 *
 * @param {object} manifest the value of `collectConsoleRoutes()`
 * @param {string} repoRoot
 */
export function buildContexts(manifest, repoRoot) {
	/** @type {Map<string,string|null>} */
	const shellsByName = new Map();
	for (const s of manifest.shells) {
		const w = widthsIn(path.join(repoRoot, s.file));
		shellsByName.set(s.name, w.length ? w[0] : null);
	}
	/** Every width some known shell owns — the set a page must not hand-roll (S4). */
	const shellOwnedWidths = new Set([...shellsByName.values()].filter((w) => w !== null));

	/** dir (repo-relative) → the route whose page.tsx sits in it. */
	const routeByDir = new Map(manifest.routes.map((r) => [r.dir, r]));

	return manifest.routes.map((record) => {
		const pageSrc = readStripped(path.join(repoRoot, record.file)) ?? "";
		const page = resolveWidth(repoRoot, record.file);
		const shellWidth = record.shell === null ? null : (shellsByName.get(record.shell) ?? null);

		const ld = record.boundaries.loading;
		const loading = ld.file === null ? { width: null, sites: [] } : resolveWidth(repoRoot, ld.file);
		const loadingDir = ld.file === null ? null : path.dirname(ld.file);
		const loadingShell =
			loadingDir === null
				? { shell: null, width: null }
				: shellInScope(repoRoot, record, shellsByName, loadingDir);
		// The page that OWNS the inherited skeleton, if any. T1 turns on whether that page is a
		// real page (whose skeleton is its own) or a redirect/absent one (whose skeleton exists
		// only to serve the subtree beneath it).
		const loadingOwner = loadingDir === null ? undefined : routeByDir.get(loadingDir);

		// The directory of the page's innermost dynamic segment — the resource a bad slug names.
		/** @type {string|null} */
		let innermostParamDir = null;
		for (let i = record.segments.length; i > 0; i--) {
			if (record.segments[i - 1].startsWith("[")) {
				innermostParamDir = path.join(manifest.appDir, ...record.segments.slice(0, i));
				break;
			}
		}

		return {
			record,
			shellWidth,
			shellOwnedWidths,
			pageWidth: page.width,
			pageWidthSites: page.sites,
			loadingWidth: loading.width,
			loadingShellWidth: loadingShell.width,
			/** undefined = no page owns that directory · true = it only redirects. */
			loadingOwnerIsOwnPage: loadingOwner === undefined ? false : !loadingOwner.isRedirectOnly,
			callsNotFound: /\bnotFound\s*\(/.test(pageSrc),
			innermostParamDir,
		};
	});
}

// ── the predicates ───────────────────────────────────────────────────────────────────────────

const PASS = (detail) => ({ verdict: "PASS", reason: null, detail: detail ?? "" });
const FAIL = (detail) => ({ verdict: "FAIL", reason: null, detail: detail ?? "" });
const NA = (reason) => ({ verdict: "N/A", reason, detail: "" });

/**
 * Each predicate is a pure function of the context above. Every N/A branch returns a reason from
 * `NA_REASONS`, and every one of those reasons is STRUCTURAL — `isRedirectOnly` and
 * `boundaries.loading.file === null` are properties of the route record, not readings of how the
 * page looks. RUBRIC.md rule 2: "This page has no empty state" is the thing being measured;
 * "this page is redirect-only" is not.
 */
export const CHECKS = {
	S1: (c) => {
		if (c.record.isRedirectOnly) return NA("redirect-only");
		return c.record.shell !== null ? PASS(c.record.shell) : FAIL("no known shell in the layout chain");
	},

	S2: (c) => {
		if (c.record.isRedirectOnly) return NA("redirect-only");
		if (c.shellWidth !== null && c.pageWidth === null) return PASS(`${c.record.shell} ${c.shellWidth}`);
		if (c.shellWidth === null && c.pageWidth === null) {
			return FAIL(`no max-width anywhere — ${c.record.shell ?? "no shell"} declares none`);
		}
		if (c.shellWidth === null) {
			return FAIL(`the page declares ${c.pageWidth}; ${c.record.shell ?? "no shell"} declares none`);
		}
		return FAIL(`two widths: ${c.record.shell} ${c.shellWidth} and the page's ${c.pageWidth}`);
	},

	S3: (c) => {
		if (c.record.isRedirectOnly) return NA("redirect-only");
		// Not "wherever T1 fails" — only where there is no boundary to compare against. A wrong
		// skeleton still HAS a width, and the widths still either agree or do not.
		if (c.record.boundaries.loading.file === null) return NA("no-loading-boundary");
		const page = c.pageWidth ?? c.shellWidth;
		const skeleton = c.loadingWidth ?? c.loadingShellWidth;
		return page === skeleton
			? PASS(page ?? "neither constrains")
			: FAIL(`page ${page ?? "unconstrained"} vs skeleton ${skeleton ?? "unconstrained"}`);
	},

	S4: (c) => {
		if (c.record.isRedirectOnly) return NA("redirect-only");
		if (c.pageWidth === null) return PASS();
		if (c.shellWidth !== null) {
			return FAIL(`${c.record.shell} already owns the width; the page re-declares ${c.pageWidth}`);
		}
		if (c.shellOwnedWidths.has(c.pageWidth)) {
			return FAIL(`the page hand-rolls ${c.pageWidth}, a width a shell already owns`);
		}
		return PASS(c.pageWidth);
	},

	T1: (c) => {
		if (c.record.isRedirectOnly) return NA("redirect-only");
		const ld = c.record.boundaries.loading;
		if (ld.own) return PASS("its own");
		if (ld.file === null) return FAIL("no loading.tsx anywhere in its chain");
		// An inherited skeleton is correct when the segment it belongs to has no page of its own to
		// have been written for — a redirect-only page, or no page at all. `[project]/settings` only
		// redirects, so `[project]/settings/loading.tsx` was written for the sub-pages and they PASS.
		// `~/jobs` is a real list page, so `~/jobs/loading.tsx` is the LIST's skeleton and `[id]`
		// inheriting it renders somebody else's.
		return c.loadingOwnerIsOwnPage
			? FAIL(`renders ${ld.file} at distance ${ld.distance} — that segment's own page skeleton`)
			: PASS(`inherited from a segment with no page of its own (distance ${ld.distance})`);
	},

	T2: (c) =>
		c.record.boundaries.error.file !== null
			? PASS(`${c.record.boundaries.error.file}@${c.record.boundaries.error.distance}`)
			: FAIL("no error.tsx anywhere in its chain"),

	T3: (c) => {
		if (!c.callsNotFound) return NA("does-not-call-not-found");
		const nf = c.record.boundaries["not-found"];
		if (nf.file === null) return FAIL("calls notFound() with no not-found.tsx in its chain");
		if (c.innermostParamDir === null) return PASS(nf.file);
		const nfDir = path.dirname(nf.file);
		const scoped = nfDir === c.innermostParamDir || nfDir.startsWith(c.innermostParamDir + path.sep);
		return scoped
			? PASS(nf.file)
			: FAIL(`resolves to ${nf.file}, which is above ${c.innermostParamDir}`);
	},

	T4: (c) => (c.record.hasMetadata ? PASS() : FAIL("no metadata title on the page or its own layout")),
};

/**
 * Score every route against every predicate.
 *
 * Raises when a predicate returns an N/A reason outside its declared set — RUBRIC.md rule 1. That
 * is an error rather than a finding on purpose: an undeclared reason means somebody added an escape
 * hatch, and the whole point of the fixed set is that adding one cannot be quiet.
 */
export function score(contexts) {
	/** @type {Record<string, {pass: string[], fail: {route: string, detail: string}[], na: Record<string, string[]>}>} */
	const out = {};
	for (const id of PREDICATES) out[id] = { pass: [], fail: [], na: {} };
	for (const c of contexts) {
		for (const id of PREDICATES) {
			const r = CHECKS[id](c);
			if (r.verdict === "PASS") {
				out[id].pass.push(c.record.route);
			} else if (r.verdict === "FAIL") {
				out[id].fail.push({ route: c.record.route, detail: r.detail });
			} else {
				const allowed = NA_REASONS[id];
				if (!allowed.includes(r.reason)) {
					throw new Error(
						`${id} returned N/A for ${c.record.route} with reason "${r.reason}", which is not ` +
							`in its declared set [${allowed.join(", ") || "(none — this predicate is never N/A)"}]. ` +
							`An undeclared N/A raises the score by shrinking the denominator; RUBRIC.md rule 1.`,
					);
				}
				(out[id].na[r.reason] ??= []).push(c.record.route);
			}
		}
	}
	return out;
}

/** Flatten a scoring into the shape the baseline records. */
function tally(scored) {
	/** @type {Record<string, {pass: number, fail: number, na: number}>} */
	const t = {};
	for (const id of PREDICATES) {
		t[id] = {
			pass: scored[id].pass.length,
			fail: scored[id].fail.length,
			na: Object.values(scored[id].na).reduce((n, xs) => n + xs.length, 0),
		};
	}
	return t;
}

// ── the baseline ─────────────────────────────────────────────────────────────────────────────

/**
 * A deliberately tiny, deliberately STRICT parser for the baseline file — the worktree is
 * de-hydrated, so there is no YAML dependency to reach for, and the format is four scalars plus
 * eight two-key blocks.
 *
 * Strict in the loud direction: an unknown key, a missing predicate, a duplicate, a non-integer
 * and an unreadable file all RAISE. A baseline this cannot read must never be read as "no
 * findings" — that is the shape of every silently-green guard this repo has shipped.
 */
export function parseBaseline(text, label) {
	const raise = (msg) => {
		throw new Error(`${label}: ${msg}`);
	};
	/** @type {Record<string, number>} */
	const top = {};
	/** @type {Record<string, {fail?: number, na?: number}>} */
	const preds = {};
	/** @type {string|null} */
	let current = null;
	let inPredicates = false;
	const lines = text.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const raw = lines[i].replace(/\s+#.*$/, "").replace(/^#.*$/, "");
		if (raw.trim() === "") continue;
		const indent = raw.length - raw.trimStart().length;
		const line = raw.trim();
		const m = line.match(/^([A-Za-z][A-Za-z0-9]*):\s*(.*)$/);
		if (!m) raise(`line ${i + 1}: cannot parse "${line}"`);
		const [, key, value] = m;
		if (indent === 0) {
			inPredicates = key === "predicates";
			current = null;
			if (inPredicates) {
				if (value !== "") raise(`line ${i + 1}: "predicates:" takes a block, not a value`);
				continue;
			}
			if (!/^\d+$/.test(value)) raise(`line ${i + 1}: ${key} must be a non-negative integer`);
			if (key in top) raise(`line ${i + 1}: ${key} appears twice`);
			top[key] = Number(value);
			continue;
		}
		if (!inPredicates) raise(`line ${i + 1}: indented "${key}" outside the predicates block`);
		if (indent === 2) {
			if (value !== "") raise(`line ${i + 1}: "${key}:" takes a block, not a value`);
			if (key in preds) raise(`line ${i + 1}: predicate ${key} appears twice`);
			preds[key] = {};
			current = key;
			continue;
		}
		if (indent === 4) {
			if (current === null) raise(`line ${i + 1}: "${key}" with no predicate above it`);
			if (key !== "fail" && key !== "na") raise(`line ${i + 1}: unknown predicate key "${key}"`);
			if (!/^\d+$/.test(value)) raise(`line ${i + 1}: ${current}.${key} must be a non-negative integer`);
			if (key in preds[current]) raise(`line ${i + 1}: ${current}.${key} appears twice`);
			preds[current][key] = Number(value);
			continue;
		}
		raise(`line ${i + 1}: unexpected indentation (${indent} spaces)`);
	}

	for (const key of ["version", "routes", "redirectOnly", "real"]) {
		if (!(key in top)) raise(`missing "${key}"`);
	}
	for (const key of Object.keys(top)) {
		if (!["version", "routes", "redirectOnly", "real"].includes(key)) raise(`unknown key "${key}"`);
	}
	if (top.version !== 1) raise(`version ${top.version} is not 1`);
	for (const id of PREDICATES) {
		if (!(id in preds)) raise(`missing predicate ${id}`);
		if (!("fail" in preds[id])) raise(`${id} is missing "fail"`);
		if (!("na" in preds[id])) raise(`${id} is missing "na"`);
	}
	for (const id of Object.keys(preds)) {
		if (!PREDICATES.includes(id)) raise(`unknown predicate "${id}"`);
	}
	return { ...top, predicates: preds };
}

/**
 * Compare a tally against the baseline in BOTH directions.
 *
 * Growing fails, and shrinking without lowering the number fails too. A one-directional ratchet
 * lets a fix land with a stale baseline, and a stale baseline is a gate that has stopped measuring
 * the thing it names — the next regression back up to the old number reports green.
 *
 * N/A counts are compared EXACTLY, in both directions, for the reason RUBRIC.md gives: an N/A
 * count that can grow silently is a predicate being escaped.
 *
 * @returns {string[]} one line per violation; empty means clean
 */
export function compareToBaseline(baseline, tallied, totals) {
	/** @type {string[]} */
	const problems = [];
	const cmp = (label, actual, expected, hint) => {
		if (actual === expected) return;
		problems.push(
			`${label}: baseline says ${expected}, tree has ${actual} — ` +
				(actual > expected ? `a REGRESSION. ${hint}` : `an IMPROVEMENT. Lower the baseline in the same commit as the fix.`),
		);
	};
	cmp("routes", totals.routes, baseline.routes, "A new route starts at the current floor: record it.");
	cmp("redirectOnly", totals.redirectOnly, baseline.redirectOnly, "Record it.");
	cmp("real", totals.real, baseline.real, "Record it.");
	for (const id of PREDICATES) {
		cmp(`${id}.fail`, tallied[id].fail, baseline.predicates[id].fail, "Fix the page, do not raise the number.");
		cmp(`${id}.na`, tallied[id].na, baseline.predicates[id].na, "An N/A count that grows is a predicate being escaped.");
	}
	return problems;
}

/** The YAML the current tree would need — printed, never written. */
function renderBaseline(tallied, totals) {
	const lines = [
		"# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>",
		"# SPDX-License-Identifier: AGPL-3.0-only",
		"#",
		"# The route-state ratchet: RUBRIC.md predicates S1-S4 and T1-T4, scored over the private",
		"# console route set by `node scripts/check-route-states.mjs`.",
		"#",
		"# EVERY NUMBER HERE IS CHECKED IN BOTH DIRECTIONS. A count that grows is a regression; a",
		"# count that falls without this file changing in the SAME commit is also a failure, because",
		"# a stale baseline has stopped measuring the thing it names and the next regression back up",
		"# to the old number reports green. `na` is compared exactly for the reason RUBRIC.md gives:",
		"# an N/A count that can grow silently is a predicate being escaped.",
		"#",
		"# `node scripts/check-route-states.mjs --print-baseline` prints what the tree scores today.",
		"# It prints; it never writes. Regenerating this file over a red run is how a ratchet becomes",
		"# a rubber stamp — read the diff and only accept numbers your change actually moved.",
		"version: 1",
		`routes: ${totals.routes}`,
		`redirectOnly: ${totals.redirectOnly}`,
		`real: ${totals.real}`,
		"predicates:",
	];
	for (const id of PREDICATES) {
		lines.push(`  ${id}:`, `    fail: ${tallied[id].fail}`, `    na: ${tallied[id].na}`);
	}
	return lines.join("\n") + "\n";
}

// ── the run ──────────────────────────────────────────────────────────────────────────────────

/** Score one tree. Never catches the manifest's raises — a zero-route tree must not report green. */
export function runOver(repoRoot) {
	const manifest = collectConsoleRoutes({ repoRoot });
	const contexts = buildContexts(manifest, repoRoot);
	const scored = score(contexts);
	const redirectOnly = manifest.routes.filter((r) => r.isRedirectOnly).length;
	return {
		manifest,
		contexts,
		scored,
		tallied: tally(scored),
		totals: {
			routes: manifest.routes.length,
			redirectOnly,
			real: manifest.routes.length - redirectOnly,
		},
	};
}

// ── the permanent positive control ───────────────────────────────────────────────────────────

const put = (root, rel, body) => {
	const full = path.join(root, rel);
	mkdirSync(path.dirname(full), { recursive: true });
	writeFileSync(full, body);
};

const PAGE = (extra = "") => `${extra}export default function P() { return <div />; }\n`;
const META = 'export const metadata = { title: "T" };\n';
const REDIRECT =
	"import { redirect } from 'next/navigation';\nexport default function R() { redirect('/x'); }\n";

/**
 * A tree in which every predicate has a route it MUST fail.
 *
 * There is no `app/error.tsx` — that is what lets T2 fail at all. Every route here consequently
 * fails T2; only the designated assertions below are checked, so that is harmless.
 */
function buildProbeTree() {
	const root = mkdtempSync(path.join(tmpdir(), "route-states-probe-"));
	put(root, "apps/console/components/shell/app-shell.tsx",
		'export function AppShell({ children }) { return <div className="mx-auto w-full max-w-[1200px]">{children}</div>; }\n');
	put(root, "apps/console/components/plain/plain-shell.tsx",
		"export function PlainShell({ children }) { return <div className=\"p-6\">{children}</div>; }\n");
	put(root, "apps/console/components/narrow/narrow-shell.tsx",
		'export function NarrowShell({ children }) { return <div className="mx-auto w-full max-w-[800px]">{children}</div>; }\n');
	put(root, "apps/console/app/layout.tsx", "export default function L({ children }) { return <div>{children}</div>; }\n");
	put(root, "apps/console/app/(private)/layout.tsx", "export default function PL({ children }) { return <div>{children}</div>; }\n");
	// S1 · T2 · T4 — no shell above it, no error boundary anywhere, no metadata.
	put(root, "apps/console/app/(private)/loose/page.tsx", PAGE());
	// S2, branch "the shell declares no width".
	put(root, "apps/console/app/(private)/plain/layout.tsx",
		"import { PlainShell } from '@/components/plain/plain-shell';\nexport default function X({ children }) { return <PlainShell>{children}</PlainShell>; }\n");
	put(root, "apps/console/app/(private)/plain/page.tsx", META + PAGE());
	// S4, branch "the page hand-rolls a width a shell owns" IN ISOLATION — PlainShell owns none, so
	// the other branch cannot fire and a mutation that deletes this one is caught here and only here.
	put(root, "apps/console/app/(private)/plain/copy/page.tsx",
		META + 'export default function C() { return <div className="mx-auto max-w-[1200px]" />; }\n');
	put(root, "apps/console/app/(private)/[org]/layout.tsx",
		"import { AppShell } from '@/components/shell/app-shell';\nexport default function O({ children }) { return <AppShell>{children}</AppShell>; }\n");
	put(root, "apps/console/app/(private)/[org]/not-found.tsx", "export default function NF() { return <div />; }\n");
	// S2, branch "the page declares its own on top of the shell's".
	put(root, "apps/console/app/(private)/[org]/wide/page.tsx",
		META + 'export default function W() { return <div className="mx-auto max-w-4xl" />; }\n');
	// S3 — an inherited skeleton renders inside a DIFFERENT shell from the page it covers.
	// `[org]/loading.tsx` sits at `[org]`, so it replaces everything below `[org]/layout.tsx` and
	// renders inside AppShell (1200px) — NOT inside the NarrowShell (800px) that wraps the page.
	// This is `~/settings/classification`'s shape, and it is the only fixture that separates
	// "credit the skeleton with the shell IT renders inside" from "credit it with the page's".
	put(root, "apps/console/app/(private)/[org]/loading.tsx", "export default function OL() { return <div />; }\n");
	put(root, "apps/console/app/(private)/[org]/inner/layout.tsx",
		"import { NarrowShell } from '@/components/narrow/narrow-shell';\nexport default function I({ children }) { return <NarrowShell>{children}</NarrowShell>; }\n");
	put(root, "apps/console/app/(private)/[org]/inner/page.tsx", META + PAGE());
	// S3 — the skeleton is a different width from the page.
	put(root, "apps/console/app/(private)/[org]/skew/page.tsx", META + PAGE());
	put(root, "apps/console/app/(private)/[org]/skew/loading.tsx",
		'export default function S() { return <div className="mx-auto max-w-3xl" />; }\n');
	// S4 — the page hand-rolls the width the shell already owns.
	put(root, "apps/console/app/(private)/[org]/dup/page.tsx",
		META + 'export default function D() { return <div className="mx-auto max-w-[1200px]" />; }\n');
	// T1 — a real list page's skeleton, inherited by the detail page below it.
	put(root, "apps/console/app/(private)/[org]/list/page.tsx", META + PAGE());
	put(root, "apps/console/app/(private)/[org]/list/loading.tsx", "export default function LS() { return <div />; }\n");
	put(root, "apps/console/app/(private)/[org]/list/detail/page.tsx", META + PAGE());
	// T3 — calls notFound(), and the nearest not-found.tsx is scoped to [org], not to [thing].
	put(root, "apps/console/app/(private)/[org]/[thing]/page.tsx",
		META + "import { notFound } from 'next/navigation';\nexport default function T() { notFound(); return <div />; }\n");
	return root;
}

/** A tree in which every predicate has a route it MUST pass. */
function buildAntiProbeTree() {
	const root = mkdtempSync(path.join(tmpdir(), "route-states-anti-"));
	put(root, "apps/console/components/shell/app-shell.tsx",
		'export function AppShell({ children }) { return <div className="mx-auto w-full max-w-[1200px]">{children}</div>; }\n');
	put(root, "apps/console/app/layout.tsx", "export default function L({ children }) { return <div>{children}</div>; }\n");
	put(root, "apps/console/app/error.tsx", "export default function E() { return <div />; }\n");
	put(root, "apps/console/app/(private)/layout.tsx", "export default function PL({ children }) { return <div>{children}</div>; }\n");
	put(root, "apps/console/app/(private)/[org]/layout.tsx",
		"import { AppShell } from '@/components/shell/app-shell';\nexport default function O({ children }) { return <AppShell>{children}</AppShell>; }\n");
	put(root, "apps/console/app/(private)/[org]/loading.tsx", "export default function LS() { return <div />; }\n");
	put(root, "apps/console/app/(private)/[org]/not-found.tsx", "export default function NF() { return <div />; }\n");
	put(root, "apps/console/app/(private)/[org]/page.tsx", META + PAGE());
	// T3 — a not-found.tsx scoped to the resource whose slug the page resolves.
	put(root, "apps/console/app/(private)/[org]/[thing]/loading.tsx", "export default function TL() { return <div />; }\n");
	put(root, "apps/console/app/(private)/[org]/[thing]/not-found.tsx", "export default function TNF() { return <div />; }\n");
	put(root, "apps/console/app/(private)/[org]/[thing]/page.tsx",
		META + "import { notFound } from 'next/navigation';\nexport default function T() { notFound(); return <div />; }\n");
	// T1 — a redirect-only segment whose loading.tsx exists only for the sub-pages beneath it.
	put(root, "apps/console/app/(private)/[org]/sect/page.tsx", REDIRECT);
	put(root, "apps/console/app/(private)/[org]/sect/loading.tsx", "export default function SL() { return <div />; }\n");
	put(root, "apps/console/app/(private)/[org]/sect/leaf/page.tsx", META + PAGE());
	// S3's SHELL FALLBACK, isolated. The page names the shell's width out loud and the skeleton
	// names none, so the two agree only if the skeleton is credited with the shell it renders
	// inside. An implementation that compared the declared widths alone reads 1200 against nothing
	// and fails this page; nothing else in either tree separates those two implementations.
	put(root, "apps/console/app/(private)/[org]/matchw/loading.tsx", "export default function ML() { return <div />; }\n");
	put(root, "apps/console/app/(private)/[org]/matchw/page.tsx",
		META + 'export default function M() { return <div className="mx-auto max-w-[1200px]" />; }\n');
	return root;
}

/**
 * The control that runs on EVERY invocation. Each predicate must fire against a probe it must
 * catch and stay quiet against one it must not, or this file refuses to report on the real tree.
 *
 * @returns {string[]} one line per broken control; empty means the instrument works
 */
export function positiveControl() {
	/** @type {string[]} */
	const problems = [];
	const probe = buildProbeTree();
	const anti = buildAntiProbeTree();
	try {
		const p = runOver(probe);
		const a = runOver(anti);
		const verdict = (run, route, id) => {
			const s = run.scored[id];
			if (s.fail.some((f) => f.route === route)) return "FAIL";
			if (s.pass.includes(route)) return "PASS";
			for (const [reason, routes] of Object.entries(s.na)) if (routes.includes(route)) return `N/A:${reason}`;
			return "MISSING";
		};
		const expect = (run, label, route, id, want) => {
			const got = verdict(run, route, id);
			if (got !== want) problems.push(`${label} ${id} on ${route}: expected ${want}, got ${got}`);
		};

		// ── the probes: each predicate MUST catch its violation ─────────────────────────────
		expect(p, "probe", "/loose", "S1", "FAIL");
		expect(p, "probe", "/plain", "S2", "FAIL"); // the shell declares no width
		expect(p, "probe", "/[org]/wide", "S2", "FAIL"); // the page declares its own as well
		expect(p, "probe", "/[org]/skew", "S3", "FAIL");
		expect(p, "probe", "/[org]/inner", "S3", "FAIL"); // the skeleton renders in a wider shell
		expect(p, "probe", "/[org]/wide", "S4", "FAIL"); // a shell above already owns the width
		expect(p, "probe", "/plain/copy", "S4", "FAIL"); // the page hand-rolls a shell's own number
		expect(p, "probe", "/[org]/dup", "S4", "FAIL");
		expect(p, "probe", "/[org]/list/detail", "T1", "FAIL");
		expect(p, "probe", "/loose", "T2", "FAIL");
		expect(p, "probe", "/[org]/[thing]", "T3", "FAIL");
		expect(p, "probe", "/loose", "T4", "FAIL");

		// ── the antiProbes: no predicate may fire on a page that does the thing ─────────────
		for (const id of ["S1", "S2", "S3", "S4", "T1", "T2", "T4"]) expect(a, "antiProbe", "/[org]", id, "PASS");
		expect(a, "antiProbe", "/[org]", "T3", "N/A:does-not-call-not-found");
		expect(a, "antiProbe", "/[org]/[thing]", "T3", "PASS");
		expect(a, "antiProbe", "/[org]/sect/leaf", "T1", "PASS");
		expect(a, "antiProbe", "/[org]/matchw", "S3", "PASS");

		// ── the N/A control: redirect-only excuses S1–S4 and T1, and NOTHING else ──────────
		for (const id of ["S1", "S2", "S3", "S4", "T1"]) {
			expect(a, "antiProbe", "/[org]/sect", id, "N/A:redirect-only");
		}
		expect(a, "antiProbe", "/[org]/sect", "T2", "PASS");
		expect(a, "antiProbe", "/[org]/sect", "T4", "FAIL"); // "a redirect still owns a title"
	} finally {
		for (const d of [probe, anti]) rmSync(d, { recursive: true, force: true });
	}
	return problems;
}

// ── reporting ────────────────────────────────────────────────────────────────────────────────

function report(run, { routes = false } = {}) {
	const { scored, tallied, totals } = run;
	console.log(
		`${totals.routes} private routes · ${totals.redirectOnly} redirect-only · ${totals.real} real pages\n`,
	);
	console.log("  id   PASS  FAIL   N/A   score  predicate");
	for (const id of PREDICATES) {
		const t = tallied[id];
		const denom = t.pass + t.fail;
		const s = denom === 0 ? "  —  " : (t.pass / denom).toFixed(2);
		console.log(
			`  ${id}  ${String(t.pass).padStart(4)}  ${String(t.fail).padStart(4)}  ${String(t.na).padStart(4)}   ${s}   ${TITLES[id]}`,
		);
	}
	for (const id of PREDICATES) {
		if (scored[id].fail.length === 0) continue;
		console.log(`\n${id} — ${TITLES[id]}`);
		for (const f of scored[id].fail) console.log(`  FAIL ${f.route.padEnd(38)} ${f.detail}`);
	}
	for (const id of PREDICATES) {
		const reasons = Object.entries(scored[id].na);
		if (reasons.length === 0) continue;
		console.log(
			`\n${id} N/A: ${reasons.map(([r, xs]) => `${r}=${xs.length}`).join(", ")}`,
		);
	}
	if (routes) {
		console.log("\nroute × predicate");
		for (const c of run.contexts) {
			const cells = PREDICATES.map((id) => {
				const r = CHECKS[id](c);
				return `${id}:${r.verdict === "N/A" ? "n/a" : r.verdict === "PASS" ? "ok " : "FAIL"}`;
			});
			console.log(`  ${c.record.route.padEnd(38)} ${cells.join(" ")}`);
		}
	}
}

// ── self-test ────────────────────────────────────────────────────────────────────────────────

function selfTest() {
	let failures = 0;
	const ok = (label, cond) => {
		console.log(`${cond ? "ok  " : "FAIL"} - ${label}`);
		if (!cond) failures++;
	};
	const raises = (label, fn, needle) => {
		try {
			fn();
			console.log(`FAIL - ${label} (did not raise)`);
			failures++;
		} catch (err) {
			const hit = !needle || err.message.includes(needle);
			console.log(`${hit ? "ok  " : "FAIL"} - ${label}${hit ? "" : ` (wrong message: ${err.message})`}`);
			if (!hit) failures++;
		}
	};

	// The positive control is the self-test's first assertion as well as every run's. Reported
	// per-line here so a broken instrument names the predicate that stopped firing.
	const control = positiveControl();
	ok(`the positive control is intact (${control.length} problems)`, control.length === 0);
	for (const line of control) console.log(`     ${line}`);

	// ── N/A discipline ──────────────────────────────────────────────────────────────────────
	ok(
		"every N/A reason a predicate can return is in its declared set",
		PREDICATES.every((id) => Array.isArray(NA_REASONS[id])),
	);
	ok("T2 and T4 declare NO N/A reason at all", NA_REASONS.T2.length === 0 && NA_REASONS.T4.length === 0);
	// Driven by REPLACING a predicate with one that invents a reason, because that is the actual
	// shape of the defect being guarded against: somebody adds an N/A branch nobody declared, the
	// page stops failing, and the score goes UP because the denominator went down. Asserting the
	// declaration list matches itself would prove nothing; this proves `score()` refuses.
	/** A redirect-only stub: N/A for S1–S4 and T1, scored for T2 and T4. */
	const stub = () => [
		{
			record: {
				route: "/x",
				isRedirectOnly: true,
				shell: null,
				hasMetadata: true,
				segments: [],
				boundaries: {
					loading: { file: null, own: false, distance: null },
					error: { file: "apps/console/app/error.tsx", distance: 0 },
					"not-found": { file: null, own: false, distance: null },
				},
			},
			shellWidth: null,
			shellOwnedWidths: new Set(),
			pageWidth: null,
			pageWidthSites: [],
			loadingWidth: null,
			loadingShellWidth: null,
			loadingOwnerIsOwnPage: false,
			callsNotFound: false,
			innermostParamDir: null,
		},
	];
	const withCheck = (id, impl, fn) => {
		const real = CHECKS[id];
		CHECKS[id] = impl;
		try {
			return fn();
		} finally {
			CHECKS[id] = real;
		}
	};
	ok("the stub scores cleanly with the real predicates", score(stub()).S1.na["redirect-only"].length === 1);
	raises(
		"an undeclared N/A reason is an ERROR, not an N/A",
		() => withCheck("S1", () => NA("this-page-is-hard"), () => score(stub())),
		"not in its declared set",
	);
	raises(
		"a never-N/A predicate refuses even a reason another predicate declares",
		() => withCheck("T2", () => NA("redirect-only"), () => score(stub())),
		"this predicate is never N/A",
	);

	// ── the baseline parser ─────────────────────────────────────────────────────────────────
	const good = renderBaseline(
		Object.fromEntries(PREDICATES.map((id) => [id, { pass: 1, fail: 2, na: 3 }])),
		{ routes: 40, redirectOnly: 4, real: 36 },
	);
	const parsed = parseBaseline(good, "fixture");
	ok("a well-formed baseline round-trips", parsed.routes === 40 && parsed.predicates.T4.na === 3);
	raises("a missing predicate RAISES", () => parseBaseline(good.replace(/  T4:\n    fail: 2\n    na: 3\n/, ""), "fixture"), "missing predicate T4");
	raises("an unknown predicate RAISES", () => parseBaseline(good + "  S9:\n    fail: 0\n    na: 0\n", "fixture"), "unknown predicate");
	raises("an unknown top-level key RAISES", () => parseBaseline(good + "extra: 1\n", "fixture"), 'unknown key "extra"');
	raises("a non-integer RAISES", () => parseBaseline(good.replace("fail: 2", "fail: two"), "fixture"), "non-negative integer");
	raises("a truncated file RAISES rather than defaulting", () => parseBaseline("version: 1\n", "fixture"), 'missing "routes"');
	raises("an empty file RAISES", () => parseBaseline("", "fixture"), 'missing "version"');

	// ── the ratchet, in BOTH directions ─────────────────────────────────────────────────────
	const base = parseBaseline(good, "fixture");
	const flat = Object.fromEntries(PREDICATES.map((id) => [id, { pass: 1, fail: 2, na: 3 }]));
	const totals = { routes: 40, redirectOnly: 4, real: 36 };
	ok("an unchanged tree is clean", compareToBaseline(base, flat, totals).length === 0);
	const worse = { ...flat, S2: { pass: 0, fail: 3, na: 3 } };
	const grewProblems = compareToBaseline(base, worse, totals);
	ok(
		"one MORE failure is a REGRESSION",
		grewProblems.length === 1 && grewProblems[0].includes("S2.fail") && grewProblems[0].includes("REGRESSION"),
	);
	const better = { ...flat, S2: { pass: 2, fail: 1, na: 3 } };
	const shrankProblems = compareToBaseline(base, better, totals);
	ok(
		"one FEWER failure ALSO fails, demanding the baseline be lowered",
		shrankProblems.length === 1 && shrankProblems[0].includes("Lower the baseline"),
	);
	const escaped = { ...flat, T3: { pass: 1, fail: 1, na: 4 } };
	const escapedProblems = compareToBaseline(base, escaped, totals);
	ok(
		"an N/A count that GROWS fails, even though the FAIL count fell",
		escapedProblems.some((p) => p.includes("T3.na")) && escapedProblems.some((p) => p.includes("T3.fail")),
	);
	ok(
		"a route added without recording it fails",
		compareToBaseline(base, flat, { ...totals, routes: 41 }).some((p) => p.startsWith("routes:")),
	);

	// ── the manifest's zero-route raise is NOT caught into a green ───────────────────────────
	const emptyRoot = mkdtempSync(path.join(tmpdir(), "route-states-empty-"));
	mkdirSync(path.join(emptyRoot, "apps", "console", "app", "(private)"), { recursive: true });
	mkdirSync(path.join(emptyRoot, "apps", "console", "components"), { recursive: true });
	writeFileSync(
		path.join(emptyRoot, "apps", "console", "components", "s.tsx"),
		"export function AppShell() { return null; }",
	);
	raises(
		"a zero-route manifest RAISES out of runOver rather than scoring 0/0 green",
		() => runOver(emptyRoot),
		"broken scan, not an empty app",
	);
	rmSync(emptyRoot, { recursive: true, force: true });

	// ── width resolution, on fixtures that separate right from wrong ─────────────────────────
	const wRoot = mkdtempSync(path.join(tmpdir(), "route-states-width-"));
	put(wRoot, "a.tsx", 'const x = <div className="mx-auto max-w-3xl" />;\n');
	put(wRoot, "b.tsx", 'const x = <td className="max-w-[380px] truncate" />;\n');
	put(wRoot, "c.tsx", 'const x = <div className="relative mx-auto max-w-4xl px-2 pt-14" />;\n');
	put(wRoot, "d.tsx", '// <div className="mx-auto max-w-2xl" />\nconst x = 1;\n');
	ok("a centred container is a width", widthsIn(path.join(wRoot, "a.tsx"))[0] === "max-w-3xl");
	ok("a truncating cell is NOT a width", widthsIn(path.join(wRoot, "b.tsx")).length === 0);
	ok(
		"a container without w-full is still a width",
		widthsIn(path.join(wRoot, "c.tsx"))[0] === "max-w-4xl",
	);
	ok("a commented-out container is not a width", widthsIn(path.join(wRoot, "d.tsx")).length === 0);
	rmSync(wRoot, { recursive: true, force: true });

	console.log(failures === 0 ? "\nself-test: all passed" : `\nself-test: ${failures} FAILED`);
	return failures === 0 ? 0 : 1;
}

// ── CLI ──────────────────────────────────────────────────────────────────────────────────────

export const USAGE = [
	"Usage: node scripts/check-route-states.mjs [--json|--routes|--print-baseline|--self-test|--help]",
	"",
	"  (no argument)     score the private route set against apps/console/route-states-baseline.yaml",
	"  --json            the scoring as JSON",
	"  --routes          add a route × predicate grid to the report",
	"  --print-baseline  print the baseline the current tree would need (never writes it)",
	"  --self-test       run the fixture suite; exit 1 on any failure",
	"  --help, -h        this text",
].join("\n");

/**
 * The whole argument parser. An unrecognised argument is an ERROR (exit 2), never a fall-through
 * to the default mode — the same rule, and the same reason, as `console-routes.mjs`: a caller's
 * typo must not be indistinguishable from a successful run.
 */
export function parseCliArgs(argv) {
	const MODES = {
		"--json": "json",
		"--routes": "routes",
		"--print-baseline": "print-baseline",
		"--self-test": "self-test",
		"--help": "help",
		"-h": "help",
	};
	if (argv.length === 0) return { mode: "check", error: null };
	const unknown = argv.filter((a) => !(a in MODES));
	if (unknown.length > 0) {
		return { mode: null, error: `unrecognised argument${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")}` };
	}
	if (argv.some((a) => MODES[a] === "help")) return { mode: "help", error: null };
	const distinct = [...new Set(argv.map((a) => MODES[a]))];
	if (distinct.length > 1) return { mode: null, error: `${distinct.join(" and ")} cannot both be asked for` };
	return { mode: distinct[0], error: null };
}

const invokedDirectly =
	process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
	const parsed = parseCliArgs(process.argv.slice(2));
	if (parsed.error !== null) {
		console.error(`check-route-states: ${parsed.error}\n\n${USAGE}`);
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
			console.error(`\nFAIL - the self-test raised before it could report: ${err.message}`);
			console.error("self-test: 1 FAILED");
			process.exit(1);
		}
	}

	// The instrument first, always. A predicate that has stopped firing must not be allowed to
	// report a clean tree.
	const control = positiveControl();
	if (control.length > 0) {
		console.error("check-route-states: THE POSITIVE CONTROL IS BROKEN — refusing to score the tree.\n");
		for (const line of control) console.error(`  ${line}`);
		console.error(
			"\nA predicate that no longer fires cannot tell a clean tree from a tree it stopped reading.",
		);
		process.exit(1);
	}

	const run = runOver(REPO_ROOT);

	if (parsed.mode === "print-baseline") {
		process.stdout.write(renderBaseline(run.tallied, run.totals));
		process.exit(0);
	}
	if (parsed.mode === "json") {
		console.log(JSON.stringify({ totals: run.totals, tallied: run.tallied, scored: run.scored }, null, "\t"));
		process.exit(0);
	}

	report(run, { routes: parsed.mode === "routes" });

	const baselinePath = path.join(REPO_ROOT, BASELINE_FILE);
	let baseline;
	try {
		baseline = parseBaseline(readFileSync(baselinePath, "utf8"), BASELINE_FILE);
	} catch (err) {
		console.error(`\ncheck-route-states: ${err.message}`);
		console.error(
			`\nThe baseline is the gate. An unreadable one is not "no findings" — run ` +
				`\`node scripts/check-route-states.mjs --print-baseline\` and reconcile it by hand.`,
		);
		process.exit(1);
	}

	const problems = compareToBaseline(baseline, run.tallied, run.totals);
	if (problems.length > 0) {
		console.error(`\ncheck-route-states: ${problems.length} baseline mismatch(es)\n`);
		for (const line of problems) console.error(`  ${line}`);
		console.error(
			`\nThe baseline SHRINKS ONLY, and it is checked in both directions: a lane's PR must move ` +
				`a number in the same commit as its code (RUBRIC.md, "The scoreboard and the ratchet").` +
				`\nRun \`node scripts/check-route-states.mjs --print-baseline\` to see what this tree scores.`,
		);
		process.exit(1);
	}
	console.log(`\ncheck-route-states: matches ${BASELINE_FILE}`);
}
