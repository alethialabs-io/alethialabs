#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
//
// CLAUDE.md §6's shared-surface table, made mechanical for the two rows where the rule is
// unambiguous and the drift was measured.
//
// WHY THIS EXISTS. That table states its own reason — "if two pages disagree about how something
// looks or reads, the user is being told the product is two products" — and no row of it was
// guarded by anything. Measured on dev at af8d63dc: `projects.estimated_monthly_cost` is ONE
// `numeric` column and the console rendered it three ways, `$12.50/mo` in twelve places,
// `~$12/mo` in three and `€12.50` in one; in-app page titles rendered at FIVE sizes, from
// `text-base` to `text-4xl`. Neither `check:dead-code` (knip) nor `check:action-boundary` can see
// either, and packages/eslint-config carries no `no-restricted-syntax`.
//
//   node scripts/check-shared-surface.mjs
//   node scripts/check-shared-surface.mjs --self-test
//
// Do NOT pipe it. `node scripts/check-shared-surface.mjs | tail` reports TAIL's exit code, which
// is always 0, and every failure below becomes invisible.
//
// ── WHAT IS GUARDED, AND WHAT IS NOT ─────────────────────────────────────────────────────────
//
// Guarded, with the exact token shape and the exact directories, because "the @repo/format row is
// enforced" is the sentence a reader turns into "nothing else can drift":
//
//   @repo/format   `.toFixed(`, `.toLocaleDateString(`, `.toLocaleTimeString(`, and a literal `$`
//                  written in front of an interpolation (`` `$${n}` ``), in
//                  apps/console/{components,app,lib,hooks} — every top-level console directory
//                  that holds code. It reaches `lib/` because that is where the FOURTH spelling of
//                  the monthly cost was hiding: `lib/promotions/gates.ts` built a user-visible
//                  `Cost +$12.50/mo` by hand while three components had already been converted.
//
//   @repo/format   DIVISION by 1024, in apps/console/{components,app} ONLY. `lib/` is excluded
//                  from this one matcher on purpose and with evidence: six sites under
//                  `lib/cloud-providers/capabilities/**` divide a provider's MB by 1024 to
//                  normalise it into GB for the capabilities catalog. That is arithmetic on a
//                  datum, not a rendering, and `formatBytes` returns a STRING — it cannot be the
//                  answer there. Widening the matcher would have bought six allowlist entries
//                  that are not decisions.
//
//   @repo/ui/page-header   a raw `<h1>`, in apps/console/app/(private)/** and components/**.
//                  `<h1>` and nothing else: a hand-rolled `<h2 className="text-lg font-semibold">`
//                  section heading is NOT caught, even though `PageHeader` takes `level={2}` for
//                  exactly that. A class-name match cannot tell a section heading from a bold
//                  label, and this guard does not pretend otherwise.
//
// NOT guarded, and the omission is stated here rather than left for a reader to infer that the
// whole table is enforced:
//
//   DataTable        — 45 `className="grid grid-cols…"` sites, most of them honest layouts. The
//                      a11y defect §6 describes ("it reads to a screen reader as a stack of
//                      buttons") needs a SHAPE test — a header row, repeated row children — not a
//                      class-name match. A guard that cannot separate a layout from a table is
//                      noise, and noise is how a guard gets disabled.
//   EmptyState       — 15 files, and StatusBadge 33, the best-adopted row. Neither has a negative
//                      form to match: "a page that should have shown an empty state and showed
//                      nothing" is not a grep.
//   the filter standard's server half — `apps/console/lib/queries/facets.ts` and the `query*Page`
//                      builders. "A facet pass sees only the scope predicates" is a real check and
//                      a real unit test; it is not a text match.
//   `--z-*`          — 2 bare hits. De-facto clean; not worth a gate today.
//   `date-fns` direct — 11 console files still import `formatDistanceToNow` rather than
//                      `formatRelative`. A bare import name is a weak signal (the package has
//                      honest non-formatting uses), so this row is prose, not a matcher.
//   `.toLocaleString(…)` — the fifth spelling of money, and the one this guard deliberately does
//                      NOT match. The same call with no options is the correct way to put
//                      separators in a COUNT and appears ~20 times; the two money sites that
//                      survive it (`billing/billing-checkout-form.tsx`, and the credit counts in
//                      `billing/credit-pack-dialog.tsx`) pass NO options at all, so there is no
//                      shape that separates them from a count. The `$${` matcher above catches
//                      the ones that write their own currency symbol, which was all of them but
//                      those two.
//
// ── HOW IT MATCHES ───────────────────────────────────────────────────────────────────────────
//
// Node ships no TypeScript parser and this repo's worktrees are de-hydrated (no node_modules), so
// a real parse is not available — the same constraint scripts/ts-coverage.mjs states for itself.
// What it does instead is match TOKEN SHAPES on comment-stripped source: a leading `.` and a
// trailing `(` for a member call, a following `[\s/>]` for a JSX tag, a leading `/` for a DIVISION
// (so `10 * 1024 * 1024` defining a size limit is not a byte rendering and is not flagged).
//
// Matching runs over a TWO-LINE WINDOW, and a match counts only when it STARTS on the first of the
// pair, so every match is found exactly once and attributed to the line it opens on. A line at a
// time was not enough: Prettier and Biome break a binary expression after the operator, so
// `bytes /\n\t1024` is one edit away from any flagged division and a per-line matcher reads it as
// clean — the direction that reports green. The same window is what lets `<h1` be found when the
// className sits on the next line.
//
// The comment stripper is deliberately line-oriented: whole-line `//`, and block comments that
// OPEN a line (`/*`, `/**`) plus JSX comments (`{/*`) anywhere quotes are balanced ahead of them.
// It does not try to find a trailing `//`, because telling one from `"https://…"` inside a JSX
// string needs the parser we do not have — and getting THAT wrong blanks live code, which makes
// the guard report green on what it never read. A trailing comment that happens to contain
// `.toFixed(` is a false positive instead: loud, and fixable. That asymmetry is the whole reason
// for the choice, and it is why an unterminated block comment REFUSES the file rather than
// blanking the rest of it.
//
// The same asymmetry has a second consequence worth stating, because it is a real cost and not a
// bug to be fixed later: a matcher fires inside an ordinary string literal too. A console file
// holding `const HTML = "<h1>Hi</h1>"` reds this check. That is the loud direction, and the remedy
// is to move the sample out of the console tree — not an allowlist entry, which this file reserves
// for decisions about real surfaces.
//
// HOW IT KNOWS IT LOOKED. Three controls, because each catches something the others cannot, and
// this guard was reviewed for reporting a clean tree over files it never opened:
//   - a per-ROOT and per-EXTENSION floor of one file, per scope. Catches a root that moved, an
//     extension list that was edited, a walker that broke.
//   - a per-scope CENSUS FLOOR checked into apps/console/shared-surface-allowlist.yaml. This is
//     the only one that sees a root DELETED from the scope declaration above, because the per-root
//     check is BUILT from that declaration: with `apps/console/app` removed, every remaining root
//     was healthy and the run printed `✓` over 299 unread route files.
//   - a directory the walker cannot read RAISES rather than counting as empty, and an unterminated
//     block comment refuses its file rather than being scanned blank.
//
// The guard cannot match itself: its scopes are all under `apps/console/**` and it lives in
// `scripts/`, and its fixtures are strings held in this file, never files on disk. The self-test
// asserts both.

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const ROOT = path.resolve(import.meta.dirname, "..");
const ALLOWLIST = "apps/console/shared-surface-allowlist.yaml";

/**
 * A separator that cannot occur in a rule id or a repo path. Written as an ESCAPE, never as a
 * literal byte: three raw NULs in this file's source made `rg` and `grep -r` classify it as
 * binary and refuse to print any line of it, for a guard whose entire value is that the next
 * reader can find and read its stated scope.
 */
const SEP = "\u0000";

/**
 * Where a matcher is allowed to look. Named, because two matchers in the SAME rule need different
 * answers — see the byte-division note in the header — and because the vacuity check below reports
 * per root and per extension, which needs the pair to still be visible at check time.
 */
const SCOPES = {
	// Every top-level console directory that holds code. `lib/` and `hooks/` are in it because a
	// user-visible string does not stop being one for living outside a component.
	console_code: {
		roots: ["apps/console/components", "apps/console/app", "apps/console/lib", "apps/console/hooks"],
		exts: [".ts", ".tsx"],
	},
	// The rendering layer only. See the header for why the byte matcher stops here.
	console_view: {
		roots: ["apps/console/components", "apps/console/app"],
		exts: [".ts", ".tsx"],
	},
	// In-app pages. `app/(public)/**` is out on purpose: those routes are the signed-out,
	// marketing-shaped surfaces the allowlist's display-heading reason already covers, and they
	// are not "in-app page titles" at all.
	console_pages: {
		roots: ["apps/console/app/(private)", "apps/console/components"],
		exts: [".tsx"],
	},
};

/**
 * The guarded rows. `id` is also the allowlist's section name, so a section this file does not
 * know about is a parse error rather than a silently ignored block of exceptions.
 */
const RULES = [
	{
		id: "format",
		surface: "@repo/format",
		matchers: [
			{
				scope: "console_code",
				re: /\.\s*toFixed\s*\(/g,
				say: "hand-rolls decimals with `toFixed`. Use `formatMonthlyRate` for a monthly cost, `formatMoney` for a billed amount (it takes CENTS), or `formatMinutes`/`formatBytes`/`formatDuration`.",
				probe: "const s = `$${cost.toFixed(2)}/mo`;",
				antiProbe: "const toFixed = 1;",
			},
			{
				scope: "console_code",
				re: /\.\s*toLocaleDateString\s*\(/g,
				say: "builds its own date. Use `formatDate` — it fixes the locale and documents the server/client timezone hydration trap this call site is exposed to.",
				probe: "const d = new Date(v).toLocaleDateString();",
				antiProbe: "const d = v.toLocaleString();",
			},
			{
				scope: "console_code",
				re: /\.\s*toLocaleTimeString\s*\(/g,
				say: "builds its own time. Use `formatRelative` for a feed, or `formatDate(value, \"time\")` for a log gutter.",
				probe: "const t = new Date(v).toLocaleTimeString();",
				antiProbe: "const t = v.toLocaleString();",
			},
			{
				// A literal `$` in front of an interpolation. Measured before adding it: seven hits
				// in the whole console and all seven were money, including the two file-local
				// `currency()` helpers that rendered `estimated_monthly_cost` a second way and the
				// promotion-gate detail string that rendered it a third. It is the shape that
				// separates a hand-written currency symbol from a formatted quantity, which
				// `toLocaleString` alone cannot do.
				scope: "console_code",
				re: /\$\$\{/g,
				say: "writes its own currency symbol in front of a number. Use `formatMonthlyRate` for a recurring cost or `formatMoney` for a billed amount — they own the symbol, the separators and the decimals, so two screens cannot disagree about them.",
				probe: "const s = `$${n}`;",
				antiProbe: "const s = `${n}`;",
			},
			{
				// A DIVISION by 1024 is a byte rendering. A multiplication is a size limit
				// (`10 * 1024 * 1024`) and is not one, which is why the leading `/` is required.
				scope: "console_view",
				re: /\/\s*\(?\s*1024\b/g,
				say: "divides bytes by 1024 by hand. Use `formatBytes`, which steps the units and keeps one decimal only above kilobytes.",
				probe: "const mb = bytes / (1024 * 1024);",
				antiProbe: "const MAX = 10 * 1024 * 1024;",
			},
		],
	},
	{
		id: "page_header",
		surface: "@repo/ui/page-header",
		matchers: [
			{
				// `|$` for the last line of a file, where the two-line window has no next line to
				// supply the `\s` that error-state.tsx's `<h1`-then-className shape matches on.
				scope: "console_pages",
				re: /<h1(?=[\s/>]|$)/g,
				say: "hand-writes a page title. Use `PageHeader` from `@repo/ui/page-header`, with `level` when it heads a section rather than the page.",
				probe: 'const a = <h1 className="text-2xl">Clusters</h1>;',
				antiProbe: "const a = <h10>x</h10>;",
			},
		],
	},
];

// ── source scanning ───────────────────────────────────────────────────────────────────────────

/**
 * True when every quote character is closed before `index` on this line, i.e. `index` is NOT
 * inside a string literal that opened on this line.
 *
 * This is the cheapest honest answer available without a parser, and it exists for one shape:
 * `const g = "a{/*}b"` used to latch the block-comment state from inside a string and blank every
 * line after it. It is deliberately conservative in the LOUD direction — an apostrophe in JSX text
 * (`<p>Don't</p>{/* note *\/}`) leaves the counts odd, so the comment after it is scanned as code
 * and can only produce a false positive, never a skipped line.
 *
 * @param {string} line
 * @param {number} index
 * @returns {boolean}
 */
function quotesClosedBefore(line, index) {
	let dq = 0;
	let sq = 0;
	let bt = 0;
	for (let i = 0; i < index; i++) {
		const c = line[i];
		if (c === "\\") {
			i++;
			continue;
		}
		if (c === '"') dq++;
		else if (c === "'") sq++;
		else if (c === "`") bt++;
	}
	return dq % 2 === 0 && sq % 2 === 0 && bt % 2 === 0;
}

/**
 * Blank every comment, line by line, keeping one output line per input line so a finding's line
 * number is still true. See the header for why trailing comments are left alone.
 *
 * @param {string} source
 * @returns {{lines: string[], unterminated: boolean}} `unterminated` when a block comment was still
 *   open at EOF — the one state in which this function has blanked live code, so the caller must
 *   refuse the file rather than report it clean.
 */
export function stripComments(source) {
	/** @type {string[]} */
	const out = [];
	let inBlock = false;
	for (const line of source.split("\n")) {
		if (inBlock) {
			const end = line.indexOf("*/");
			if (end === -1) {
				out.push("");
				continue;
			}
			inBlock = false;
			out.push(line.slice(end + 2));
			continue;
		}
		const trimmed = line.trimStart();
		if (trimmed.startsWith("//")) {
			out.push("");
			continue;
		}
		// `{/*` is taken anywhere on the line PROVIDED the quotes ahead of it are closed: a brace
		// followed by a block-comment open, outside a string, is a JSX comment and can be nothing
		// else. A bare `/*` is only taken when it OPENS the line, because mid-line it is
		// indistinguishable from a glob inside a string ("apps/*\/**") and blanking from there
		// would swallow live code — the direction that reports green.
		const jsx = line.indexOf("{/*");
		const jsxOpen = jsx !== -1 && quotesClosedBefore(line, jsx) ? jsx + 1 : -1;
		const open = jsxOpen !== -1 ? jsxOpen : trimmed.startsWith("/*") ? line.indexOf("/*") : -1;
		if (open === -1) {
			out.push(line);
			continue;
		}
		const end = line.indexOf("*/", open + 2);
		if (end === -1) {
			inBlock = true;
			out.push(line.slice(0, open));
			continue;
		}
		out.push(line.slice(0, open) + line.slice(end + 2));
	}
	return { lines: out, unterminated: inBlock };
}

/**
 * Every guarded file in a scope, repo-relative and posix-separated, plus the per-(root, extension)
 * census the vacuity check reads.
 *
 * @param {{roots: string[], exts: string[]}} scope
 * @param {(dir: string) => string[]} listDir directory lister, injected for the self-test
 * @returns {{files: string[], census: Map<string, number>}} census keys are `root SEP ext`
 */
export function filesFor(scope, listDir) {
	/** @type {string[]} */
	const found = [];
	/** @type {Map<string, number>} */
	const census = new Map();
	for (const root of scope.roots) for (const ext of scope.exts) census.set(`${root}${SEP}${ext}`, 0);

	/** @param {string} dir @param {string} root */
	const walk = (dir, root) => {
		for (const entry of listDir(dir)) {
			if (entry === "node_modules" || entry === ".next" || entry === "dist") continue;
			const child = `${dir}/${entry}`;
			const kids = listDir(child);
			if (kids.length > 0) {
				walk(child, root);
				continue;
			}
			const ext = scope.exts.find((e) => child.endsWith(e));
			if (ext === undefined) continue;
			found.push(child);
			const key = `${root}${SEP}${ext}`;
			census.set(key, (census.get(key) ?? 0) + 1);
		}
	};
	for (const root of scope.roots) walk(root, root);
	// A directory can appear under two roots (components/** is a root of several scopes, and
	// app/(private) sits under app/); one file must not be reported twice. The census counts
	// before the de-duplication on purpose — it is measuring whether each ROOT still resolves.
	return { files: [...new Set(found)].sort(), census };
}

/**
 * @typedef {{rule: string, file: string, line: number, say: string, text: string}} Finding
 */

/**
 * Every rule match in the tree, allowlisted or not.
 *
 * @param {(p: string) => string} readFile
 * @param {(dir: string) => string[]} listDir
 * @returns {{findings: Finding[], census: Map<string, number>, perRule: Map<string, number>, unterminated: Set<string>}}
 *   census keys are `scopeId SEP root SEP ext`; only scopes a matcher actually uses appear.
 */
export function scan(readFile, listDir) {
	/** @type {Finding[]} */
	const findings = [];
	/** @type {Map<string, {files: string[], census: Map<string, number>}>} */
	const scopeCache = new Map();
	/** @type {Map<string, string[]>} */
	const strippedCache = new Map();
	/** @type {Map<string, number>} */
	const census = new Map();
	/** @type {Map<string, number>} */
	const perRule = new Map();
	/** @type {Set<string>} */
	const unterminated = new Set();

	/** @param {string} id */
	const scopeFiles = (id) => {
		let hit = scopeCache.get(id);
		if (hit === undefined) {
			hit = filesFor(SCOPES[id], listDir);
			scopeCache.set(id, hit);
			for (const [pair, n] of hit.census) census.set(`${id}${SEP}${pair}`, n);
		}
		return hit.files;
	};

	for (const rule of RULES) {
		/** @type {Set<string>} */
		const seen = new Set();
		for (const matcher of rule.matchers) {
			for (const file of scopeFiles(matcher.scope)) {
				seen.add(file);
				let lines = strippedCache.get(file);
				if (lines === undefined) {
					const stripped = stripComments(readFile(file));
					// NOT a Finding: an allowlist entry for this file would swallow it, and this is
					// a statement about what the check READ, which no exception can grant.
					if (stripped.unterminated) unterminated.add(file);
					lines = stripped.lines;
					strippedCache.set(file, lines);
				}
				for (let i = 0; i < lines.length; i++) {
					const head = lines[i];
					// The two-line window. A match counts only when it STARTS in `head`, so one
					// wholly inside the next line is attributed to that line on the next turn
					// instead of being reported twice.
					const window = i + 1 < lines.length ? `${head}\n${lines[i + 1]}` : head;
					matcher.re.lastIndex = 0;
					let m;
					while ((m = matcher.re.exec(window)) !== null) {
						if (m.index < head.length) {
							findings.push({ rule: rule.id, file, line: i + 1, say: matcher.say, text: m[0] });
						}
						// A zero-width lookahead match (`<h1`) would loop forever without this.
						if (m.index === matcher.re.lastIndex) matcher.re.lastIndex++;
					}
				}
			}
		}
		perRule.set(rule.id, seen.size);
	}
	return { findings, census, perRule, unterminated };
}

// ── the allowlist ─────────────────────────────────────────────────────────────────────────────

/**
 * @typedef {{section: string, path: string, hits: number, reason: string, line: number}} Entry
 * @typedef {{scope: string, floor: number, line: number}} Floor
 */

/**
 * A deliberately small reader for the allowlist. There is no js-yaml here — a worktree is
 * de-hydrated and this must run with plain `node` — so the grammar is fixed and narrow, and
 * ANYTHING it does not recognise is an error naming the line. A permissive reader that skipped
 * what it could not parse would turn a typo into a silently dropped exception, which is the one
 * failure mode an allowlist must not have.
 *
 * @param {string} text
 * @returns {{baseline: number, entries: Entry[], floors: Floor[]}}
 */
export function parseAllowlist(text) {
	const known = new Set(RULES.map((r) => r.id));
	/** @type {Entry[]} */
	const entries = [];
	/** @type {Floor[]} */
	const floors = [];
	/** @type {Floor | null} */
	let floor = null;
	/** Section+path already claimed, so two entries cannot both count against `baseline`. */
	const claimed = new Map();
	let baseline = null;
	let section = null;
	/** @type {Entry | null} */
	let current = null;
	/** @param {number} n @param {string} why */
	const bad = (n, why) => {
		throw new Error(`${ALLOWLIST}:${n}: ${why}`);
	};
	/** @param {number} n */
	const closeFloor = (n) => {
		if (floor === null) return;
		if (floor.floor === -1) bad(n, `the \`scanned\` entry for \`${floor.scope}\` has no \`floor:\``);
		floors.push(floor);
		floor = null;
	};
	/** @param {number} n */
	const closeEntry = (n) => {
		closeFloor(n);
		if (current === null) return;
		if (current.hits === -1) bad(n, `entry for \`${current.path}\` has no \`hits:\``);
		if (current.reason === "") bad(n, `entry for \`${current.path}\` has no \`reason:\` — an entry is a DECISION`);
		const key = `${current.section}${SEP}${current.path}`;
		const first = claimed.get(key);
		if (first !== undefined) {
			// Both would match the same findings, so the second is a free entry against `baseline`
			// and only one of the two reasons is the recorded decision.
			bad(current.line, `a second \`${current.section}\` entry for ${current.path} — the first is on line ${first}. One entry per file per section.`);
		}
		claimed.set(key, current.line);
		entries.push(current);
		current = null;
	};

	const lines = text.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const raw = lines[i];
		const n = i + 1;
		if (raw.trim() === "" || raw.trimStart().startsWith("#")) continue;

		let m = raw.match(/^baseline: (\d+)$/);
		if (m !== null) {
			closeEntry(n);
			if (baseline !== null) bad(n, "`baseline:` appears twice");
			baseline = Number(m[1]);
			continue;
		}
		m = raw.match(/^([a-z_]+):$/);
		if (m !== null) {
			closeEntry(n);
			if (m[1] === "scanned") {
				section = "scanned";
				continue;
			}
			if (!known.has(m[1])) bad(n, `unknown section \`${m[1]}\` — the sections are scanned, ${[...known].join(", ")}`);
			section = m[1];
			continue;
		}
		m = raw.match(/^ {2}- scope: (\S+)$/);
		if (m !== null) {
			closeEntry(n);
			if (section !== "scanned") bad(n, "`- scope:` belongs to the `scanned:` section");
			floor = { scope: m[1], floor: -1, line: n };
			continue;
		}
		m = raw.match(/^ {4}floor: (\d+)$/);
		if (m !== null) {
			if (floor === null) bad(n, "`floor:` outside a `- scope:` entry");
			floor.floor = Number(m[1]);
			continue;
		}
		m = raw.match(/^ {2}- path: (\S+)$/);
		if (m !== null) {
			closeEntry(n);
			if (section === null) bad(n, "an entry before any section header");
			current = { section, path: m[1], hits: -1, reason: "", line: n };
			continue;
		}
		m = raw.match(/^ {4}hits: (\d+)$/);
		if (m !== null) {
			if (current === null) bad(n, "`hits:` outside an entry");
			current.hits = Number(m[1]);
			continue;
		}
		m = raw.match(/^ {4}reason: (.+)$/);
		if (m !== null) {
			if (current === null) bad(n, "`reason:` outside an entry");
			current.reason = m[1].trim();
			continue;
		}
		bad(n, `cannot parse \`${raw.trim().slice(0, 60)}\``);
	}
	closeEntry(lines.length);

	if (baseline === null) throw new Error(`${ALLOWLIST}: no \`baseline:\` — the list has no ratchet, so it is not shrink-only`);
	return { baseline, entries, floors };
}

// ── the check ─────────────────────────────────────────────────────────────────────────────────

/**
 * @param {(p: string) => string} readFile
 * @param {(dir: string) => string[]} listDir
 * @returns {{problems: string[], census: Map<string, number>, perRule: Map<string, number>, allowed: number, entries: number}}
 */
export function check(readFile, listDir) {
	/** @type {string[]} */
	const problems = [];
	/** @type {Map<string, number>} */
	const empty = new Map();

	/** @type {{baseline: number, entries: Entry[], floors: Floor[]}} */
	let list;
	try {
		list = parseAllowlist(readFile(ALLOWLIST));
	} catch (err) {
		return { problems: [String(err instanceof Error ? err.message : err)], census: empty, perRule: empty, allowed: 0, entries: 0 };
	}

	// Structure before scanning: a matcher naming a scope that is not in SCOPES would otherwise
	// die inside `filesFor` and surface as an unreadable-tree error, pointing the reader at the
	// filesystem instead of at the typo three lines above.
	for (const rule of RULES) {
		if (rule.matchers.length === 0) problems.push(`the \`${rule.id}\` rule has no matchers, so it can never find anything.`);
		for (const matcher of rule.matchers) {
			if (!(matcher.scope in SCOPES)) {
				problems.push(
					`the \`${rule.id}\` rule has a matcher scoped to \`${matcher.scope}\`, which is not one of ` +
						`${Object.keys(SCOPES).join(", ")}. It would look at nothing.`,
				);
			}
		}
	}
	if (problems.length > 0) return { problems, census: empty, perRule: empty, allowed: 0, entries: list.entries.length };

	/** @type {{findings: Finding[], census: Map<string, number>, perRule: Map<string, number>, unterminated: Set<string>}} */
	let scanned;
	try {
		scanned = scan(readFile, listDir);
	} catch (err) {
		// A directory this check could not read is not a directory with nothing in it. Letting the
		// lister throw and reporting it here is the whole point — swallowing it dropped the
		// subtree from the scan and still printed a pass.
		return {
			problems: [`could not read the console tree: ${String(err instanceof Error ? err.message : err)}. This check has not seen every file, so it cannot report a pass.`],
			census: empty,
			perRule: empty,
			allowed: 0,
			entries: list.entries.length,
		};
	}
	const { findings, census, perRule } = scanned;

	// A file whose block comment never closed had everything after it blanked, so this check did
	// NOT read it. Same class as a dead root, and no allowlist entry can grant an exception to it.
	for (const file of scanned.unterminated) {
		problems.push(
			`${file}:1: opens a block comment that is never closed. Everything after it was blanked ` +
				"before matching, so this check has NOT read the rest of the file — close the comment " +
				"rather than trusting the green.",
		);
	}

	// VACUITY. "Found nothing" and "looked at nothing" must never share an exit code, and the unit
	// that can die is a ROOT or an EXTENSION, not a rule: with `app` dropped from the format rule's
	// roots the earlier per-rule check still saw 364 files from `components` and exited 0, having
	// read none of the 299 route files the drift table was written about. So both axes are
	// asserted, per scope.
	//
	// Not every (root, extension) PAIR can carry a floor — `apps/console/hooks` holds no `.tsx`
	// today and a floor there would be a check that fails for being true. Asserting each axis
	// separately is what a moved root or a one-character edit to `exts` actually trips.
	/** @type {Map<string, Map<string, number>>} */
	const byScope = new Map();
	for (const [key, n] of census) {
		const [scopeId, root, ext] = key.split(SEP);
		if (!byScope.has(scopeId)) byScope.set(scopeId, new Map());
		const m = byScope.get(scopeId);
		m.set(`root ${root}`, (m.get(`root ${root}`) ?? 0) + n);
		m.set(`ext ${ext}`, (m.get(`ext ${ext}`) ?? 0) + n);
	}
	for (const [scopeId, axes] of byScope) {
		for (const [axis, n] of axes) {
			if (n > 0) continue;
			problems.push(
				`the \`${scopeId}\` scope examined ZERO files for \`${axis}\`. That is not a pass — the ` +
					"root moved, the extension list was edited, or the walker broke. Fix this check rather " +
					"than trusting the green.",
			);
		}
	}

	// THE CENSUS FLOOR, and the reason it exists on top of the two axes above. Those axes are
	// built FROM the roots list, so a root DELETED from the declaration has no census row to be
	// zero — verified: reducing `console_code` to three roots left the check printing `✓` over 299
	// unread files in `apps/console/app`, which is the defect this guard was reviewed for. A
	// checked-in floor is the only control that sees an edit to the declaration itself, because
	// the declaration is the thing being edited.
	//
	// It ratchets the opposite way to `baseline`: files only grow, so this number may be RAISED
	// freely and a DROP is what review stops. The floors sit a few percent under the real count so
	// an ordinary refactor does not have to touch them; deleting that much of the console should
	// be looked at.
	/** @type {Map<string, number>} */
	const perScope = new Map();
	for (const [key, n] of census) {
		const [scopeId] = key.split(SEP);
		perScope.set(scopeId, (perScope.get(scopeId) ?? 0) + n);
	}
	const declared = new Set(list.floors.map((f) => f.scope));
	for (const scopeId of Object.keys(SCOPES)) {
		if (!declared.has(scopeId)) {
			problems.push(`${ALLOWLIST}: the \`scanned:\` section has no floor for the \`${scopeId}\` scope, so nothing would notice its roots being narrowed.`);
		}
	}
	for (const f of list.floors) {
		if (!(f.scope in SCOPES)) {
			problems.push(`${ALLOWLIST}:${f.line}: a floor for \`${f.scope}\`, which is not a scope. The scopes are ${Object.keys(SCOPES).join(", ")}.`);
			continue;
		}
		const seen = perScope.get(f.scope) ?? 0;
		if (seen < f.floor) {
			problems.push(
				`${ALLOWLIST}:${f.line}: the \`${f.scope}\` scope examined ${seen} file(s) against a floor of ` +
					`${f.floor}. Either a root was narrowed or renamed — fix the scope — or the console really ` +
					"did lose that many files, in which case lower the floor in the same commit and say why.",
			);
		}
	}
	// THE PERMANENT POSITIVE CONTROL. Every matcher is fired at a line it MUST hit and a line it
	// must NOT, on every run. The alternative — "the allowlist proves the matchers still match" —
	// is a control that expires: the day the last exception is fixed and `baseline` reaches 0, a
	// matcher that has quietly stopped matching would report a clean console instead.
	for (const rule of RULES) {
		for (const matcher of rule.matchers) {
			matcher.re.lastIndex = 0;
			if (!matcher.re.test(matcher.probe)) {
				problems.push(`the \`${rule.id}\` matcher ${matcher.re} no longer matches its own probe \`${matcher.probe}\` — it is dead, and a green run means nothing.`);
			}
			matcher.re.lastIndex = 0;
			if (matcher.re.test(matcher.antiProbe)) {
				problems.push(`the \`${rule.id}\` matcher ${matcher.re} has widened onto \`${matcher.antiProbe}\`, which is correct code — it will report drift that is not there.`);
			}
			matcher.re.lastIndex = 0;
		}
	}
	if (problems.length > 0) return { problems, census, perRule, allowed: 0, entries: list.entries.length };

	// The list is shrink-only, and `baseline` is where that is enforced. It is checked in BOTH
	// directions: growing is the drift coming back, and shrinking without lowering the number
	// leaves headroom nobody decided to grant — the same reason the coverage floors are a
	// checked-in file rather than a high-water mark computed at run time.
	if (list.entries.length > list.baseline) {
		problems.push(
			`${ALLOWLIST} has ${list.entries.length} entries against a baseline of ${list.baseline}. This list ` +
				"only shrinks. Fix the site to use the shared component instead of adding an exception.",
		);
	} else if (list.entries.length < list.baseline) {
		problems.push(
			`${ALLOWLIST} is down to ${list.entries.length} entries from a baseline of ${list.baseline} — a win. ` +
				`Lower \`baseline:\` to ${list.entries.length} in the same commit, so it cannot be spent again.`,
		);
	}

	// Every entry must still MATCH. This is the shrink-only half AND the positive control: the
	// allowlist guarantees a known number of live matches, so a matcher that quietly stops
	// matching reds here instead of reporting a clean tree.
	/** @type {Map<string, Finding[]>} */
	const byKey = new Map();
	for (const f of findings) {
		const key = `${f.rule}${SEP}${f.file}`;
		if (!byKey.has(key)) byKey.set(key, []);
		byKey.get(key).push(f);
	}
	let allowed = 0;
	/** @type {Set<string>} */
	const claimed = new Set();
	for (const entry of list.entries) {
		const key = `${entry.section}${SEP}${entry.path}`;
		claimed.add(key);
		const hits = byKey.get(key) ?? [];
		if (hits.length === entry.hits) {
			allowed += hits.length;
			continue;
		}
		// The recorded decision is printed with the failure, which is the only thing that makes
		// the allowlist's promise ("the guard prints it to anyone who trips over it") true — and
		// the reason is what tells the reader whether their new occurrence is the same case.
		const recorded = `\n  The recorded decision for this file: ${entry.reason}`;
		if (hits.length === 0) {
			problems.push(
				`${ALLOWLIST}:${entry.line}: the \`${entry.section}\` entry for ${entry.path} matches nothing. ` +
					"Either the file was fixed or renamed — delete the entry and lower `baseline` — or this " +
					"rule has stopped matching, which is worse." +
					recorded,
			);
			continue;
		}
		problems.push(
			`${ALLOWLIST}:${entry.line}: the \`${entry.section}\` entry for ${entry.path} declares ${entry.hits} ` +
				`hit(s) and there are ${hits.length} (line${hits.length > 1 ? "s" : ""} ` +
				`${hits.map((h) => h.line).join(", ")}). An exception is granted per occurrence, not per file: ` +
				"a new one is new drift, and a removed one is a win to record by lowering `hits`." +
				recorded,
		);
		allowed += Math.min(hits.length, entry.hits);
	}

	for (const f of findings) {
		if (claimed.has(`${f.rule}${SEP}${f.file}`)) continue;
		const rule = RULES.find((r) => r.id === f.rule);
		problems.push(
			`${f.file}:${f.line}: \`${f.text.trim()}\` — this ${f.say}\n` +
				`  CLAUDE.md §6 requires ${rule.surface} here. If this site is genuinely different, add it to ` +
				`${ALLOWLIST} with a one-line reason in the product's voice — never to make the guard pass.`,
		);
	}

	return { problems, census, perRule, allowed, entries: list.entries.length };
}

// ── self-test ─────────────────────────────────────────────────────────────────────────────────

/**
 * A fake tree. Directories are keys ending in `/`; files map to their contents. `listDir` returns
 * [] for a file, which is how `filesFor` tells the two apart.
 *
 * @param {Record<string, string>} files
 * @returns {{readFile: (p: string) => string, listDir: (d: string) => string[]}}
 */
function fakeTree(files) {
	/** @param {string} dir */
	const listDir = (dir) => {
		/** @type {Set<string>} */
		const kids = new Set();
		for (const p of Object.keys(files)) {
			if (!p.startsWith(`${dir}/`)) continue;
			kids.add(p.slice(dir.length + 1).split("/")[0]);
		}
		return [...kids];
	};
	return { readFile: (p) => files[p] ?? "", listDir };
}

/**
 * The minimum well-formed allowlist, so a fixture can opt out of the vacuity failure. The floors
 * are GENERATED from `SCOPES` rather than typed: a hand-written list here would have to be edited
 * every time a scope is added, and the edit everyone forgets is the one that makes a fixture pass
 * for the wrong reason.
 */
const EMPTY_LIST = `baseline: 0\n\nscanned:\n${Object.keys(SCOPES)
	.map((id) => `  - scope: ${id}\n    floor: 0\n`)
	.join("")}`;

/** `EMPTY_LIST` with one scope's floor raised, for the fixtures that must trip it. */
function listWithFloor(scopeId, floor) {
	return `baseline: 0\n\nscanned:\n${Object.keys(SCOPES)
		.map((id) => `  - scope: ${id}\n    floor: ${id === scopeId ? floor : 0}\n`)
		.join("")}`;
}

/**
 * One file per (root, extension) pair every scope declares, so a fixture is testing the CLASSIFIER
 * and never accidentally tripping the vacuity check. Each is inert — no matcher can fire on it.
 *
 * @returns {Record<string, string>}
 */
function ballast() {
	/** @type {Record<string, string>} */
	const files = {};
	let i = 0;
	for (const scope of Object.values(SCOPES)) {
		for (const root of scope.roots) {
			for (const ext of scope.exts) {
				files[`${root}/ballast${i++}${ext}`] = "export const inert = 1;";
			}
		}
	}
	return files;
}

function selfTest() {
	let fails = 0;
	/** @param {string} name @param {boolean} cond @param {string} detail */
	const ok = (name, cond, detail = "") => {
		if (cond) console.log(`ok   - ${name}`);
		else {
			console.error(`FAIL - ${name} ${detail}`);
			fails++;
		}
	};
	/** Run `check` over a fake tree, with the allowlist supplied as one more file. */
	const run = (files, allowlist = EMPTY_LIST) => {
		const { readFile, listDir } = fakeTree({ ...files, [ALLOWLIST]: allowlist });
		return check(readFile, listDir);
	};
	/** @param {{problems: string[]}} r @param {RegExp} re */
	const says = (r, re) => r.problems.some((p) => re.test(p));

	// ── the classifier, proved by varying the CONTENT at ONE path ────────────────────────────
	// Same file name every time, so a green can never come from the path having escaped a scope,
	// and the ballast keeps every root and extension non-empty so vacuity never masquerades as a
	// classifier result.
	const AT = "apps/console/components/x/probe.tsx";
	const flags = (body, allowlist = EMPTY_LIST) => run({ ...ballast(), [AT]: body }, allowlist).problems.length > 0;

	ok("a live toFixed is flagged", flags("const s = `$${x.toFixed(2)}/mo`;"));
	ok("...and the SAME token in a line comment is not", !flags("// x.toFixed(2) — was the drift"));
	ok("...nor in a JSDoc block", !flags("/**\n * Renders `x.toFixed(2)` today.\n */\nexport const a = 1;"));
	ok("...nor in a JSX comment", !flags("const a = <p>{/* x.toFixed(2) */}ok</p>;"));
	ok("a block comment CLOSING mid-line does not blank the code after it", flags("/* note */ const s = x.toFixed(1);"));
	ok("a bare identifier called toFixed is not a member call", !flags("const toFixed = 1;"));

	ok("toLocaleDateString is flagged", flags("const d = new Date(v).toLocaleDateString();"));
	ok("toLocaleTimeString is flagged", flags("const t = new Date(v).toLocaleTimeString();"));
	// The one that separates the rows: a bare toLocaleString on a COUNT is correct and common.
	ok("a bare toLocaleString is NOT flagged (it is how a count gets separators)", !flags("const n = c.toLocaleString();"));

	// The fourth money spelling: a hand-written currency symbol in front of an interpolation.
	ok("a hand-written `$` before an interpolation is flagged", flags("const s = `$${n.toLocaleString()}`;"));
	ok("...and an interpolation with no symbol is not", !flags("const s = `${n} credits`;"));
	ok("...nor a dollar in prose", !flags("const s = `costs $12 a month`;"));

	// The byte rule's whole point is the OPERATOR, not the number.
	ok("dividing by 1024 is flagged", flags("const mb = bytes / 1024;"));
	ok("...including the parenthesised MiB form", flags("const mb = bytes / (1024 * 1024);"));
	// THE WRAPPED FORM. Prettier and Biome break a binary expression AFTER the operator, so this
	// is one `pnpm format` away from the line above; a per-line matcher read it as clean.
	ok("...and the form a formatter wraps onto the next line", flags("export const mb =\n\tbytes /\n\t1024;"));
	ok("MULTIPLYING by 1024 to declare a limit is not", !flags("const MAX = 10 * 1024 * 1024;"));
	ok("a plain 1024 is not", !flags("const opts = { max: 1024 };"));

	ok("a raw h1 is flagged", flags('const a = <h1 className="text-2xl">Clusters</h1>;'));
	ok("a self-closing h1 is flagged", flags("const a = <h1 />;"));
	ok("...and one whose attributes are on the NEXT line, which matching-per-line nearly missed", flags("const a = (\n\t<h1\n\t\tclassName={cn(x)}\n\t>t</h1>\n);"));
	ok("...including one that ends the file, where the window has no next line", flags("const a = <h1"));
	ok("...but h10 is a different tag", !flags("const a = <h10>x</h10>;"));
	ok("...and a component whose name merely contains h1 is not", !flags("const a = <Ch1ldTitle>x</Ch1ldTitle>;"));
	ok("PageHeader is the fix, so it is not itself a finding", !flags('const a = <PageHeader title="Clusters" />;'));

	// One occurrence is reported once, not once per window it appears in.
	const twice = run({ ...ballast(), [AT]: "const a = 1;\nconst s = x.toFixed(2);\nconst b = 2;" });
	ok("a match on a middle line is reported exactly once", twice.problems.length === 1, JSON.stringify(twice.problems));

	// ── the comment stripper's two report-green shapes ───────────────────────────────────────
	// Both used to blank live code and print a pass.
	// The trailing line closes the latch, so this fixture cannot be rescued by the
	// unterminated-block refusal below — without the quote test the drift on line 2 is swallowed
	// and the run prints a pass, which is the shape that reports green on unread code.
	ok(
		"a `{/*` INSIDE a string does not latch the block state over the code after it",
		flags('export const g = "a{/*}b";\nexport const s = n.toFixed(2);\nexport const h = "c*/d";'),
	);
	const unterminated = run({ ...ballast(), [AT]: "/* oops\nexport const s = n.toFixed(2);" });
	ok(
		"an unterminated block comment REFUSES the file rather than blanking the rest of it",
		says(unterminated, /never closed/),
		JSON.stringify(unterminated.problems),
	);

	// ── scope, proved the same way: identical content, different path ────────────────────────
	const H1 = 'const a = <h1 className="x">t</h1>;';
	const at = (p) => ({ ...ballast(), [p]: H1 });
	ok("an h1 under app/(private) is in scope", run(at("apps/console/app/(private)/p/page.tsx")).problems.length > 0);
	const pub = run(at("apps/console/app/(public)/p/page.tsx"));
	ok("...and the identical file under app/(public) is not", pub.problems.length === 0, JSON.stringify(pub.problems));
	// The scope split INSIDE one rule: money reaches lib/, the byte division does not.
	const money = run({ ...ballast(), "apps/console/lib/x/a.ts": "const s = `$${n}`;" });
	ok("a hand-written money symbol under lib/ is in scope", money.problems.length > 0, JSON.stringify(money.problems));
	const bytes = run({ ...ballast(), "apps/console/lib/x/a.ts": "const gb = mb / 1024;" });
	ok("...but a byte division under lib/ is NOT — that scope is the rendering layer", bytes.problems.length === 0, JSON.stringify(bytes.problems));
	const bytesView = run({ ...ballast(), "apps/console/components/x/a.tsx": "const gb = mb / 1024;" });
	ok("...and the identical division under components/ IS", bytesView.problems.length > 0);

	// ── vacuity: every way this guard can read nothing and look clean ────────────────────────
	const nothing = run({});
	ok("an empty tree FAILS rather than passing", says(nothing, /examined ZERO files/), JSON.stringify(nothing.problems));
	// THE ONE A PER-RULE COUNT MISSED. Every root but one still resolves, so the rule's total is
	// healthy and the old check exited 0 having never opened `apps/console/app`.
	const oneRootGone = { ...ballast() };
	for (const k of Object.keys(oneRootGone)) if (k.startsWith("apps/console/app/")) delete oneRootGone[k];
	const rootGone = run(oneRootGone);
	ok(
		"a single dead ROOT fails even when the rule's other roots are full",
		says(rootGone, /root apps\/console\/app/),
		JSON.stringify(rootGone.problems),
	);
	// The same for an extension: drop every .ts and the .tsx files keep the totals healthy.
	const noTs = { ...ballast() };
	for (const k of Object.keys(noTs)) if (k.endsWith(".ts")) delete noTs[k];
	const tsGone = run(noTs);
	ok("...and a dead EXTENSION does too", says(tsGone, /ext \.ts\b/), JSON.stringify(tsGone.problems));
	// An unreadable directory is not an empty one.
	const unreadable = (() => {
		const { readFile, listDir } = fakeTree({ ...ballast(), [ALLOWLIST]: EMPTY_LIST });
		return check(readFile, (d) => {
			if (d === "apps/console/components") throw new Error("EACCES: permission denied");
			return listDir(d);
		});
	})();
	ok("a directory the walker cannot read FAILS", says(unreadable, /could not read the console tree/), JSON.stringify(unreadable.problems));
	// A matcher pointed at a scope that does not exist looks at nothing. Mutating the live rule
	// is the only way to reach it, and it must NOT surface as an unreadable-tree error.
	const strayScope = (() => {
		const m = RULES[0].matchers[0];
		const real = m.scope;
		m.scope = "console_cod"; // one character short of the real name
		const r = run(ballast());
		m.scope = real;
		return r;
	})();
	ok("a matcher scoped to a name that does not exist FAILS, and says so", says(strayScope, /scoped to `console_cod`/), JSON.stringify(strayScope.problems));

	// THE ONE THE PER-ROOT AXIS CANNOT SEE. The axes are built from the roots list, so deleting a
	// root leaves no row to be zero; only a checked-in census floor notices the declaration itself
	// changing. Mutating SCOPES is the only way to reach it.
	const rootDeleted = (() => {
		const scope = SCOPES.console_code;
		const real = scope.roots;
		// ONE tree, measured before the mutation: a floor guessed from the roots list would be
		// satisfied by the ballast the other scopes leave under the surviving roots, and the
		// fixture would pass without proving anything.
		const tree = ballast();
		let census = 0;
		for (const [key, n] of run(tree, EMPTY_LIST).census) if (key.split(SEP)[0] === "console_code") census += n;
		const list = listWithFloor("console_code", census);
		const atFloor = run(tree, list);
		scope.roots = real.slice(1);
		const narrowed = run(tree, list);
		scope.roots = real;
		return { atFloor, narrowed };
	})();
	ok("a scope exactly at its census floor passes", rootDeleted.atFloor.problems.length === 0, JSON.stringify(rootDeleted.atFloor.problems));
	ok(
		"...and a root DELETED from the scope declaration fails, which no per-root count can see",
		says(rootDeleted.narrowed, /against a floor of/),
		JSON.stringify(rootDeleted.narrowed.problems),
	);
	const noFloor = run(ballast(), "baseline: 0\n");
	ok("an allowlist with no census floors fails", says(noFloor, /has no floor for the/), JSON.stringify(noFloor.problems));
	const strayFloor = run(ballast(), EMPTY_LIST + "  - scope: console_nope\n    floor: 0\n");
	ok("...and a floor for a scope that does not exist fails", says(strayFloor, /which is not a scope/), JSON.stringify(strayFloor.problems));

	const noList = run(ballast(), "");
	ok("an allowlist with no baseline fails", says(noList, /no `baseline:`/), JSON.stringify(noList.problems));

	// ── the allowlist reader fails LOUDLY, in both directions ────────────────────────────────
	const parses = (t) => {
		try {
			return parseAllowlist(t);
		} catch (err) {
			return String(err instanceof Error ? err.message : err);
		}
	};
	const good = "baseline: 1\n\nformat:\n  - path: apps/console/components/a.tsx\n    hits: 2\n    reason: because.\n";
	/** A rule-section allowlist plus the floors every run requires, so a fixture tests one thing. */
	const withFloors = (t) => t + EMPTY_LIST.slice(EMPTY_LIST.indexOf("scanned:"));
	ok("a well-formed entry parses", typeof parses(good) === "object" && parses(good).entries.length === 1);
	ok("...and carries its hits and reason", parses(good).entries[0].hits === 2 && parses(good).entries[0].reason === "because.");
	ok("an unknown section is rejected", /unknown section/.test(String(parses("baseline: 0\nnope:\n"))));
	ok("a missing reason is rejected", /has no `reason:`/.test(String(parses("baseline: 1\nformat:\n  - path: a.tsx\n    hits: 1\n"))));
	ok("a missing hits is rejected", /has no `hits:`/.test(String(parses("baseline: 1\nformat:\n  - path: a.tsx\n    reason: x\n"))));
	// A `- scope:` with no `floor:` would otherwise carry the sentinel -1, i.e. a floor nothing
	// can fall below — a census control that reads as configured and is not one.
	ok("a scope with no floor is rejected", /has no `floor:`/.test(String(parses("baseline: 0\nscanned:\n  - scope: console_code\n"))));
	ok("a `floor:` outside a scope entry is rejected", /outside a `- scope:` entry/.test(String(parses("baseline: 0\nscanned:\n    floor: 3\n"))));
	ok("a `- scope:` outside the scanned section is rejected", /belongs to the `scanned:` section/.test(String(parses("baseline: 0\nformat:\n  - scope: console_code\n"))));
	ok("a line it cannot parse is rejected, not skipped", /cannot parse/.test(String(parses("baseline: 0\nformat:\n  - patth: a.tsx\n"))));
	ok("an entry before any section is rejected", /before any section/.test(String(parses("baseline: 0\n  - path: a.tsx\n"))));
	ok("a comment and a blank line are fine", typeof parses("# note\n\nbaseline: 0\n") === "object");
	// A duplicate is a second free entry against `baseline`, and only one of its two reasons is
	// the decision anyone recorded.
	ok(
		"the same file twice in one section is rejected",
		/a second `format` entry/.test(String(parses("baseline: 2\nformat:\n  - path: a.tsx\n    hits: 1\n    reason: x\n  - path: a.tsx\n    hits: 1\n    reason: y\n"))),
	);

	// ── the ratchet and the positive control ─────────────────────────────────────────────────
	const tree = { ...ballast(), "apps/console/components/a.tsx": "const a = n.toFixed(2);" };
	const entry = (hits, p = "apps/console/components/a.tsx") =>
		withFloors(`baseline: 1\n\nformat:\n  - path: ${p}\n    hits: ${hits}\n    reason: THE RECORDED DECISION.\n`);
	ok("an allowlisted site passes", run(tree, entry(1)).problems.length === 0, JSON.stringify(run(tree, entry(1)).problems));
	ok("an unallowlisted site fails with file:line", says(run(tree, EMPTY_LIST), /components\/a\.tsx:1:/));
	ok("an entry that over-declares fails", says(run(tree, entry(2)), /declares 2 hit\(s\) and there are 1/));
	ok("an entry matching NOTHING fails — the positive control", says(run(tree, entry(1, "apps/console/components/gone.tsx")), /matches nothing/));
	// The allowlist's header promises the guard prints the reason to whoever trips over it.
	ok("...and both entry failures print the recorded reason", says(run(tree, entry(2)), /THE RECORDED DECISION/) && says(run(tree, entry(1, "apps/console/components/gone.tsx")), /THE RECORDED DECISION/));
	const grew = withFloors(`baseline: 0\n\nformat:\n  - path: apps/console/components/a.tsx\n    hits: 1\n    reason: because.\n`);
	ok("the list may never grow past its baseline", says(run(tree, grew), /only shrinks/));
	const shrank = withFloors(`baseline: 2\n\nformat:\n  - path: apps/console/components/a.tsx\n    hits: 1\n    reason: because.\n`);
	ok("...and a shrink must be recorded, not left as headroom", says(run(tree, shrank), /Lower `baseline:` to 1/));

	// ── the permanent positive control, exercised in both directions ────────────────────────
	// Both halves are exercised THROUGH `check`, not against `RULES` directly: the earlier version
	// asserted the matchers here and left the control inside `check` uncovered, so deleting the
	// anti-probe branch kept the whole self-test green.
	const dead = RULES[0].matchers[0];
	const realRe = dead.re;
	dead.re = /THIS_WILL_NEVER_APPEAR/g;
	const blind = run(tree, entry(1));
	dead.re = realRe;
	ok("a matcher that stopped matching FAILS rather than reporting a clean tree", says(blind, /no longer matches its own probe/), JSON.stringify(blind.problems));

	dead.re = /toFixed|toFixed/g; // matches the bare identifier its anti-probe is built from
	const widened = run(tree, entry(1));
	dead.re = realRe;
	ok("a matcher that WIDENED onto correct code fails too", says(widened, /has widened onto/), JSON.stringify(widened.problems));

	// ── the guard must not be able to match itself or its own fixtures ───────────────────────
	const mixed = fakeTree({ "scripts/check-shared-surface.mjs": "const a = n.toFixed(2);", "apps/console/components/a.tsx": "" });
	const scannedPaths = Object.values(SCOPES).flatMap((s) => filesFor(s, mixed.listDir).files);
	ok("the console file IS reached", scannedPaths.includes("apps/console/components/a.tsx"));
	ok("...and this guard, sitting in scripts/, is never scanned", !scannedPaths.includes("scripts/check-shared-surface.mjs"));
	ok("the fixtures above live in this file, not on disk", !fs.existsSync(path.join(ROOT, "apps/console/components/x/probe.tsx")));
	// A raw NUL in this file's own source made `rg` and `grep -r` report "binary file matches" and
	// print nothing, for a guard whose value is that the next reader can read its stated scope.
	// `import.meta.filename`, not a hardcoded path: the assertion has to read the file that is
	// actually running, or a copy of this guard would check the pristine original and pass.
	ok("this file holds no NUL byte, so ripgrep will still print it", !fs.readFileSync(import.meta.filename, "utf8").includes("\u0000"));

	if (fails > 0) {
		console.error(`\ncheck-shared-surface self-test: ${fails} failure(s)`);
		process.exit(1);
	}
	console.log("\nself-test: all passed");
}

// ── entry ─────────────────────────────────────────────────────────────────────────────────────

if (process.argv.includes("--self-test")) {
	selfTest();
} else {
	const readFile = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
	/** @param {string} dir */
	const listDir = (dir) => {
		let entries;
		try {
			entries = fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true });
		} catch (err) {
			// ENOTDIR is how `filesFor` asks "is this path a file?", and it is the expected answer
			// for every file in the tree. Everything else — EACCES on an unreadable directory, a
			// dangling symlink — is rethrown: swallowing it dropped that whole subtree from the
			// scan and still printed `✓ … examined N file(s)`.
			if (err instanceof Error && "code" in err && err.code === "ENOTDIR") return [];
			throw err;
		}
		return entries.filter((e) => e.isDirectory() || e.isFile()).map((e) => e.name);
	};
	const { problems, census, perRule, allowed, entries } = check(readFile, listDir);
	for (const p of problems) console.error(`::error::shared-surface: ${p}`);
	// The per-root breakdown is printed on EVERY run, pass or fail. A collapse that the floors
	// above cannot see — one root emptying while another grows — is then visible in the diff of
	// two CI logs rather than invisible behind a single total.
	// Keyed by SCOPE and root, not by root alone: `apps/console/components` is a root of three
	// scopes, and summing them prints 1040 for a directory holding 364 files, which is the kind of
	// number a reader stops trusting.
	const perRoot = new Map();
	for (const [key, n] of census) {
		const [scopeId, root] = key.split(SEP);
		const label = `${scopeId}:${root}`;
		perRoot.set(label, (perRoot.get(label) ?? 0) + n);
	}
	const breakdown = [...perRoot].map(([label, n]) => `${label} ${n}`).join(", ");
	const rules = [...perRule].map(([id, n]) => `${id} ${n}`).join(", ");
	if (problems.length > 0) {
		console.error(`\n${problems.length} problem(s) (files per rule — ${rules}; per root — ${breakdown}).`);
		process.exit(1);
	}
	console.log(
		`✓ check-shared-surface: files per rule — ${rules}; per root — ${breakdown}. ` +
			`Every hand-rolled ${RULES.map((r) => r.surface).join(" / ")} site is one of the ${allowed} ` +
			`occurrence(s) that ${entries} recorded decision(s) in ${ALLOWLIST} account for.`,
	);
}
