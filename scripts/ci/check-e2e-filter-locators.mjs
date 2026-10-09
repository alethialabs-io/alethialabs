#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
//
// A LIST PAGE'S FILTER INPUT IS ASKED FOR BY ROLE, NEVER BY LABEL OR PLACEHOLDER (#5800, #5777).
//
// React streams the server's copy of a Suspense section into a hidden `<div hidden id="S:n">` and
// leaves it in the DOM until its segment script swaps it in. `getByLabel` and `getByPlaceholder`
// match elements inside that hidden copy; `getByRole` leaves `hidden` subtrees out. So a spec that
// asks for a list page's search box by label or placeholder can, in that window, resolve to two
// elements (strict mode fails) or `.fill()` the hidden one (the search is never applied — #5795's
// qa leg expected 3 connectors and counted 42). The fix is
// `getByRole("textbox" | "combobox", { name, exact: true })`; this keeps it fixed.
//
// ── WHAT IT READS — THE BOUNDARY ─────────────────────────────────────────────────────────────────
//
// THE INPUTS (derived, not typed). Every `.tsx` under apps/console/app and apps/console/components
// is scanned for the two shared filter-bar inputs, `<FilterSearch` and `<MultiCombobox`
// (packages/ui). From each element's own attributes it takes every name the input can be found by:
// `placeholder="…"` and `ariaLabel="…"` (FilterSearch names the input `ariaLabel ?? placeholder`;
// MultiCombobox's input has only its placeholder, which is also its accessible name). A WRAPPER is
// followed: when the attribute is `placeholder={x}` and the file exports a component that
// destructures `x = "…"` (components/filters/cloud-filter.tsx → `CloudFilter`, "All clouds"), that
// default is a name and the exported component joins the scanned tags, with the literal placeholders
// its own callers pass. Anything else non-literal REFUSES the run: a name this cannot read is a name
// it cannot guard, and saying nothing about it would report green over it.
//
// Not read, deliberately: a popover's own search box (`FacetFilter`'s `searchPlaceholder`, a cmdk
// `CommandInput`). Those render only on the client after a click, so no server-streamed copy of them
// can exist, which is the defect this guards. Nor is a form field in a sheet or dialog.
//
// THE SITES. Every `.ts` under apps/console/e2e — specs, helpers and fixtures alike. Every
// `getByLabel(` and `getByPlaceholder(` call there is read. Its first argument is evaluated with
// Playwright's own semantics against every derived name: a string matches case-insensitively as a
// whitespace-normalised substring, or in full and case-sensitively under `{ exact: true }`; a regex
// literal is tested as written. A call whose first argument is not a literal (an identifier, a
// `new RegExp(…)`, a template with `${}`) cannot be evaluated, so it is reported too — a guard that
// skipped what it could not read would be passable by writing `const s = "Search jobs"` first.
//
// ── THE LEDGER, AND WHY IT FAILS BOTH WAYS ───────────────────────────────────────────────────────
//
// `LEDGER` below is every site that is known and is NOT fixed by #5800, per file, with a count.
// `debt:` entries are filter inputs still asked for by label or placeholder; #5801 removes them.
// `reason:` entries are unreadable calls that are known NOT to be a filter input — each says what it
// is instead. A file with MORE findings than its entry fails (a new site). A file with FEWER fails too
// (the entry outlived its subject, and would otherwise excuse the next site written there): lower
// the number, or delete the entry, in the same PR as the fix.
//
// Usage:
//   node scripts/ci/check-e2e-filter-locators.mjs              # the live tree
//   node scripts/ci/check-e2e-filter-locators.mjs --self-test  # hermetic fixtures, both directions

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SOURCE_DIRS = ["apps/console/app", "apps/console/components"];
const E2E_DIR = "apps/console/e2e";
const BASE_TAGS = ["FilterSearch", "MultiCombobox"];
const NAME_ATTRS = ["placeholder", "ariaLabel"];

/**
 * Known, unfixed sites per file (see the header). `count` is the number of findings this script
 * reports for that file today; it must match exactly.
 *
 * @type {Record<string, { count: number, debt?: string, reason?: string }>}
 */
const LEDGER = {
	"apps/console/e2e/hero-happy-path.spec.ts": { count: 2, debt: "#5801 — the connectors search box" },
	"apps/console/e2e/evidence.spec.ts": { count: 1, debt: "#5801 — the evidence filter bar" },
	"apps/console/e2e/flows/agent-usage-activity.spec.ts": { count: 4, debt: "#5801 — the activity search box" },
	"apps/console/e2e/flows/agent-usage-activity.negative.spec.ts": { count: 2, debt: "#5801 — the activity search box" },
	"apps/console/e2e/flows/alerts.spec.ts": { count: 1, debt: "#5801 — the alert channels filter" },
	"apps/console/e2e/flows/projects.spec.ts": { count: 1, debt: "#5801 — `getByPlaceholder(/search/i).first()` matches every search box" },
	"apps/console/e2e/flows/alerts.negative.spec.ts": {
		count: 1,
		reason: "`getByLabel(urlField)` — a transport's URL field in the new-channel sheet, not a filter input",
	},
	"apps/console/e2e/audit/destructive.spec.ts": {
		count: 2,
		reason: "the destructive-action audit's generic overlay opener and undo probe — names come from the control ledger, not a filter bar",
	},
};

// ── the inputs ───────────────────────────────────────────────────────────────────────────────────

/**
 * Returns the attribute text of every `<Tag …>` opening element in `src`, scanning to the `>` that
 * closes it at brace depth 0 (so `onChange={(v) => …}` does not end it early).
 *
 * @param {string} src
 * @param {string} tag
 * @returns {string[]}
 */
export function openingElements(src, tag) {
	const out = [];
	const re = new RegExp(`<${tag}(?![A-Za-z0-9_])`, "g");
	for (let m = re.exec(src); m; m = re.exec(src)) {
		let depth = 0;
		let quote = "";
		let i = m.index + m[0].length;
		for (; i < src.length; i++) {
			const c = src[i];
			if (quote) {
				if (c === quote && src[i - 1] !== "\\") quote = "";
			} else if (c === '"' || c === "'" || c === "`") quote = c;
			else if (c === "{") depth++;
			else if (c === "}") depth--;
			else if (c === ">" && depth === 0) break;
		}
		out.push(src.slice(m.index + m[0].length, i));
	}
	return out;
}

/**
 * Reads the depth-0 `attr=` value of an opening element's attribute text: `{ literal }` for a
 * `"…"` string, `{ ident }` for `{x}`, `{ other }` for any other expression, or null when absent.
 *
 * @param {string} attrs
 * @param {string} attr
 * @returns {{ literal?: string, ident?: string, other?: string } | null}
 */
export function readAttr(attrs, attr) {
	const m = new RegExp(`(?:^|\\s)${attr}=`).exec(attrs);
	if (!m) return null;
	const rest = attrs.slice(m.index + m[0].length);
	const lit = /^"([^"]*)"|^'([^']*)'/.exec(rest);
	if (lit) return { literal: lit[1] ?? lit[2] };
	const ident = /^\{\s*([A-Za-z_$][\w$]*)\s*\}/.exec(rest);
	if (ident) return { ident: ident[1] };
	const strInBraces = /^\{\s*"([^"]*)"\s*\}/.exec(rest);
	if (strInBraces) return { literal: strInBraces[1] };
	return { other: rest.slice(0, 60) };
}

/**
 * Derives every name a list-page filter input can be found by, from `files` (path → source).
 * Returns the names (each with the file that declares it) and the problems that make the
 * derivation untrustworthy (an unreadable attribute; an empty result).
 *
 * @param {Map<string, string>} files
 * @returns {{ names: Map<string, string>, problems: string[] }}
 */
export function deriveNames(files) {
	/** @type {Map<string, string>} */
	const names = new Map();
	const problems = [];
	const tags = [...BASE_TAGS];
	for (let t = 0; t < tags.length; t++) {
		const tag = tags[t];
		for (const [path, src] of files) {
			for (const attrs of openingElements(src, tag)) {
				for (const attr of NAME_ATTRS) {
					const v = readAttr(attrs, attr);
					if (!v) continue;
					if (v.literal !== undefined) {
						if (v.literal.trim()) names.set(v.literal, path);
						continue;
					}
					const wrapper = v.ident ? wrapperDefault(src, v.ident) : null;
					if (wrapper) {
						names.set(wrapper.name, path);
						if (!tags.includes(wrapper.component)) tags.push(wrapper.component);
						continue;
					}
					problems.push(
						`${path}: <${tag} ${attr}=${v.ident ? `{${v.ident}}` : v.other}> — a filter input whose name this cannot ` +
							"read. Pass a string literal, or a prop with a string default in an exported wrapper component.",
					);
				}
			}
		}
	}
	if (names.size === 0) {
		problems.push(
			`no filter-input names were derived from ${SOURCE_DIRS.join(", ")}. The console has always had them; ` +
				"this walk is blind, which is not the same as there being nothing to guard.",
		);
	}
	return { names, problems };
}

/**
 * When `src` exports a component that destructures `ident = "…"`, returns that component's name
 * and the default — the shape of a wrapper that forwards its own `placeholder` prop.
 *
 * @param {string} src
 * @param {string} ident
 * @returns {{ component: string, name: string } | null}
 */
function wrapperDefault(src, ident) {
	const fn = /export\s+function\s+([A-Z][\w$]*)\s*\(\s*\{([\s\S]*?)\}\s*:/.exec(src);
	if (!fn) return null;
	const def = new RegExp(`(?:^|[\\s,{])${ident}\\s*=\\s*"([^"]+)"`).exec(fn[2]);
	return def ? { component: fn[1], name: def[1] } : null;
}

// ── the sites ────────────────────────────────────────────────────────────────────────────────────

/**
 * Returns the argument text of the call that opens at `start` (the index just after its `(`),
 * honouring nested parens, strings and regex-free code well enough for locator calls.
 *
 * @param {string} src
 * @param {number} start
 * @returns {string}
 */
function callArgs(src, start) {
	let depth = 1;
	let quote = "";
	let i = start;
	for (; i < src.length && depth > 0; i++) {
		const c = src[i];
		if (quote) {
			if (c === quote && src[i - 1] !== "\\") quote = "";
		} else if (c === '"' || c === "'" || c === "`") quote = c;
		else if (c === "(") depth++;
		else if (c === ")") depth--;
	}
	return src.slice(start, i - 1);
}

/**
 * Parses a locator call's first argument: a string (`{ text }`), a regex literal (`{ re }`), or
 * neither (`{ unreadable }`).
 *
 * @param {string} args
 * @returns {{ text?: string, re?: RegExp, unreadable?: string }}
 */
export function firstArg(args) {
	const a = args.trimStart();
	const str = /^"((?:[^"\\]|\\.)*)"|^'((?:[^'\\]|\\.)*)'|^`([^`$]*)`/.exec(a);
	if (str) return { text: str[1] ?? str[2] ?? str[3] };
	const re = /^\/((?:[^/\\\n]|\\.)+)\/([a-z]*)/.exec(a);
	if (re) {
		try {
			return { re: new RegExp(re[1], re[2]) };
		} catch {
			return { unreadable: a.slice(0, 60) };
		}
	}
	return { unreadable: a.split(/[,\n]/)[0].slice(0, 60) };
}

/**
 * Whether a Playwright text argument selects `name`: a regex is tested as written; a string is a
 * case-insensitive, whitespace-normalised substring, or a full case-sensitive match under `exact`.
 *
 * @param {{ text?: string, re?: RegExp }} arg
 * @param {boolean} exact
 * @param {string} name
 * @returns {boolean}
 */
export function selects(arg, exact, name) {
	const norm = (s) => s.replace(/\s+/g, " ").trim();
	if (arg.re) return arg.re.test(name);
	if (arg.text === undefined) return false;
	if (exact) return norm(arg.text) === norm(name);
	return norm(name).toLowerCase().includes(norm(arg.text).toLowerCase());
}

/**
 * Every `getByLabel(` / `getByPlaceholder(` call in `src` that selects a filter-input name, or
 * whose first argument cannot be evaluated. Each finding carries its line and a description.
 *
 * @param {string} src
 * @param {Map<string, string>} names
 * @returns {{ line: number, what: string }[]}
 */
export function findSites(src, names) {
	const out = [];
	const re = /\bgetBy(Label|Placeholder)\(/g;
	for (let m = re.exec(src); m; m = re.exec(src)) {
		const args = callArgs(src, m.index + m[0].length);
		const arg = firstArg(args);
		const line = src.slice(0, m.index).split("\n").length;
		if (arg.unreadable !== undefined) {
			out.push({ line, what: `getBy${m[1]}(${arg.unreadable}…) — an argument this cannot evaluate` });
			continue;
		}
		const exact = /\bexact\s*:\s*true\b/.test(args);
		const hit = [...names.keys()].find((name) => selects(arg, exact, name));
		if (hit) out.push({ line, what: `getBy${m[1]}(…) selects the filter input "${hit}" (${names.get(hit)})` });
	}
	return out;
}

/**
 * Holds the per-file findings against the ledger, in both directions.
 *
 * @param {Map<string, { line: number, what: string }[]>} findings  file → findings (files with none omitted)
 * @param {Record<string, { count: number }>} ledger
 * @returns {string[]}
 */
export function judge(findings, ledger) {
	const errors = [];
	for (const [file, list] of findings) {
		const allowed = ledger[file]?.count ?? 0;
		if (list.length > allowed) {
			const where = list.map((f) => `\n    ${file}:${f.line}  ${f.what}`).join("");
			errors.push(
				`${file}: ${list.length} filter-input locator(s) by label/placeholder, ${allowed} recorded.${where}\n` +
					'  Ask by role: getByRole("textbox" | "combobox", { name: "<the accessible name>", exact: true }). ' +
					"A hidden streamed Suspense copy matches getByLabel/getByPlaceholder; it never matches getByRole (#5777).",
			);
		}
	}
	for (const [file, entry] of Object.entries(ledger)) {
		const found = findings.get(file)?.length ?? 0;
		if (found < entry.count) {
			errors.push(
				`${file}: the ledger records ${entry.count} site(s), ${found} remain. Lower the entry to ${found}` +
					`${found === 0 ? " — i.e. delete it" : ""} in this PR, or it excuses the next site written there.`,
			);
		}
	}
	return errors;
}

// ── the live run ─────────────────────────────────────────────────────────────────────────────────

/**
 * Lists every file under `dir` (repo-relative) whose name ends with one of `exts`.
 *
 * @param {string} dir
 * @param {string[]} exts
 * @returns {string[]}
 */
function walk(dir, exts) {
	const out = [];
	for (const e of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
		const rel = join(dir, e.name);
		if (e.isDirectory()) {
			if (e.name !== "node_modules") out.push(...walk(rel, exts));
		} else if (exts.some((x) => e.name.endsWith(x))) out.push(rel);
	}
	return out;
}

/** Runs the guard over the real tree and exits non-zero on any finding. */
function live() {
	const sources = new Map();
	for (const d of SOURCE_DIRS) for (const f of walk(d, [".tsx"])) sources.set(f, readFileSync(join(ROOT, f), "utf8"));
	const { names, problems } = deriveNames(sources);
	if (problems.length) {
		for (const p of problems) console.error(`::error::${p}`);
		process.exit(1);
	}
	const specs = walk(E2E_DIR, [".ts"]);
	/** @type {Map<string, { line: number, what: string }[]>} */
	const findings = new Map();
	for (const f of specs) {
		const list = findSites(readFileSync(join(ROOT, f), "utf8"), names);
		if (list.length) findings.set(relative(ROOT, join(ROOT, f)), list);
	}
	const errors = judge(findings, LEDGER);
	if (errors.length) {
		for (const e of errors) console.error(`::error::${e}`);
		process.exit(1);
	}
	const recorded = Object.values(LEDGER).reduce((n, e) => n + e.count, 0);
	console.log(
		`e2e filter locators: ${names.size} filter-input names derived from ${sources.size} console files; ` +
			`${specs.length} e2e files read; no new label/placeholder locator on a filter input ` +
			`(${recorded} recorded in the ledger).`,
	);
}

// ── self-test ────────────────────────────────────────────────────────────────────────────────────

/** Hermetic fixtures: each case must hold, and each would fail if its matcher were weakened. */
function selfTest() {
	const failures = [];
	/** Records a failure when `cond` is false. */
	const expect = (cond, label) => {
		if (!cond) failures.push(label);
	};

	const sources = new Map([
		[
			"apps/console/components/runners/runners-toolbar.tsx",
			'<FilterSearch value={q} onChange={(v) => set("q", v)} placeholder="Search runners by name…" ariaLabel="Search runners" />',
		],
		["apps/console/app/jobs.tsx", '<MultiCombobox placeholder="All statuses" onChange={(n) => { if (n.length > 1) go(n); }} />'],
		[
			"apps/console/components/filters/cloud-filter.tsx",
			'export function CloudFilter({ value, placeholder = "All clouds" }: Props) { return <MultiCombobox placeholder={placeholder} value={value} />; }',
		],
		["apps/console/components/runners/bar.tsx", '<CloudFilter placeholder="All regions" value={v} />'],
	]);
	const { names, problems } = deriveNames(sources);
	expect(problems.length === 0, `derivation reported problems on clean fixtures: ${problems.join(" | ")}`);
	for (const n of ["Search runners by name…", "Search runners", "All statuses", "All clouds", "All regions"]) {
		expect(names.has(n), `derivation missed "${n}" (got ${[...names.keys()].join(", ")})`);
	}
	expect(!names.has("q"), "derivation read a non-name attribute");

	const unreadable = deriveNames(new Map([["x.tsx", "<FilterSearch placeholder={t('search')} />"]]));
	expect(
		unreadable.problems.some((p) => p.includes("cannot read")),
		"an unreadable placeholder expression did not refuse the run",
	);
	expect(deriveNames(new Map()).problems.length === 1, "an empty derivation did not refuse the run");

	/** The sites `findSites` reports for one line of spec source. */
	const sites = (line) => findSites(line, names).length;
	// The reintroduced sites this issue fixed — each must be caught.
	expect(sites('await page.getByPlaceholder("Search runners by name…").fill("alpha");') === 1, "missed a placeholder site");
	expect(sites('await expect(page.getByLabel("Search runners")).toBeVisible();') === 1, "missed a label site");
	expect(sites('page.getByLabel("search RUNNERS")') === 1, "string match is not case-insensitive");
	expect(sites("page.getByPlaceholder(/all statuses/i)") === 1, "missed a regex site");
	expect(sites("page.getByPlaceholder(/search/i).first()") === 1, "missed a broad regex that selects a filter input");
	expect(sites('page.getByPlaceholder("All clouds")') === 1, "missed a wrapper's default name");
	expect(sites("page.getByPlaceholder(facet)") === 1, "an unevaluable argument passed silently");
	expect(sites("page.getByLabel(new RegExp(name))") === 1, "a constructed regex passed silently");
	expect(sites("page.getByPlaceholder(`All ${kind}`)") === 1, "an interpolated template passed silently");
	// What must stay allowed — a guard that flags these gets disabled.
	expect(sites('page.getByRole("textbox", { name: "Search runners", exact: true })') === 0, "flagged a role locator");
	expect(sites('dialog.getByPlaceholder("teammate@company.com")') === 0, "flagged a form field");
	expect(sites('sheet.getByLabel("API Token", { exact: true })') === 0, "flagged an unrelated label");
	expect(sites('page.getByLabel("Search", { exact: true })') === 0, "exact: true was not honoured");
	expect(sites('page.getByLabel("Search runners", { exact: true })') === 1, "exact: true over-narrowed a real site");

	// The ledger, both directions.
	const one = new Map([["a.spec.ts", [{ line: 1, what: "x" }]]]);
	expect(judge(one, {}).length === 1, "a new site in an unrecorded file passed");
	expect(judge(one, { "a.spec.ts": { count: 1 } }).length === 0, "a recorded site failed");
	expect(judge(new Map(), { "a.spec.ts": { count: 1 } }).length === 1, "a stale ledger entry passed");
	expect(
		judge(new Map([["a.spec.ts", [{ line: 1, what: "x" }, { line: 2, what: "y" }]]]), { "a.spec.ts": { count: 1 } }).length === 1,
		"a second site in a recorded file passed",
	);

	if (failures.length) {
		for (const f of failures) console.error(`::error::self-test: ${f}`);
		process.exit(1);
	}
	console.log("e2e filter locators self-test: all cases hold.");
}

if (process.argv.includes("--self-test")) selfTest();
else live();
