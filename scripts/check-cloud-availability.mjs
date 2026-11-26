#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
//
// Fails on a NEW hand-written cloud list, and on a HIDDEN cloud named on a user-visible surface
// (#6950, wave spec alibaba-switch §4.6, unit ALI-L5).
//
// WHY THIS EXISTS. One field — `availability` on each `live.providers` entry of
// packages/core/catalog/catalog.json — decides which clouds the product offers, and every offer
// list derives from it (`@repo/cloud-catalog`'s AVAILABLE_CLOUDS, the console's `offeredClouds()`,
// Go's `catalog.OfferedProviders()`). Before the switch the tree carried twenty hand-written cloud
// lists, four of which silently omitted Hetzner; a list typed by hand is a list that does not move
// when the field does. And "hidden" is a promise to users, so a hidden cloud's name in the docs or
// on the marketing site breaks it whatever the code does.
//
// THE DOMAIN, and what it ranges over. Both rules read their clouds from catalog.json at run time,
// not from this file: rule 1's slugs are EVERY key of `live.providers` (today aws, gcp, azure,
// alibaba, digitalocean, hetzner, civo); rule 2's terms are, for each entry whose `availability` is
// "hidden" (today alibaba, digitalocean, civo), its `slug`, `name` and `shortName`, dropping any
// term shorter than four characters (DigitalOcean's shortName "DO" is an English word). A cloud
// added to the catalog joins both rules with no edit here; a cloud flipped to "available" leaves
// rule 2 by itself (spec §4.7 step 2). With no hidden cloud at all, rule 2 matches nothing — that
// is the correct answer, not a blind spot. The hand-written part is the set of ROOTS below; that
// is what a reader must check when deciding whether "green" covers a file.
//
// RULE 1 — cloud-list. Read: tracked `.ts`, `.tsx`, `.mjs` and `.go` files under apps/, packages/,
// ee/, scripts/ and test/e2e/ (RULE1_ROOTS), minus tests (`_test.go`, `*.test.*`, `*.spec.*`,
// `.d.ts`, and any `tests/`, `__tests__/`, `testdata/` directory, plus an `e2e/` directory under
// apps/ or packages/ — the Playwright suites), minus this script (its self-test plants lists).
// Matched, after comments are stripped: a RUN of three or more adjacent string literals — each
// separated from the next by nothing but whitespace, `,` and `|` — of which three or more DISTINCT
// values are cloud slugs, exactly and case-sensitively. That one shape is an array or `Set`
// literal, a `z.enum([...])`, a TypeScript string-literal union, a Go slice literal
// (`[]string{"aws", …}`) and a Go `case "aws", "gcp", "azure":` list; a non-slug literal inside the
// run (`["aws", "gcp", "azure", "k8s"]`) does not break it. One finding per run.
//
// RULE 2 — hidden-name. A hidden-cloud term, case-insensitive, not touching a letter or digit on
// either side (so `DIGITALOCEAN_ACCESS_TOKEN` and `alibaba-cloud` match; `civonia` does not), on:
//   · apps/marketing/**   — `.ts .tsx .js .jsx .mjs .md .mdx .json .html .txt .xml .yaml .yml`,
//                           minus tests as above; comments stripped from the script kinds;
//   · apps/docs/content/** — `.md .mdx .json` (meta.json carries nav titles), minus a page whose
//                           frontmatter says `availability: hidden` (apps/docs/lib/source.ts drops
//                           such a page from the tree, search, llms-full.txt and the Markdown route);
//   · apps/blog/content/** — same kinds as the docs content;
//   · README.md at the repo root;
//   · apps/console/app/**  — `.ts`/`.tsx` only, and only inside the string literal that is the value
//                           of a `title:` or `description:` object property (a Next.js `metadata`
//                           export or `generateMetadata` return). That is WIDER than metadata — any
//                           object with those keys is read — and narrower than the page.
// One finding per (line, hidden cloud).
//
// WHAT IS DELIBERATELY NOT MATCHED, so nobody reads this as more than it is:
//   · a list of fewer than three clouds; a map or `Record` keyed by cloud (`{ aws: "AWS", … }`) —
//     the compiler forces those to be exhaustive and they exist so old rows render (spec §2,
//     class C); a list built at run time, spread over several statements, or held as objects
//     (`[{ slug: "aws" }, …]`); a slug in a template literal with a `${…}`;
//   · `.js`, `.jsx` and `.cjs` source under the rule-1 roots (the spec names `.ts .tsx .mjs .go`);
//     Go test files and every TypeScript test (a test that drives a hidden cloud is the point);
//   · cobra `Short`/`Long`/flag-usage strings in apps/cli/cmd/*.go: the issue moves that surface to
//     CLI-L14, which owns the CLI's docs surface and adds it here;
//   · an `<IfCloud>` MDX block: no such component exists at this commit (the docs lane edited the
//     mentions by hand, spec §8 cut line 1). If one is added, exempt its blocks here;
//   · console copy outside `title:`/`description:` (JSX text, toasts, `title=` props), the agent's
//     prompts, and anything rendered from the database — the server's refusal (lane L1's tests) is
//     the control for those, not this text scan;
//   · a cloud named only by its service ("ACK", "RAM role", "DOKS"), or as "Digital Ocean" with a
//     space; copy inside images, `.svg` diagrams (apps/docs/public/diagrams/concepts/) or video;
//   · MDX/HTML comments in docs, blog and marketing content are read as text.
// The comment stripper is a tokenizer, not a parser: an apostrophe in JSX text can be misread as
// a quote. A misread that opens a string keeps text, so it can only ADD a finding; a quote string
// is closed at its line's end, so no misread outlives the line.
//
// FLOORS. Each scanned root has a file-count floor (FLOORS below). A real run that read fewer files
// under a root refuses to report green — a renamed directory or a broken `git ls-files` must not
// read as "no lists found".
//
// THE LEDGER is scripts/cloud-availability-allowlist.yaml, parsed strictly (an unrecognised line
// fails). A `cloud-list` entry names a file and the EXACT number of lists it holds (`lists: N`); a
// `hidden-name` entry names a file and ONE hidden cloud (`cloud: <slug>`), and excuses every mention
// of that cloud in that file and nothing else. Each carries EXACTLY ONE of `reason:` — a decision
// that this file genuinely is a capability list, an exhaustive map or a surface users must read —
// or `lifts: #<issue>` — measured drift that the named open board issue removes. The split is the
// shared-surface allowlist's: a `reason:` meaning "not yet" is what it exists to prevent. Whether
// a `lifts:` issue is still open is NOT checked (this guard makes no network call). The ledger is
// checked in BOTH directions: a finding with no entry fails, more lists than `lists:` fails, and an
// entry that excuses nothing — fewer lists than it says, a file with no mention, a cloud no longer
// hidden, a deleted file — fails as stale.
//
// Usage:  node scripts/check-cloud-availability.mjs [--self-test]

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LEDGER = "scripts/cloud-availability-allowlist.yaml";
const CATALOG = "packages/core/catalog/catalog.json";
const SELF = "scripts/check-cloud-availability.mjs";

export const RULE_IDS = ["cloud-list", "hidden-name"];

/** Rule 1's roots, in the order they are reported. */
export const RULE1_ROOTS = ["apps/", "packages/", "ee/", "scripts/", "test/e2e/"];
/** Rule 2's surfaces: a name, the path prefix, and whether only metadata strings are read. */
export const RULE2_SURFACES = [
	{ id: "marketing", prefix: "apps/marketing/" },
	{ id: "docs-content", prefix: "apps/docs/content/" },
	{ id: "blog-content", prefix: "apps/blog/content/" },
	{ id: "readme", prefix: "README.md" },
	{ id: "console-metadata", prefix: "apps/console/app/" },
];

/**
 * The fewest files a real run must read under each root before it may report green: about 80% of
 * the count measured on dev at 7252786f7 on 2026-11-26 (in the trailing comments; every green run
 * prints the current counts), so ordinary churn does not trip it and a lost root does.
 */
export const FLOORS = {
	"cloud-list:apps/": 2000, // 2440
	"cloud-list:packages/": 360, // 454
	"cloud-list:ee/": 10, // 15
	"cloud-list:scripts/": 90, // 114
	"cloud-list:test/e2e/": 50, // 65
	"hidden-name:marketing": 50, // 65
	"hidden-name:docs-content": 190, // 235
	"hidden-name:blog-content": 10, // 14
	"hidden-name:readme": 1, // 1
	"hidden-name:console-metadata": 310, // 391
};

const RULE1_EXT = /\.(ts|tsx|mjs|go)$/;
const MARKETING_EXT = /\.(ts|tsx|js|jsx|mjs|md|mdx|json|html|txt|xml|yaml|yml)$/;
const CONTENT_EXT = /\.(md|mdx|json)$/;
const SCRIPT_EXT = /\.(ts|tsx|js|jsx|mjs)$/;

/** Is this path test code (by name or directory) — never a surface and never an offer list? */
export function isTestPath(path) {
	if (/_test\.go$/.test(path) || /\.(test|spec)\.[a-z]+$/.test(path) || /\.d\.ts$/.test(path)) return true;
	if (/(^|\/)(tests|__tests__|testdata|node_modules)\//.test(path)) return true;
	return /^(apps|packages)\/(.+\/)?e2e\//.test(path);
}

/** The rule-1 root a path falls under, or null when rule 1 does not read it. */
export function rule1Root(path) {
	if (!RULE1_EXT.test(path) || isTestPath(path) || path === SELF) return null;
	return RULE1_ROOTS.find((r) => path.startsWith(r)) ?? null;
}

/** The rule-2 surface a path falls under, or null when rule 2 does not read it. */
export function rule2Surface(path) {
	if (isTestPath(path)) return null;
	if (path === "README.md") return "readme";
	if (path.startsWith("apps/marketing/")) return MARKETING_EXT.test(path) ? "marketing" : null;
	if (path.startsWith("apps/docs/content/")) return CONTENT_EXT.test(path) ? "docs-content" : null;
	if (path.startsWith("apps/blog/content/")) return CONTENT_EXT.test(path) ? "blog-content" : null;
	if (path.startsWith("apps/console/app/")) return /\.(ts|tsx)$/.test(path) ? "console-metadata" : null;
	return null;
}

/**
 * Removes `//` and `/* *\/` comments, keeping string and template-literal contents (a template's
 * `${…}` is code). Line breaks are kept so reported line numbers stay right. A quote string that
 * reaches a newline is closed there, which bounds the damage of a misread to one line. The same
 * tokenizer as check-single-keydown.mjs; it reads Go too (a raw string is a backtick literal).
 */
export function stripComments(src) {
	let out = "";
	const stack = ["code"];
	let i = 0;
	while (i < src.length) {
		const ch = src[i];
		const next = src[i + 1];
		const top = stack[stack.length - 1];
		if (top === "code") {
			if (ch === "/" && next === "/") {
				while (i < src.length && src[i] !== "\n") i++;
				continue;
			}
			if (ch === "/" && next === "*") {
				const end = src.indexOf("*/", i + 2);
				const stop = end === -1 ? src.length : end + 2;
				out += src.slice(i, stop).replace(/[^\n]/g, "");
				i = stop;
				continue;
			}
			if (ch === '"' || ch === "'" || ch === "`") stack.push(ch);
			else if (ch === "{" && stack.length > 1) stack.push("code");
			else if (ch === "}" && stack.length > 1) stack.pop();
			out += ch;
			i++;
			continue;
		}
		if (ch === "\\") {
			out += src.slice(i, i + 2);
			i += 2;
			continue;
		}
		if (top === "`" && ch === "$" && next === "{") {
			stack.push("code");
			out += "${";
			i += 2;
			continue;
		}
		if (ch === top) stack.pop();
		else if (ch === "\n" && top !== "`") stack.pop();
		out += ch;
		i++;
	}
	return out;
}

/** The 1-based line of an offset in a text. */
function lineAt(text, offset) {
	let n = 1;
	for (let i = 0; i < offset; i++) if (text.charCodeAt(i) === 10) n++;
	return n;
}

/** A string literal with no interpolation: double or single quoted on one line, or a backtick. */
const LITERAL = /"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'|`([^`$]*)`/g;
const SEPARATOR = /^[\s,|]*$/;

/**
 * Rule 1 over one source text: `{ line, text }` for every run of adjacent literals holding three or
 * more distinct cloud slugs.
 */
export function findCloudLists(src, slugs) {
	const code = stripComments(src);
	const raw = src.split("\n");
	const slugSet = new Set(slugs);
	const lits = [...code.matchAll(LITERAL)].map((m) => ({
		start: m.index,
		end: m.index + m[0].length,
		value: m[1] ?? m[2] ?? m[3] ?? "",
	}));
	const out = [];
	let i = 0;
	while (i < lits.length) {
		let j = i;
		while (j + 1 < lits.length && SEPARATOR.test(code.slice(lits[j].end, lits[j + 1].start))) j++;
		const run = lits.slice(i, j + 1);
		const clouds = new Set(run.map((l) => l.value).filter((v) => slugSet.has(v)));
		if (clouds.size >= 3) {
			const first = run.find((l) => slugSet.has(l.value)) ?? run[0];
			const line = lineAt(code, first.start);
			out.push({ line, text: (raw[line - 1] ?? "").trim(), clouds: [...clouds] });
		}
		i = j + 1;
	}
	return out;
}

/** The regex for one term: case-insensitive, not touching a letter or digit on either side. */
function termPattern(term) {
	const esc = term.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&").replace(/\s+/g, "\\s+");
	return new RegExp(`(?<![A-Za-z0-9])${esc}(?![A-Za-z0-9])`, "gi");
}

/** Does this docs/blog page declare `availability: hidden` in its frontmatter? */
export function isHiddenPage(src) {
	const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(src);
	return !!fm && /^availability:\s*["']?hidden["']?\s*$/m.test(fm[1]);
}

/** The `title:`/`description:` property string literals of a console source, as text regions. */
const META_PROPERTY = /\b(?:title|description)\s*:\s*("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`[^`]*`)/g;

/**
 * Rule 2 over one file of a surface: `{ line, cloud, text }` for each (line, hidden cloud) mention.
 * `hidden` is `[{ slug, terms }]`.
 */
export function findHiddenNames(surface, path, src, hidden) {
	if ((surface === "docs-content" || surface === "blog-content") && isHiddenPage(src)) return [];
	const raw = src.split("\n");
	let text = SCRIPT_EXT.test(path) ? stripComments(src) : src;
	if (surface === "console-metadata") {
		// Blank everything that is not a title/description value, keeping line breaks.
		let kept = text.replace(/[^\n]/g, " ");
		for (const m of text.matchAll(META_PROPERTY)) {
			const at = m.index + m[0].length - m[1].length;
			kept = kept.slice(0, at) + m[1] + kept.slice(at + m[1].length);
		}
		text = kept;
	}
	const seen = new Set();
	const out = [];
	for (const { slug, terms } of hidden) {
		for (const term of terms) {
			for (const m of text.matchAll(termPattern(term))) {
				const line = lineAt(text, m.index);
				if (seen.has(`${line}:${slug}`)) continue;
				seen.add(`${line}:${slug}`);
				out.push({ line, cloud: slug, text: (raw[line - 1] ?? "").trim() });
			}
		}
	}
	return out.sort((a, b) => a.line - b.line);
}

/**
 * The domain both rules range over, from a parsed catalog: every `live.providers` slug, and each
 * hidden entry's terms (slug, name, shortName; four characters or more, de-duplicated).
 */
export function domainFromCatalog(catalog) {
	const providers = catalog?.live?.providers;
	if (!providers || typeof providers !== "object") throw new Error(`${CATALOG}: no live.providers object`);
	const slugs = Object.keys(providers);
	const hidden = [];
	for (const [slug, p] of Object.entries(providers)) {
		if (p.availability !== "available" && p.availability !== "hidden")
			throw new Error(`${CATALOG}: live.providers.${slug} has availability ${JSON.stringify(p.availability)}`);
		if (p.availability !== "hidden") continue;
		const terms = [...new Set([slug, p.name, p.shortName].filter((t) => typeof t === "string" && t.length >= 4))];
		hidden.push({ slug, terms });
	}
	if (slugs.length < 3) throw new Error(`${CATALOG}: fewer than three clouds — rule 1 could never match`);
	return { slugs, hidden };
}

/**
 * Runs both rules over a set of files and applies the ledger. Returns the violations, the stale
 * entries and the per-root file counts.
 */
export function evaluate(files, ledger, domain) {
	const violations = [];
	const stale = [];
	const counts = {};
	const listsByFile = new Map();
	const namesByFile = new Map();
	for (const [path, src] of files) {
		const root = rule1Root(path);
		if (root) {
			counts[`cloud-list:${root}`] = (counts[`cloud-list:${root}`] ?? 0) + 1;
			const found = findCloudLists(src, domain.slugs);
			if (found.length) listsByFile.set(path, found);
		}
		const surface = rule2Surface(path);
		if (surface) {
			counts[`hidden-name:${surface}`] = (counts[`hidden-name:${surface}`] ?? 0) + 1;
			const found = findHiddenNames(surface, path, src, domain.hidden);
			if (found.length) namesByFile.set(path, found);
		}
	}
	for (const [path, found] of listsByFile) {
		const entry = ledger.find((e) => e.rule === "cloud-list" && e.file === path);
		if (!entry) {
			for (const f of found) violations.push({ path, rule: "cloud-list", ...f });
		} else if (found.length > entry.lists) {
			violations.push({
				path,
				rule: "cloud-list",
				line: found[0].line,
				text: `${found.length} lists, the ledger excuses ${entry.lists}: ${found.map((f) => `line ${f.line}`).join(", ")}`,
			});
		}
	}
	for (const e of ledger) {
		if (e.rule === "cloud-list") {
			const n = listsByFile.get(e.file)?.length ?? 0;
			if (n < e.lists) stale.push({ ...e, why: `holds ${n} list(s), the entry says ${e.lists}` });
		}
	}
	for (const [path, found] of namesByFile) {
		for (const f of found) {
			if (!ledger.some((e) => e.rule === "hidden-name" && e.file === path && e.cloud === f.cloud))
				violations.push({ path, rule: "hidden-name", ...f });
		}
	}
	for (const e of ledger) {
		if (e.rule === "hidden-name" && !(namesByFile.get(e.file) ?? []).some((f) => f.cloud === e.cloud))
			stale.push({ ...e, why: `no longer names hidden cloud "${e.cloud}"` });
	}
	violations.sort((a, b) => (a.path === b.path ? a.line - b.line : a.path < b.path ? -1 : 1));
	return { violations, stale, counts };
}

/** The floors a set of per-root counts falls under: `[{ key, got, floor }]`. */
export function underFloors(counts, floors = FLOORS) {
	return Object.entries(floors)
		.filter(([key, floor]) => (counts[key] ?? 0) < floor)
		.map(([key, floor]) => ({ key, got: counts[key] ?? 0, floor }));
}

/**
 * Parses the ledger YAML — the one shape the file documents. Throws on any line it does not
 * recognise, a missing or misplaced field, an unknown rule and a duplicate, so a malformed ledger
 * fails instead of reading as empty.
 */
export function parseLedger(text) {
	const entries = [];
	let sawKey = false;
	let inline = false;
	let current = null;
	const finish = () => {
		if (!current) return;
		for (const k of ["file", "rule"]) {
			if (!current[k]) throw new Error(`ledger entry is missing "${k}": ${JSON.stringify(current)}`);
		}
		if ((current.reason === undefined) === (current.lifts === undefined))
			throw new Error(`ledger entry ${current.file} needs exactly one of "reason" or "lifts"`);
		if (current.lifts !== undefined && !/^#[1-9]\d*$/.test(current.lifts))
			throw new Error(`ledger entry ${current.file} has "lifts: ${current.lifts}" — expected "#<issue number>"`);
		if (!RULE_IDS.includes(current.rule)) throw new Error(`ledger entry has unknown rule "${current.rule}"`);
		if (current.rule === "cloud-list") {
			if (current.cloud !== undefined) throw new Error(`cloud-list entry ${current.file} carries "cloud"`);
			if (!/^[1-9]\d*$/.test(current.lists ?? "")) throw new Error(`cloud-list entry ${current.file} needs "lists: <n ≥ 1>"`);
			current.lists = Number(current.lists);
		} else {
			if (current.lists !== undefined) throw new Error(`hidden-name entry ${current.file} carries "lists"`);
			if (!/^[a-z0-9-]+$/.test(current.cloud ?? "")) throw new Error(`hidden-name entry ${current.file} needs "cloud: <slug>"`);
		}
		if (entries.some((e) => e.file === current.file && e.rule === current.rule && e.cloud === current.cloud))
			throw new Error(`ledger lists ${current.file} / ${current.rule}${current.cloud ? ` / ${current.cloud}` : ""} twice`);
		entries.push(current);
		current = null;
	};
	text.split("\n").forEach((rawLine, n) => {
		const line = rawLine.replace(/\s+$/, "");
		if (line === "" || /^\s*#/.test(line)) return;
		const where = `${LEDGER}:${n + 1}`;
		if (!sawKey) {
			const top = /^entries:\s*(\[\])?$/.exec(line);
			if (!top) throw new Error(`${where}: expected "entries:" — got ${JSON.stringify(line)}`);
			sawKey = true;
			inline = top[1] !== undefined;
			return;
		}
		if (inline) throw new Error(`${where}: "entries: []" is empty, but a line follows it`);
		const field = /^ {2}(- | {2})(file|rule|lists|cloud|reason|lifts):\s+(.+)$/.exec(line);
		if (!field) throw new Error(`${where}: not an entry field — ${JSON.stringify(line)}`);
		if (field[1] === "- ") {
			finish();
			current = {};
		} else if (!current) throw new Error(`${where}: a field before any "- " entry`);
		if (current[field[2]] !== undefined) throw new Error(`${where}: "${field[2]}" given twice`);
		current[field[2]] = field[3].replace(/^(["'])(.*)\1$/, "$2");
	});
	finish();
	if (!sawKey) throw new Error(`${LEDGER}: no "entries:" key`);
	return entries;
}

/** The tracked files either rule reads, with their contents. */
function trackedSources(root) {
	const listed = execFileSync(
		"git",
		["ls-files", "-z", "--", "apps", "packages", "ee", "scripts", "test/e2e", "README.md"],
		{ cwd: root, maxBuffer: 128 * 1024 * 1024 },
	)
		.toString()
		.split("\0")
		.filter((p) => p && (rule1Root(p) || rule2Surface(p)));
	return listed.map((p) => [p, readFileSync(join(root, p), "utf8")]);
}

/** Prints the result and returns the exit code. */
function report({ violations, stale, counts }, floors) {
	for (const v of violations) {
		const fix =
			v.rule === "cloud-list"
				? "derive it from @repo/cloud-catalog (AVAILABLE_CLOUDS / PROVISIONABLE_CLOUDS / ALL_CLOUDS), offeredClouds() on the console server, or catalog.OfferedProviders() in Go — or, if it is a capability list or an exhaustive map, add a cloud-list entry with its reason"
				: `"${v.cloud}" is hidden (catalog.json availability): remove it, or mark the docs page \`availability: hidden\`, or add a hidden-name entry whose reason says why users must read it`;
		console.error(`✗ ${v.path}:${v.line}  [${v.rule}${v.cloud ? ` ${v.cloud}` : ""}]  ${v.text}\n    ${fix}`);
	}
	for (const s of stale) {
		console.error(`✗ stale ledger entry: ${s.file} [${s.rule}${s.cloud ? ` ${s.cloud}` : ""}] ${s.why} — fix or delete it in ${LEDGER}`);
	}
	for (const f of floors) {
		console.error(`✗ read ${f.got} file(s) for ${f.key}, below the floor of ${f.floor} — a root moved or git ls-files failed; refusing to report green`);
	}
	if (violations.length || stale.length || floors.length) {
		console.error(
			`\ncheck-cloud-availability: ${violations.length} finding(s), ${stale.length} stale ledger entr(ies), ${floors.length} floor(s) missed.`,
		);
		return 1;
	}
	const summary = Object.entries(counts)
		.sort()
		.map(([k, n]) => `${k}=${n}`)
		.join(" ");
	console.log(`✓ check-cloud-availability: no unlisted cloud list, no hidden cloud on a surface (${summary})`);
	return 0;
}

/** A fixture domain that is NOT the catalog's, so the rules are not tested only against Alibaba. */
const FIXTURE = {
	slugs: ["aws", "gcp", "azure", "zephyr", "nimbus"],
	hidden: [
		{ slug: "zephyr", terms: ["zephyr", "Zephyr Cloud"] },
		{ slug: "nimbus", terms: ["nimbus"] },
	],
};

/** The self-test. Every case is [description, files, expected "rule@line" list]; the exit code is the test. */
function selfTest() {
	let failed = 0;
	const fail = (msg) => {
		failed++;
		console.error(`✗ self-test: ${msg}`);
	};
	const run = (name, files, want, domain = FIXTURE, ledger = []) => {
		const { violations, stale } = evaluate(new Map(files), ledger, domain);
		const got = violations.map((v) => `${v.rule}@${v.line}`);
		if (JSON.stringify(got) !== JSON.stringify(want) || stale.length)
			fail(`${name}: got ${JSON.stringify(got)} / stale ${stale.length}, want ${JSON.stringify(want)}`);
	};
	const LIST_TS = 'export const C = ["aws", "gcp", "zephyr"];';
	const LIST_GO = 'package x\n\nfunc f(p string) bool {\n\tswitch p {\n\tcase "aws", "gcp", "zephyr":\n\t\treturn true\n\t}\n\treturn false\n}';

	// Rule 1 — a planted list is found in EVERY scanned root.
	const planted1 = {
		"apps/": ["apps/console/lib/x.ts", LIST_TS],
		"packages/": ["packages/ui/src/x.tsx", LIST_TS],
		"ee/": ["ee/console/x.ts", LIST_TS],
		"scripts/": ["scripts/x.mjs", LIST_TS],
		"test/e2e/": ["test/e2e/x.go", LIST_GO],
	};
	for (const root of RULE1_ROOTS) {
		if (!planted1[root]) fail(`no planted list for rule-1 root ${root}`);
		else run(`planted list in ${root}`, [planted1[root]], [root === "test/e2e/" ? "cloud-list@5" : "cloud-list@1"]);
	}
	// Rule 1 — every token shape.
	const F = "apps/console/lib/x.ts";
	run("a multi-line array with comments", [[F, 'const a = [\n\t"aws", // first\n\t"gcp",\n\t/* x */ "zephyr",\n];']], ["cloud-list@2"]);
	run("a Set", [[F, 'new Set(["azure", "gcp", "aws"]);']], ["cloud-list@1"]);
	run("a z.enum", [[F, "z.enum(['aws', 'gcp', 'nimbus'])"]], ["cloud-list@1"]);
	run("a string-literal union", [[F, 'type C =\n\t| "aws"\n\t| "gcp"\n\t| "zephyr";']], ["cloud-list@2"]);
	run("a Go slice literal", [["packages/core/x.go", 'var c = []string{"aws", "gcp", "azure"}']], ["cloud-list@1"]);
	run("a non-slug literal inside the run", [[F, 'const a = ["aws", "k8s", "gcp", "azure"];']], ["cloud-list@1"]);
	run("two lists, two findings", [[F, `${LIST_TS}\n${LIST_TS}`]], ["cloud-list@1", "cloud-list@2"]);
	run("an .mjs under apps", [["apps/console/scripts/x.mjs", LIST_TS]], ["cloud-list@1"]);
	// Rule 1 — clean controls.
	run("two clouds is not a list", [[F, 'const a = ["aws", "gcp"];']], []);
	run("a repeated slug counts once", [[F, 'const a = ["aws", "aws", "gcp"];']], []);
	run("a map keyed by cloud", [[F, 'const L = { aws: "AWS", gcp: "GCP", zephyr: "Zephyr" };']], []);
	run("a Go map", [["packages/core/x.go", 'var m = map[string]int{"aws": 1, "gcp": 2, "azure": 3}']], []);
	run("literals in separate statements", [[F, 'f("aws");\nf("gcp");\nf("azure");']], []);
	run("a list in a comment", [[F, '// ["aws", "gcp", "zephyr"]\n/* "aws" | "gcp" | "azure" */']], []);
	run("case-sensitive slugs", [[F, 'const a = ["AWS", "GCP", "Azure"];']], []);
	run("a TS test file", [["apps/console/lib/x.test.ts", LIST_TS]], []);
	run("a Go test file", [["packages/core/x_test.go", LIST_GO]], []);
	run("a tests/ directory", [["apps/console/tests/x.ts", LIST_TS]], []);
	run("a Playwright e2e directory", [["apps/console/e2e/x.ts", LIST_TS]], []);
	run("a .js file is not read", [["apps/console/x.js", LIST_TS]], []);
	run("a root rule 1 does not read", [["infra/x.ts", LIST_TS]], []);
	run("this script itself", [[SELF, LIST_TS]], []);

	// Rule 2 — a planted hidden name is found on EVERY scanned surface.
	const planted2 = {
		marketing: ["apps/marketing/components/x.tsx", "<p>Runs on Zephyr Cloud.</p>"],
		"docs-content": ["apps/docs/content/docs/x.mdx", "---\ntitle: X\n---\n\nConnect zephyr."],
		"blog-content": ["apps/blog/content/x.mdx", "We added ZEPHYR."],
		readme: ["README.md", "Clouds: AWS and Zephyr."],
		"console-metadata": ["apps/console/app/x/page.tsx", 'export const metadata = { title: "Zephyr accounts" };'],
	};
	const want2 = { marketing: 1, "docs-content": 5, "blog-content": 1, readme: 1, "console-metadata": 1 };
	for (const s of RULE2_SURFACES) {
		if (!planted2[s.id]) fail(`no planted name for rule-2 surface ${s.id}`);
		else run(`planted name on ${s.id}`, [planted2[s.id]], [`hidden-name@${want2[s.id]}`]);
	}
	// Rule 2 — shapes.
	const M = "apps/marketing/components/x.tsx";
	run("an env-var spelling", [["apps/docs/content/docs/x.mdx", "| `ZEPHYR_TOKEN` | token |"]], ["hidden-name@1"]);
	run("a meta.json nav entry", [["apps/docs/content/docs/meta.json", '{ "pages": ["aws", "zephyr"] }']], ["hidden-name@1"]);
	run("two hidden clouds on one line", [[M, "<p>zephyr and nimbus</p>"]], ["hidden-name@1", "hidden-name@1"]);
	run("a console description", [["apps/console/app/x/layout.tsx", "export const metadata = {\n\tdescription:\n\t\t'Connect nimbus',\n};"]], ["hidden-name@3"]);
	// Rule 2 — clean controls.
	run("an available cloud", [[M, "<p>AWS, GCP and Azure.</p>"]], []);
	run("a word that contains the term", [[M, "<p>zephyrs blow; nimbuses form.</p>"]], []);
	run("a comment in marketing code", [[M, "// zephyr was removed in #1\nconst a = 1;"]], []);
	run("a page marked availability: hidden", [["apps/docs/content/docs/x.mdx", "---\ntitle: Zephyr\navailability: hidden\n---\n\nZephyr."]], []);
	run("console copy outside metadata", [["apps/console/app/x/page.tsx", 'const a = "zephyr";\n<p>Zephyr</p>']], []);
	run("console code that is not app/", [["apps/console/lib/x.ts", 'const m = { title: "Zephyr" };']], []);
	run("a marketing test", [["apps/marketing/tests/x.test.ts", 'expect(html).not.toContain("Zephyr");']], []);
	run("a docs file outside content/", [["apps/docs/lib/x.ts", 'const a = "zephyr";']], []);
	run("an image is not read", [["apps/marketing/public/zephyr.svg", "<svg>zephyr</svg>"]], []);

	// The real catalog's hidden cloud, so the rules are exercised on the value too — not only on it.
	let real;
	try {
		real = domainFromCatalog(JSON.parse(readFileSync(join(ROOT, CATALOG), "utf8")));
	} catch (err) {
		fail(`${CATALOG} does not yield a domain: ${err instanceof Error ? err.message : String(err)}`);
	}
	if (real) {
		const hiddenSlug = real.hidden[0]?.slug;
		const available = real.slugs.filter((s) => !real.hidden.some((h) => h.slug === s));
		if (hiddenSlug && available.length >= 2) {
			run(`real catalog: a list with ${hiddenSlug}`, [[F, `const a = ["${available[0]}", "${available[1]}", "${hiddenSlug}"];`]], ["cloud-list@1"], real);
			run(`real catalog: ${hiddenSlug} on marketing`, [[M, `<p>${hiddenSlug.toUpperCase()}</p>`]], ["hidden-name@1"], real);
			run("real catalog: an available cloud on marketing", [[M, `<p>${available.join(", ")}</p>`]], [], real);
		}
		if (real.hidden.some((h) => h.terms.some((t) => t.length < 4))) fail("a hidden term shorter than four characters survived");
	}
	// domainFromCatalog: refuses a missing or unknown availability, and derives terms.
	const dom = domainFromCatalog({
		live: { providers: { a1: { availability: "available" }, b2: { availability: "available" }, zz: { availability: "hidden", name: "Zed Zone", shortName: "ZZ" } } },
	});
	if (JSON.stringify(dom.hidden) !== JSON.stringify([{ slug: "zz", terms: ["Zed Zone"] }])) fail(`domainFromCatalog terms: ${JSON.stringify(dom.hidden)}`);
	for (const [name, cat] of [
		["no live.providers", {}],
		["a typo'd availability", { live: { providers: { a: { availability: "availble" }, b: { availability: "available" }, c: { availability: "available" } } } }],
		["a missing availability", { live: { providers: { a: {}, b: { availability: "available" }, c: { availability: "available" } } } }],
	]) {
		let threw = false;
		try {
			domainFromCatalog(cat);
		} catch {
			threw = true;
		}
		if (!threw) fail(`domainFromCatalog accepted ${name}`);
	}

	// The ledger, both directions, both rules.
	const two = `${LIST_TS}\n${LIST_TS}`;
	const ok = evaluate(new Map([[F, two]]), [{ file: F, rule: "cloud-list", lists: 2, reason: "r" }], FIXTURE);
	if (ok.violations.length || ok.stale.length) fail("a cloud-list entry with the exact count did not excuse its file");
	const more = evaluate(new Map([[F, two]]), [{ file: F, rule: "cloud-list", lists: 1, reason: "r" }], FIXTURE);
	if (more.violations.length !== 1 || more.stale.length) fail("a file with MORE lists than its entry was not a finding");
	const fewer = evaluate(new Map([[F, LIST_TS]]), [{ file: F, rule: "cloud-list", lists: 2, reason: "r" }], FIXTURE);
	if (fewer.violations.length || fewer.stale.length !== 1) fail("a file with FEWER lists than its entry was not stale");
	const gone = evaluate(new Map(), [{ file: F, rule: "cloud-list", lists: 1, reason: "r" }], FIXTURE);
	if (gone.stale.length !== 1) fail("a cloud-list entry for a missing file was not stale");
	const nm = [{ file: M, rule: "hidden-name", cloud: "zephyr", reason: "r" }];
	const excused = evaluate(new Map([[M, "<p>zephyr</p>\n<p>nimbus</p>"]]), nm, FIXTURE);
	if (excused.violations.length !== 1 || excused.violations[0].cloud !== "nimbus" || excused.stale.length)
		fail("a hidden-name entry excused another cloud, or none");
	if (evaluate(new Map([[M, "<p>AWS</p>"]]), nm, FIXTURE).stale.length !== 1) fail("a hidden-name entry that excuses nothing was not stale");
	const flipped = { slugs: FIXTURE.slugs, hidden: [{ slug: "nimbus", terms: ["nimbus"] }] };
	if (evaluate(new Map([[M, "<p>zephyr</p>"]]), nm, flipped).stale.length !== 1)
		fail("a hidden-name entry for a cloud that is no longer hidden was not stale");

	// Refusal: a root read below its floor refuses green, and the counts name every root.
	const { counts } = evaluate(new Map([planted1["apps/"], planted2.readme]), [], FIXTURE);
	if (counts["cloud-list:apps/"] !== 1 || counts["hidden-name:readme"] !== 1) fail(`per-root counts: ${JSON.stringify(counts)}`);
	const missed = underFloors(counts, { "cloud-list:apps/": 2, "hidden-name:readme": 1, "cloud-list:ee/": 1 });
	if (JSON.stringify(missed.map((m) => m.key)) !== JSON.stringify(["cloud-list:apps/", "cloud-list:ee/"]))
		fail(`underFloors: ${JSON.stringify(missed)}`);
	for (const r of RULE1_ROOTS) if (!(`cloud-list:${r}` in FLOORS)) fail(`rule-1 root ${r} has no floor`);
	for (const s of RULE2_SURFACES) if (!(`hidden-name:${s.id}` in FLOORS)) fail(`rule-2 surface ${s.id} has no floor`);

	// The parser: well-formed shapes, and every malformed one throws.
	const parsed = parseLedger(
		`# c\nentries:\n  - file: ${F}\n    rule: cloud-list\n    lists: 2\n    reason: "a decision"\n  - file: ${M}\n    rule: hidden-name\n    cloud: zephyr\n    lifts: "#12"\n`,
	);
	if (parsed.length !== 2 || parsed[0].lists !== 2 || parsed[0].reason !== "a decision" || parsed[1].cloud !== "zephyr" || parsed[1].lifts !== "#12" || parseLedger("entries: []\n").length !== 0)
		fail("parseLedger misread a well-formed ledger");
	const malformed = [
		["no entries key", "# only a comment\n"],
		["content after []", `entries: []\n  - file: ${F}\n`],
		["neither reason nor lifts", `entries:\n  - file: ${F}\n    rule: cloud-list\n    lists: 1\n`],
		["both reason and lifts", `entries:\n  - file: ${F}\n    rule: cloud-list\n    lists: 1\n    reason: r\n    lifts: "#1"\n`],
		["a lifts that is not an issue", `entries:\n  - file: ${F}\n    rule: cloud-list\n    lists: 1\n    lifts: soon\n`],
		["an unknown rule", `entries:\n  - file: ${F}\n    rule: clouds\n    reason: r\n`],
		["a cloud-list without lists", `entries:\n  - file: ${F}\n    rule: cloud-list\n    reason: r\n`],
		["a zero count", `entries:\n  - file: ${F}\n    rule: cloud-list\n    lists: 0\n    reason: r\n`],
		["a hidden-name without cloud", `entries:\n  - file: ${M}\n    rule: hidden-name\n    reason: r\n`],
		["a hidden-name with lists", `entries:\n  - file: ${M}\n    rule: hidden-name\n    cloud: zephyr\n    lists: 1\n    reason: r\n`],
		["a mis-indented field", `entries:\n  - file: ${F}\n   rule: cloud-list\n    lists: 1\n    reason: r\n`],
		["a duplicate entry", `entries:\n  - file: ${F}\n    rule: cloud-list\n    lists: 1\n    reason: r\n  - file: ${F}\n    rule: cloud-list\n    lists: 2\n    reason: s\n`],
	];
	for (const [name, text] of malformed) {
		let threw = false;
		try {
			parseLedger(text);
		} catch {
			threw = true;
		}
		if (!threw) fail(`parseLedger accepted ${name}`);
	}
	// The real ledger parses, and every entry names a file its rule reads.
	try {
		for (const e of parseLedger(readFileSync(join(ROOT, LEDGER), "utf8"))) {
			if (e.rule === "cloud-list" ? !rule1Root(e.file) : !rule2Surface(e.file))
				fail(`ledger entry ${e.file} [${e.rule}] names a file that rule does not read`);
		}
	} catch (err) {
		fail(`${LEDGER} does not parse: ${err instanceof Error ? err.message : String(err)}`);
	}

	if (failed) {
		console.error(`check-cloud-availability --self-test: ${failed} failure(s)`);
		return 1;
	}
	console.log("✓ check-cloud-availability --self-test: every case behaves");
	return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	if (process.argv.includes("--self-test")) process.exit(selfTest());
	let ledger;
	let domain;
	try {
		ledger = parseLedger(readFileSync(join(ROOT, LEDGER), "utf8"));
		domain = domainFromCatalog(JSON.parse(readFileSync(join(ROOT, CATALOG), "utf8")));
	} catch (err) {
		console.error(`✗ check-cloud-availability: ${err instanceof Error ? err.message : String(err)}`);
		process.exit(1);
	}
	const result = evaluate(new Map(trackedSources(ROOT)), ledger, domain);
	process.exit(report(result, underFloors(result.counts)));
}
