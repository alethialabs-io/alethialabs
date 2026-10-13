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
// is scanned for the three shared list-page search/filter inputs: `<FilterSearch` and `<MultiCombobox`
// (packages/ui) and `<SettingsSearch` (apps/console/components/settings/settings-ui.tsx — the
// classification page's "Search dimensions & values"). From each element's own attributes it takes
// every name the input can be found by: `placeholder="…"` and `ariaLabel="…"` (FilterSearch names the
// input `ariaLabel ?? placeholder`; MultiCombobox's input has only its placeholder, which is also its
// accessible name; SettingsSearch's naming is in `TAG_NAMING`). A WRAPPER is
// followed: when the attribute is `placeholder={x}` and the file exports a component that
// destructures `x = "…"` (components/filters/cloud-filter.tsx → `CloudFilter`, "All clouds"), that
// default is a name and the exported component joins the scanned tags, with the literal placeholders
// its own callers pass. Anything else non-literal REFUSES the run: a name this cannot read is a name
// it cannot guard, and saying nothing about it would report green over it.
//
// Not read, deliberately: a popover's own search box (`FacetFilter`'s `searchPlaceholder`,
// `FunnelFilter`'s per-facet `Search <facet>…`, `ElenchConversationSwitcher`'s "Search
// conversations", a cmdk `CommandInput`). Those render only on the client after a click, so no
// server-streamed copy of them can exist, which is the defect this guards. Nor is a form field in a
// sheet or dialog, nor an inline one-off `<Input>` that is not a shared filter primitive (the agent
// thread rail's "Search chats") — the tag list above is hand-written, and those are outside it.
//
// The names are a SNAPSHOT of the input while it is empty: once `MultiCombobox` holds a value its
// name becomes the option's label or "N selected", and those names are not derived. Today's specs
// only query the facets while they are empty. And a wrapper's default is read from the FIRST
// `export function` in its file only; a second exported wrapper's default reports "cannot read" —
// which fails closed, though the message then names the wrong cause.
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
// `LEDGER` below is every known site the guard reports that is NOT a defect, ONE ENTRY PER SITE. A
// site's identity is its file plus the locator method and its first argument's source text
// (`getByPlaceholder(/search services/i)`), never its line, so an unrelated edit does not churn it;
// `count` covers a spec that repeats the identical call. `reason:` entries are unreadable calls that
// are known NOT to be a filter input — each says what it is instead. A `debt:` entry is a filter input
// still asked for by label or placeholder; there are none (#5801 converted the last of them), and a
// new one needs a board issue that removes it. A site found MORE often than its
// entry fails (a new site). One found LESS often fails too (the entry outlived its subject, and would
// otherwise excuse the next site written there): lower the number, or delete the entry, in the same
// PR as the fix. Per site, not per file: a per-file count let a fix and a new site in the same file
// cancel out (#5804's review).
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
const BASE_TAGS = ["FilterSearch", "MultiCombobox", "SettingsSearch"];
/**
 * How a base tag turns its `placeholder` into the input's accessible name, where that is not simply
 * `ariaLabel ?? placeholder`. `SettingsSearch` (apps/console/components/settings/settings-ui.tsx)
 * sets `aria-label={placeholder ? placeholder.replace(/…$/, "") : "Search"}`, so a placeholder ending
 * in "…" is found under BOTH spellings, and an element with no placeholder is named "Search".
 *
 * @type {Record<string, { stripEllipsis: boolean, unnamed: string }>}
 */
const TAG_NAMING = { SettingsSearch: { stripEllipsis: true, unnamed: "Search" } };
const NAME_ATTRS = ["placeholder", "ariaLabel"];

/**
 * Known, unfixed sites, ONE ENTRY PER SITE (see the header). `site` is the site's identity: the
 * locator method and its first argument's source text, whitespace-normalised — never a line number,
 * so an unrelated edit above it does not churn the entry. `count` is how many calls in `file` carry
 * that identical identity (a spec that asks for the same box four times); it must match exactly.
 *
 * @type {{ file: string, site: string, count: number, debt?: string, reason?: string }[]}
 */
const LEDGER = [
	{
		file: "apps/console/e2e/flows/alerts.negative.spec.ts",
		site: "getByLabel(urlField)",
		count: 1,
		reason: "a transport's URL field in the new-channel sheet, not a filter input",
	},
	{
		file: "apps/console/e2e/audit/destructive.spec.ts",
		site: "getByLabel(named)",
		count: 1,
		reason: "the destructive-action audit's generic overlay opener — names come from the control ledger, not a filter bar",
	},
	{
		file: "apps/console/e2e/audit/destructive.spec.ts",
		site: "getByLabel(new RegExp(escapeRe(subject), \"i\"))",
		count: 1,
		reason: "the destructive-action audit's undo probe — names come from the control ledger, not a filter bar",
	},
];

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
			const naming = TAG_NAMING[tag];
			for (const attrs of openingElements(src, tag)) {
				if (naming && !readAttr(attrs, "placeholder") && !readAttr(attrs, "ariaLabel")) names.set(naming.unnamed, path);
				for (const attr of NAME_ATTRS) {
					const v = readAttr(attrs, attr);
					if (!v) continue;
					if (v.literal !== undefined) {
						if (v.literal.trim()) names.set(v.literal, path);
						if (naming?.stripEllipsis && v.literal.endsWith("…")) names.set(v.literal.slice(0, -1), path);
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
 * neither (`{ unreadable }`). `source` is always the argument's own source text,
 * whitespace-normalised — the site's identity in the ledger.
 *
 * @param {string} args
 * @returns {{ source: string, text?: string, re?: RegExp, unreadable?: string }}
 */
export function firstArg(args) {
	const a = args.trimStart();
	const norm = (s) => s.replace(/\s+/g, " ").trim();
	const str = /^"((?:[^"\\]|\\.)*)"|^'((?:[^'\\]|\\.)*)'|^`([^`$]*)`/.exec(a);
	if (str) return { source: norm(str[0]), text: str[1] ?? str[2] ?? str[3] };
	const re = /^\/((?:[^/\\\n]|\\.)+)\/([a-z]*)/.exec(a);
	if (re) {
		try {
			return { source: norm(re[0]), re: new RegExp(re[1], re[2]) };
		} catch {
			return { source: norm(re[0]), unreadable: re[0].slice(0, 60) };
		}
	}
	const source = norm(firstExpression(a));
	return { source, unreadable: source.slice(0, 60) };
}

/**
 * The text of `a` up to its first comma at bracket depth 0 (outside strings) — the first argument
 * of a call whose first argument is an expression rather than a literal.
 *
 * @param {string} a
 * @returns {string}
 */
function firstExpression(a) {
	let depth = 0;
	let quote = "";
	for (let i = 0; i < a.length; i++) {
		const c = a[i];
		if (quote) {
			if (c === quote && a[i - 1] !== "\\") quote = "";
		} else if (c === '"' || c === "'" || c === "`") quote = c;
		else if ("([{".includes(c)) depth++;
		else if (")]}".includes(c)) depth--;
		else if (c === "," && depth === 0) return a.slice(0, i);
	}
	return a;
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
 * whose first argument cannot be evaluated. Each finding carries its line (for the message), its
 * `site` identity (for the ledger — method plus first-argument source, no line) and a description.
 *
 * @param {string} src
 * @param {Map<string, string>} names
 * @returns {{ line: number, site: string, what: string }[]}
 */
export function findSites(src, names) {
	const out = [];
	const re = /\bgetBy(Label|Placeholder)\(/g;
	for (let m = re.exec(src); m; m = re.exec(src)) {
		const args = callArgs(src, m.index + m[0].length);
		const arg = firstArg(args);
		const line = src.slice(0, m.index).split("\n").length;
		const site = `getBy${m[1]}(${arg.source})`;
		if (arg.unreadable !== undefined) {
			out.push({ line, site, what: `getBy${m[1]}(${arg.unreadable}…) — an argument this cannot evaluate` });
			continue;
		}
		const exact = /\bexact\s*:\s*true\b/.test(args);
		const hit = [...names.keys()].find((name) => selects(arg, exact, name));
		if (hit) out.push({ line, site, what: `getBy${m[1]}(…) selects the filter input "${hit}" (${names.get(hit)})` });
	}
	return out;
}

/**
 * Holds the findings against the ledger PER SITE, in both directions: a (file, site) pair found
 * more often than its entry records is a new site; one found less often is a stale entry. Because
 * the identity is the site and not the file, fixing one recorded site and adding a different one in
 * the same file fails twice rather than cancelling out.
 *
 * @param {Map<string, { line: number, site: string, what: string }[]>} findings  file → findings (files with none omitted)
 * @param {{ file: string, site: string, count: number }[]} ledger
 * @returns {string[]}
 */
export function judge(findings, ledger) {
	const errors = [];
	/** @type {Map<string, number>} */
	const recorded = new Map();
	for (const e of ledger) {
		const k = `${e.file}\u0000${e.site}`;
		if (recorded.has(k)) errors.push(`the ledger records ${e.file} ${e.site} twice — merge the entries.`);
		recorded.set(k, e.count);
	}
	/** @type {Map<string, { file: string, site: string, list: { line: number, what: string }[] }>} */
	const found = new Map();
	for (const [file, list] of findings) {
		for (const f of list) {
			const k = `${file}\u0000${f.site}`;
			const g = found.get(k) ?? { file, site: f.site, list: [] };
			g.list.push(f);
			found.set(k, g);
		}
	}
	for (const [k, g] of found) {
		const allowed = recorded.get(k) ?? 0;
		if (g.list.length > allowed) {
			const where = g.list.map((f) => `\n    ${g.file}:${f.line}  ${f.what}`).join("");
			errors.push(
				`${g.file}: ${g.list.length} × ${g.site} — a filter-input locator by label/placeholder, ${allowed} recorded.${where}\n` +
					'  Ask by role: getByRole("textbox" | "combobox", { name: "<the accessible name>", exact: true }). ' +
					"A hidden streamed Suspense copy matches getByLabel/getByPlaceholder; it never matches getByRole (#5777).",
			);
		}
	}
	for (const e of ledger) {
		const n = found.get(`${e.file}\u0000${e.site}`)?.list.length ?? 0;
		if (n < e.count) {
			errors.push(
				`${e.file}: the ledger records ${e.count} × ${e.site}, ${n} remain. Lower the entry to ${n}` +
					`${n === 0 ? " — i.e. delete it" : ""} in this PR, or it excuses the next such site written there.`,
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
	/** @type {Map<string, { line: number, site: string, what: string }[]>} */
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
	const recorded = LEDGER.reduce((n, e) => n + e.count, 0);
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
		[
			"apps/console/components/classification/classification-manager.tsx",
			'<SettingsSearch value={q} onChange={setQ} placeholder="Search dimensions & values" className="w-[240px]" />',
		],
		["apps/console/components/settings/tags.tsx", '<SettingsSearch value={q} onChange={setQ} placeholder="Search tags…" />'],
	]);
	const { names, problems } = deriveNames(sources);
	expect(problems.length === 0, `derivation reported problems on clean fixtures: ${problems.join(" | ")}`);
	for (const n of [
		"Search runners by name…",
		"Search runners",
		"All statuses",
		"All clouds",
		"All regions",
		"Search dimensions & values",
		"Search tags…",
		"Search tags",
	]) {
		expect(names.has(n), `derivation missed "${n}" (got ${[...names.keys()].join(", ")})`);
	}
	expect(!names.has("q"), "derivation read a non-name attribute");

	const unreadable = deriveNames(new Map([["x.tsx", "<FilterSearch placeholder={t('search')} />"]]));
	expect(
		unreadable.problems.some((p) => p.includes("cannot read")),
		"an unreadable placeholder expression did not refuse the run",
	);
	expect(deriveNames(new Map()).problems.length === 1, "an empty derivation did not refuse the run");
	expect(
		deriveNames(new Map([["s.tsx", "<SettingsSearch value={q} onChange={setQ} />"]])).names.has("Search"),
		'a placeholder-less SettingsSearch was not named "Search"',
	);

	/** The sites `findSites` reports for one line of spec source. */
	const sites = (line) => findSites(line, names).length;
	// The reintroduced sites this issue fixed — each must be caught.
	expect(sites('await page.getByPlaceholder("Search runners by name…").fill("alpha");') === 1, "missed a placeholder site");
	expect(sites('await expect(page.getByLabel("Search runners")).toBeVisible();') === 1, "missed a label site");
	expect(sites('page.getByLabel("search RUNNERS")') === 1, "string match is not case-insensitive");
	expect(sites("page.getByPlaceholder(/all statuses/i)") === 1, "missed a regex site");
	expect(sites("page.getByPlaceholder(/search/i).first()") === 1, "missed a broad regex that selects a filter input");
	expect(sites('page.getByPlaceholder("All clouds")') === 1, "missed a wrapper's default name");
	expect(sites('page.getByPlaceholder("Search dimensions & values")') === 1, "missed a SettingsSearch placeholder site");
	expect(sites('page.getByLabel("Search tags", { exact: true })') === 1, "missed a SettingsSearch aria-label (… stripped)");
	expect(sites("page.getByPlaceholder(facet)") === 1, "an unevaluable argument passed silently");
	expect(sites("page.getByLabel(new RegExp(name))") === 1, "a constructed regex passed silently");
	expect(sites("page.getByPlaceholder(`All ${kind}`)") === 1, "an interpolated template passed silently");
	// What must stay allowed — a guard that flags these gets disabled.
	expect(sites('page.getByRole("textbox", { name: "Search runners", exact: true })') === 0, "flagged a role locator");
	expect(sites('dialog.getByPlaceholder("teammate@company.com")') === 0, "flagged a form field");
	expect(sites('sheet.getByLabel("API Token", { exact: true })') === 0, "flagged an unrelated label");
	expect(sites('page.getByLabel("Search", { exact: true })') === 0, "exact: true was not honoured");
	expect(sites('page.getByLabel("Search runners", { exact: true })') === 1, "exact: true over-narrowed a real site");

	// The ledger, per site, both directions.
	const site = (k) => ({ line: 1, site: k, what: "x" });
	const one = new Map([["a.spec.ts", [site('getByLabel("Search runners")')]]]);
	const rec = (count) => [{ file: "a.spec.ts", site: 'getByLabel("Search runners")', count }];
	expect(judge(one, []).length === 1, "a new site in an unrecorded file passed");
	expect(judge(one, rec(1)).length === 0, "a recorded site failed");
	expect(judge(new Map(), rec(1)).length === 1, "a stale ledger entry passed");
	expect(
		judge(new Map([["a.spec.ts", [site('getByLabel("Search runners")'), site('getByLabel("Search runners")')]]]), rec(1)).length === 1,
		"a second identical site in a recorded file passed",
	);
	expect(judge(one, [...rec(1), ...rec(1)]).length >= 1, "a duplicated ledger entry passed");

	// #5804's review, exactly: fix the recorded evidence.spec.ts site and add a different one in the
	// SAME file. A per-file count saw 1 found, 1 recorded, and exited 0.
	const evidence = "apps/console/e2e/evidence.spec.ts";
	const evName = new Map([...names, ["Filter by project or environment…", "evidence-filter.tsx"]]);
	const evLedger = [{ file: evidence, site: "getByPlaceholder(/Filter by project or environment/i)", count: 1 }];
	const before = "await expect(\n\t\t\tpage.getByPlaceholder(/Filter by project or environment/i),\n\t\t).toBeVisible();\n";
	const swapped =
		'await expect(\n\t\t\tpage.getByRole("textbox", { name: "Filter by project or environment", exact: true }),\n\t\t).toBeVisible();\n' +
		'await page.getByLabel("Search runners").fill("x");\n';
	expect(judge(new Map([[evidence, findSites(before, evName)]]), evLedger).length === 0, "the recorded evidence site failed");
	expect(
		judge(new Map([[evidence, findSites(swapped, evName)]]), evLedger).length === 2,
		"a fixed site and a new site in the same file cancelled out (expected one new-site and one stale-entry error)",
	);
	// …while the same site moved down by unrelated lines does not churn its entry.
	expect(
		judge(new Map([[evidence, findSites(`// a\n// b\n\n${before}`, evName)]]), evLedger).length === 0,
		"a recorded site that only moved lines failed — the identity must not include the line",
	);
	expect(
		findSites("page.getByPlaceholder(/search actor, action or resource/i)", new Map([["Search actor, action or resource…", "x.tsx"]]))[0]
			?.site ===
			"getByPlaceholder(/search actor, action or resource/i)",
		"a regex literal with a comma was not kept whole as the site identity",
	);
	expect(
		findSites("sheet.getByLabel(urlField, { exact: true })", names)[0]?.site === "getByLabel(urlField)",
		"an expression argument's identity took more than the first argument",
	);

	if (failures.length) {
		for (const f of failures) console.error(`::error::self-test: ${f}`);
		process.exit(1);
	}
	console.log("e2e filter locators self-test: all cases hold.");
}

if (process.argv.includes("--self-test")) selfTest();
else live();
