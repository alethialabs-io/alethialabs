#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
//
// `if-no-files-found: error` is AGGREGATE. A step that lists several paths under it cannot fail
// the way the setting reads.
//
// WHY THIS EXISTS (#4347). `actions/upload-artifact` runs ONE combined glob search over every
// pattern in `path:` and then applies `if-no-files-found` to the whole of it — the test in its
// source is
//
//     if (searchResult.filesToUpload.length === 0)
//
// over the files found across ALL patterns, not a per-pattern check. So `error` fires only when
// NOTHING AT ALL matched: any one path matching covers for every other path producing nothing.
// The action's README does not say this — it says only "The desired behavior if no files are found
// using the provided path" — which is exactly why the configuration reads as stricter than it is.
//
// Both live instances were in ci.yml and both were the bad kind, where the path that always
// matches is the one riding along:
//
//     path: |
//       ts-coverage-floors/                                   ← the thing the dispatch exists for
//       packages/plan-catalog/coverage/coverage-final.json    ← a fixture, always present
//     if-no-files-found: error
//
// An empty `ts-coverage-floors/` uploaded happily and the dispatch reported success having armed
// nothing. The artefact that exists to make the failure visible was the one hiding it.
//
// WHY A GUARD AND NOT JUST THE EDIT. The instinct on finding a missing file in an artifact is to
// ADD ITS PATH to the existing step — the smallest possible diff, and it makes the problem worse
// every time: each entry added widens the set of ways the guard can be satisfied by something
// other than the thing it is guarding. That edit is one line, is invisible in review, and puts the
// repo straight back where it was. Splitting the two sites without leaving something behind to
// refuse the re-merge fixes today only.
//
//   node scripts/ci/check-upload-aggregate.mjs
//   node scripts/ci/check-upload-aggregate.mjs --self-test
//
// THE RULE, stated as a shape rather than as a text pattern: an `actions/upload-artifact` step
// whose `with.path` RESOLVES to two or more inclusion entries, and whose `with.if-no-files-found`
// resolves to `error`. Resolves, not "is written as": a first pass of this check tested the written
// form and an adversarial read found five valid-YAML spellings of the identical defective step that
// all walked past it — a double-quoted `"a\nb"`, a single-quoted scalar folded over a blank line,
// `with:` children indented by four, extra spaces after the sequence dash, a quoted `uses:`, and a
// value on the line below its key. None is exotic; each is one edit from the shape it evades, and
// the worst of them also zeroed the repo-wide floor that was supposed to notice. So the values are
// RESOLVED — folding, quoting and block indicators and all — and a value that cannot be resolved is
// REFUSED rather than scored as one path.
//
// The fix is one step per artefact, each keeping its own `if-no-files-found: error` — the shape
// `go-floors-rerecord.yml` and `deploy-console.yml` already use — or an explicit pre-upload
// assertion that each specific path is non-empty.
//
// WHAT THIS DOES NOT SAY. A multi-path step with `if-no-files-found` at `warn` or left unset is
// NOT reported. Two of those exist here deliberately (ci.yml's `ui-audit`, release-gate.yml's
// per-project report) and they are a different question — whether they should be asserting at all
// — which this guard would only muddy by pre-judging. Nothing here checks that a single-path
// upload is *right*, either: `if-no-files-found: error` on one path means what it says, and that
// is the whole of what is being restored.
//
// Line-based, because `yaml` is a dependency of apps/console and not of the root while this runs
// under plain `node` — the same constraint and the same shape as check-workflow-shape.mjs, whose
// step walk this borrows. A line parser that stops matching finds nothing and reports success, so
// the floors in `check` are not decoration; they are what makes a green result mean anything.
//
// ── WHAT THE PARSER DELIBERATELY DOES NOT READ ──
//
//   * A brace expansion in a single entry (`dist/{a,b}`) is ONE entry here. It is aggregate in the
//     same way, but the repo has none and inventing the case would mean inventing its fix too.
//   * A path built entirely from an expression (`path: ${{ steps.x.outputs.files }}`) is one
//     entry, because its multiplicity is not in the file.
//   * An entry beginning with `!` is an EXCLUSION, not another way to satisfy the guard, so it is
//     counted and then discounted. A step whose only extra entries are exclusions is fine.
//   * A `#` line inside a `path: |` literal block is CONTENT, not a comment — YAML says so — and
//     is counted as an entry. Commenting a path out in there does not remove it; it renames it.
//   * A FOLDED block (`>`) joins its lines with SPACES, so it is ONE pattern, not several. Reading
//     it as several would red a file that is not defective, which is how a check gets routed
//     around. Blank lines inside one do yield newlines, and that IS read.
//   * A trailing `\` inside a double-quoted scalar suppresses the line fold. Not modelled; such a
//     value is folded with a space, which can only ever UNDER-count entries by joining two.
//   * A flow sequence (`path: [a, b]`) is not read, because `actionlint` rejects it outright: the
//     action's input is a string. A second refusal here would be a rule with no reachable subject.
//   * YAML anchors and aliases are not read. Actions does not support them; a workflow using one
//     does not run at all.
//   * `ERROR` in any other casing is not `error` here and is not treated as one. The action's
//     `input-helper.ts` calls `setFailed` on an unrecognised value, so that spelling is LOUD at
//     runtime rather than a silent downgrade — a different failure, already visible.
//   * Reusable workflows and composite actions are invisible to a line scan, as they are to every
//     other line-based check here.
//   * `if-no-files-found: warn`, or the key left unset, is not read as a defect. See the note
//     above; the escape it leaves open is real and named in #4347's follow-up.

import fs from "node:fs";
import path from "node:path";

const DIR = ".github/workflows";

/** The action this is about. Matched on the owner/repo, so any `@version` is covered. */
const UPLOAD = /^actions\/upload-artifact@/;

/**
 * A LITERAL block indicator — `|`, `|-`, `|+`, `|2`. Every line of the block is its own entry, and
 * this is the only spelling in the repo.
 */
const LITERAL_BLOCK = /^\|[-+\d]*$/;

/**
 * A FOLDED block indicator — `>`, `>-`, `>2`. NOT the same thing: folding joins the lines with
 * SPACES, so `>` over two lines is ONE glob pattern, not two. Reading it as two would report a
 * step that is not defective — and a guard that fires on a correct file is how a check gets
 * routed around. Blank lines inside a folded block DO produce newlines, and `fold` handles that,
 * so the distinction costs nothing.
 */
const FOLDED_BLOCK = /^>[-+\d]*$/;

/** @param {string} line */
const indentOf = (line) => line.match(/^(\s*)/)?.[1].length ?? 0;

/**
 * YAML line folding, which is what makes several of the evasions below equivalent to a block list.
 * Between two non-empty lines a break folds to a SPACE; N consecutive blank lines yield N newlines.
 * Used for folded blocks, multi-line plain scalars and multi-line quoted scalars alike.
 *
 * @param {string[]} parts trimmed lines, "" for a blank one
 * @returns {string}
 */
export function fold(parts) {
	let out = "";
	let blanks = 0;
	let started = false;
	for (const p of parts) {
		if (p === "") {
			if (started) blanks += 1;
			continue;
		}
		if (!started) {
			out = p;
			started = true;
			continue;
		}
		out += blanks > 0 ? "\n".repeat(blanks) : " ";
		out += p;
		blanks = 0;
	}
	return out;
}

/**
 * The body of a quoted scalar, which may span lines.
 *
 * A quoted `path:` is the sharpest evasion of the rule: `path: "a\nb"` is ONE line of YAML, is not
 * a block scalar, and means exactly what the two-line block means. So the quote has to be closed
 * properly — and when it cannot be, that is REPORTED, never skipped. A value this cannot read is
 * not a value with one entry.
 *
 * @param {string} inline the value text on the key's own line, starting with the quote
 * @param {string[]} cont the continuation lines, trimmed, "" for blank
 * @returns {{parts: string[], closed: boolean, quote: string}}
 */
export function gatherQuoted(inline, cont) {
	const quote = inline[0];
	/** index of the closing quote in `s`, or -1 */
	const closesAt = (s) => {
		for (let i = 0; i < s.length; i++) {
			if (quote === "'") {
				if (s[i] !== "'") continue;
				if (s[i + 1] === "'") {
					i += 1;
					continue;
				}
				return i;
			}
			if (s[i] === "\\") {
				i += 1;
				continue;
			}
			if (s[i] === '"') return i;
		}
		return -1;
	};
	const first = inline.slice(1);
	const at = closesAt(first);
	if (at !== -1) return { parts: [first.slice(0, at)], closed: true, quote };
	const parts = [first];
	for (const l of cont) {
		if (l === "") {
			parts.push("");
			continue;
		}
		const c = closesAt(l);
		if (c !== -1) {
			parts.push(l.slice(0, c));
			return { parts, closed: true, quote };
		}
		parts.push(l);
	}
	return { parts, closed: false, quote };
}

/**
 * Undo one level of quoting, AFTER folding — the order matters, because a `\n` escape inside a
 * double-quoted scalar is a newline the fold must not have already turned into a space.
 *
 * @param {string} s folded body
 * @param {string} quote `'` or `"`
 */
function unquote(s, quote) {
	if (quote === "'") return s.replace(/''/g, "'");
	return s.replace(/\\(.)/g, (_, c) => (c === "n" ? "\n" : c === "t" ? "\t" : c === "r" ? "\r" : c === "0" ? "\0" : c));
}

/**
 * Resolve a `with:` key's value to the string YAML would produce, across every spelling the value
 * can take: inline plain, inline quoted, multi-line quoted, multi-line plain, and block scalars.
 *
 * @param {string[]} lines the whole file
 * @param {number} raw index of the key's own line
 * @param {string} inline the text after `key:` on that line
 * @returns {{value: string, kind: string, readable: boolean}} `value` may contain newlines
 */
export function resolveValue(lines, raw, inline) {
	const keyCol = indentOf(lines[raw]);
	/** every continuation line, trimmed; blanks kept, trailing blanks dropped */
	const cont = [];
	for (let r = raw + 1; r < lines.length; r++) {
		if (lines[r].trim() === "") {
			cont.push("");
			continue;
		}
		if (indentOf(lines[r]) <= keyCol) break;
		cont.push(lines[r].trim());
	}
	while (cont.length > 0 && cont[cont.length - 1] === "") cont.pop();

	if (LITERAL_BLOCK.test(inline)) return { value: cont.filter((l) => l !== "").join("\n"), kind: "literal", readable: true };
	if (FOLDED_BLOCK.test(inline)) return { value: fold(cont), kind: "folded", readable: true };
	if (inline === "") return { value: fold(cont), kind: "plain", readable: true };
	if (inline[0] === "'" || inline[0] === '"') {
		const { parts, closed, quote } = gatherQuoted(inline, cont);
		return { value: unquote(fold(parts), quote), kind: `quoted(${quote})`, readable: closed };
	}
	// A plain scalar may still continue onto more-indented lines, folding with spaces.
	return { value: fold([inline, ...cont]), kind: "plain", readable: true };
}

/**
 * Every `actions/upload-artifact` step in one workflow, with its `path:` entries resolved.
 *
 * The step walk is check-workflow-shape.mjs's: a list item whose nearest shallower bare key is
 * `steps`, so `on:`/`paths:`/`with:`/matrix lists are not mistaken for steps. Comment lines are
 * dropped from the step's key list — re-basing one turns `# path: |` into `path: |` — but the
 * `path:` block is then read back from the RAW lines, where a `#` inside a literal block is the
 * content YAML says it is.
 *
 * Every spelling of a value that YAML resolves to the same thing is resolved to the same thing —
 * see `resolveValue`. A step whose `path:` this parser cannot resolve goes in `unreadable` and is
 * REPORTED; it is never scored as a step with one path.
 *
 * @param {string} text
 * @returns {{uploads: number, pathKeys: number, guarded: number, multi: number, problems: {line: number, name: string, artifact: string, entries: string[], excludes: string[], kind: string}[], unreadable: {line: number, name: string, artifact: string, why: string}[]}}
 */
export function scanUploads(text) {
	const lines = text.split("\n");
	const jobsAt = lines.findIndex((l) => /^jobs:\s*$/.test(l));
	if (jobsAt === -1) return { uploads: 0, pathKeys: 0, guarded: 0, multi: 0, problems: [], unreadable: [] };

	let uploads = 0;
	let pathKeys = 0;
	let guarded = 0;
	let multi = 0;
	const problems = [];
	const unreadable = [];

	for (let i = jobsAt + 1; i < lines.length; i++) {
		const item = lines[i].match(/^(\s+)-(\s+)(\S.*)$/);
		if (item === null) continue;
		const indent = item[1].length;
		// The column the step's own keys sit at. DERIVED, not `indent + 2`: `-   uses:` is ordinary
		// YAML, and a hard-coded two would re-base every following line by the wrong amount, so
		// `uses:` would never match and the step would not be seen at all.
		const childCol = indent + 1 + item[2].length;

		// Only list items inside a `steps:` block: the nearest preceding bare key at or above this
		// item's own column. `<=` and not `<` because YAML lets a sequence sit at the SAME
		// indentation as the key that owns it — every workflow here indents `steps:` items by two,
		// but a file that did not would otherwise scan to zero uploads and read as clean.
		let owner = null;
		for (let b = i - 1; b > jobsAt; b--) {
			const key = lines[b].match(/^(\s*)([A-Za-z0-9_-]+):\s*$/);
			if (key === null) continue;
			if (key[1].length <= indent) {
				owner = key[2];
				break;
			}
		}
		if (owner !== "steps") continue;

		// The step's own lines, re-based so a top-level key of the step sits at column 0. Each keeps
		// its absolute line number, which is what the value resolver needs.
		const own = [{ text: item[3], line: i + 1, raw: i }];
		for (let j = i + 1; j < lines.length; j++) {
			if (new RegExp(`^\\s{${indent}}-\\s`).test(lines[j])) break;
			if (lines[j].trim() !== "" && indentOf(lines[j]) <= indent && !/^\s*#/.test(lines[j])) break;
			if (/^\s*#/.test(lines[j])) continue;
			own.push({ text: lines[j].slice(childCol), line: j + 1, raw: j });
		}

		const usesAt = own.find((o) => /^uses:\s*\S/.test(o.text));
		if (usesAt === undefined) continue;
		// The quotes come off BEFORE the anchored test: `uses: "actions/upload-artifact@v7"` is the
		// same step, and an anchored match against a leading `"` is a one-character evasion.
		if (!UPLOAD.test(usesAt.text.replace(/^uses:\s*/, "").trim().replace(/^['"]|['"]$/g, ""))) continue;
		uploads += 1;

		const name = own.find((o) => /^name:\s*\S/.test(o.text))?.text.replace(/^name:\s*/, "").trim() ?? usesAt.text.trim();

		// The direct children of the step's `with:`: the block's OWN indent, whatever it is, taken
		// from its first key rather than assumed to be two. Four-space `with:` children are ordinary
		// YAML, and hard-coding two made every key of such a step invisible — including its `path:`,
		// which then also kept the repo-wide "read zero paths" floor from ever noticing.
		const withIdx = own.findIndex((o) => /^with:/.test(o.text));
		const withInline = withIdx === -1 ? "" : own[withIdx].text.replace(/^with:\s*/, "").trim();
		const withKeys = [];
		let childIndent = null;
		if (withIdx !== -1 && withInline === "") {
			for (let k = withIdx + 1; k < own.length; k++) {
				const t = own[k].text;
				if (t.trim() === "") continue;
				if (/^\S/.test(t)) break;
				const ind = indentOf(t);
				if (childIndent === null) childIndent = ind;
				if (ind !== childIndent) continue;
				const m = t.match(/^\s+([A-Za-z0-9_-]+):\s*(.*)$/);
				if (m !== null) withKeys.push({ key: m[1], inline: m[2].trim(), line: own[k].line, raw: own[k].raw });
			}
		}

		const artifact = withKeys.find((w) => w.key === "name")?.inline ?? "(unnamed)";
		const pathKey = withKeys.find((w) => w.key === "path");
		const inffKey = withKeys.find((w) => w.key === "if-no-files-found");

		// `path` is REQUIRED by the action, so a step this parser finds none in is a step this
		// parser did not understand — an inline `with: {…}` mapping, a shape not modelled here, or a
		// walk that has stopped walking. Reported, because skipping it is exactly the silent pass
		// this whole check exists to remove: the repo-wide floor below cannot see one step going
		// unread among seventeen that are.
		if (pathKey === undefined) {
			unreadable.push({
				line: own[withIdx === -1 ? 0 : withIdx].line,
				name,
				artifact,
				why: withIdx === -1 ? "it declares no `with:` block" : withInline !== "" ? `its \`with:\` is an inline mapping (\`${withInline}\`)` : "no `path:` key was found among its `with:` keys",
			});
			continue;
		}
		pathKeys += 1;

		const resolvedPath = resolveValue(lines, pathKey.raw, pathKey.inline);
		if (!resolvedPath.readable) {
			unreadable.push({ line: pathKey.line, name, artifact, why: `its \`path:\` is a quoted scalar this parser could not close` });
			continue;
		}
		const entries = resolvedPath.value
			.split("\n")
			.map((e) => e.trim())
			.filter((e) => e !== "");

		const excludes = entries.filter((e) => e.startsWith("!"));
		const includes = entries.filter((e) => !e.startsWith("!"));
		if (includes.length > 1) multi += 1;

		const inff = inffKey === undefined ? undefined : resolveValue(lines, inffKey.raw, inffKey.inline).value.trim();
		if (inff === "error") guarded += 1;
		if (inff !== "error" || includes.length < 2) continue;

		problems.push({ line: pathKey.line, name, artifact, entries: includes, excludes, kind: resolvedPath.kind });
	}

	return { uploads, pathKeys, guarded, multi, problems, unreadable };
}

/** @returns {string[]} failures */
export function check(dir = DIR, readdir = fs.readdirSync, readFile = (p) => fs.readFileSync(p, "utf8")) {
	const out = [];
	let files;
	try {
		files = readdir(dir).filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"));
	} catch {
		return [`${dir} could not be read — this check cannot run, which is not the same as passing.`];
	}
	if (files.length === 0) {
		return [`no workflow files found in ${dir} — the matcher has stopped matching, or the directory moved.`];
	}

	let uploads = 0;
	let pathKeys = 0;
	let guarded = 0;
	let multi = 0;
	for (const f of files.sort()) {
		const scan = scanUploads(readFile(path.join(dir, f)));
		uploads += scan.uploads;
		pathKeys += scan.pathKeys;
		guarded += scan.guarded;
		multi += scan.multi;
		for (const p of scan.problems) {
			out.push(
				`${dir}/${f}:${p.line}: the step \`${p.name}\` uploads artifact \`${p.artifact}\` from ${p.entries.length} paths ` +
					`under one \`if-no-files-found: error\`:\n` +
					p.entries.map((e) => `      ${e}`).join("\n") +
					(p.excludes.length > 0 ? `\n    (plus ${p.excludes.length} exclusion(s), which are not the problem)` : "") +
					`\n    That setting is AGGREGATE: the action globs every entry together and tests ` +
					"`searchResult.filesToUpload.length === 0` ONCE, so it fires only when NOTHING AT ALL matched. Any one of " +
					"those paths matching covers for every other producing nothing, and the step reports SUCCESS having captured " +
					"nothing it exists for. Give each path its own `actions/upload-artifact` step, each keeping its own " +
					"`if-no-files-found: error` — the shape go-floors-rerecord.yml and deploy-console.yml use — or assert each " +
					"path is non-empty before uploading. Do NOT add a path to a step like this: every entry widens the set of " +
					"ways the guard is satisfied by something other than the thing it is guarding (#4347).",
			);
		}
		for (const u of scan.unreadable) {
			out.push(
				`${dir}/${f}:${u.line}: the \`actions/upload-artifact\` step \`${u.name}\` (artifact \`${u.artifact}\`) could not be ` +
					`read: ${u.why}. \`path\` is REQUIRED by the action, so this is either a workflow that would fail at runtime or a ` +
					"shape this parser does not model — and the difference matters, because an unread step is scored as nothing at " +
					"all. It is refused rather than skipped: skipping one step among many is invisible to the repo-wide floors " +
					"below, and a silent pass is the exact failure this check exists to remove. Write the `with:` block as ordinary " +
					"indented keys with a plain or block-scalar `path:`, or teach this parser the shape.",
			);
		}
	}

	// THE FLOORS. Every failure above is "this workflow is wrong"; these are "I am wrong". A line
	// parser that stopped understanding the layout finds no upload steps and reports a clean bill of
	// health, which is the precise shape this check exists to remove from the repo.
	if (uploads === 0) {
		out.push(
			`parsed ${files.length} workflow file(s) and found ZERO \`actions/upload-artifact\` steps. There are more than a ` +
				"dozen, so this scanner has stopped matching — fix it rather than trusting the green.",
		);
	}
	if (uploads > 0 && pathKeys === 0) {
		out.push(
			`found ${uploads} \`actions/upload-artifact\` step(s) and read ZERO \`path:\` keys out of them. Every upload has one, ` +
				"so the `with:` walk has stopped matching and every step is being scored as if it declared nothing.",
		);
	}
	if (uploads > 0 && guarded === 0) {
		out.push(
			`found ${uploads} \`actions/upload-artifact\` step(s), not one of them reading as \`if-no-files-found: error\`. ` +
				"Several here set it, so the value reader has stopped matching — and with nothing scored as guarded, no step in " +
				"the tree can ever be reported.",
		);
	}
	return out;
}

// ── self-test ─────────────────────────────────────────────────────────────────────────────────
function selfTest() {
	let fails = 0;
	const ok = (name, cond, detail = "") => {
		if (cond) console.log(`ok   - ${name}`);
		else {
			console.error(`FAIL - ${name} ${detail}`);
			fails++;
		}
	};

	const wf = (steps, stepIndent = 6) => `name: x\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n${steps}`;
	const scan = (steps) => scanUploads(wf(steps));

	// THE EXACT INPUT THAT PRODUCED THIS ISSUE — ci.yml's ts-coverage floors dispatch, verbatim
	// from dev at 96c4073b5, comments and all. A guard tested only against a fixture someone wrote
	// afterwards passes for the wrong reason.
	const SITE2 =
		"      - uses: actions/upload-artifact@v7\n" +
		"        with:\n" +
		"          name: ts-coverage-floors\n" +
		"          # ONE staged directory, written by the probe from the sweep record.\n" +
		"          #\n" +
		"          # plan-catalog's raw artefact rides along deliberately: it is the smallest project.\n" +
		"          path: |\n" +
		"            ts-coverage-floors/\n" +
		"            packages/plan-catalog/coverage/coverage-final.json\n" +
		"          if-no-files-found: error\n";
	const site2 = scan(SITE2);
	ok("the ts-coverage floors upload is caught", site2.problems.length === 1, JSON.stringify(site2.problems));
	ok("...and the artifact is named", site2.problems[0]?.artifact === "ts-coverage-floors", JSON.stringify(site2.problems));
	ok(
		"...and BOTH offending paths are printed, because a boolean about a structure must show the structure",
		site2.problems[0]?.entries.join(",") === "ts-coverage-floors/,packages/plan-catalog/coverage/coverage-final.json",
		JSON.stringify(site2.problems[0]?.entries),
	);
	ok("...and the comment lines between `name:` and `path:` are not entries", site2.problems[0]?.entries.length === 2);

	// The other live site, with a `name:` on the step and a key AFTER the block.
	const SITE1 =
		"      - name: Upload compliance evidence\n" +
		"        if: ${{ !cancelled() && steps.setup.outcome == 'success' }}\n" +
		"        uses: actions/upload-artifact@v7\n" +
		"        with:\n" +
		"          name: compliance-${{ github.sha }}\n" +
		"          path: |\n" +
		"            dist/compliance\n" +
		"            dist/community-source\n" +
		"          if-no-files-found: error\n" +
		"          retention-days: 30\n";
	const site1 = scan(SITE1);
	ok("the compliance upload is caught", site1.problems.length === 1, JSON.stringify(site1.problems));
	ok("...and it is named by its step `name:`, not by its `with.name`", site1.problems[0]?.name === "Upload compliance evidence", JSON.stringify(site1.problems));
	ok("...and a key after the block scalar ends it", site1.problems[0]?.entries.length === 2, JSON.stringify(site1.problems[0]?.entries));

	// THE FIX SHAPE. Assert the catch first, then the fix — in that order, or a guard written
	// alongside its fix proves only that it did not fire.
	const FIXED =
		"      - name: Upload compliance evidence\n" +
		"        uses: actions/upload-artifact@v7\n" +
		"        with:\n" +
		"          name: compliance-${{ github.sha }}\n" +
		"          path: dist/compliance\n" +
		"          if-no-files-found: error\n" +
		"      - name: Upload community-source evidence\n" +
		"        uses: actions/upload-artifact@v7\n" +
		"        with:\n" +
		"          name: community-source-${{ github.sha }}\n" +
		"          path: dist/community-source\n" +
		"          if-no-files-found: error\n";
	ok("the in-repo fix shape is clean", scan(FIXED).problems.length === 0, JSON.stringify(scan(FIXED).problems));
	ok("...and both of its steps were actually seen", scan(FIXED).uploads === 2, `uploads=${scan(FIXED).uploads}`);
	ok("...and both count as guarded", scan(FIXED).guarded === 2, `guarded=${scan(FIXED).guarded}`);
	ok("the fixtures really differ", SITE1 !== FIXED && !FIXED.includes("path: |"));

	// THE OUT-OF-SCOPE SHAPES. Multi-path with `warn`, or with the key absent, is a different
	// question and must not be pre-judged here — two such steps are deliberate in this repo.
	const WARN = SITE1.replace("if-no-files-found: error", "if-no-files-found: warn");
	const UNSET = SITE1.replace("          if-no-files-found: error\n", "");
	ok("the mutations to warn/unset applied", WARN !== SITE1 && UNSET !== SITE1);
	ok("a multi-path step at `warn` is NOT reported", scan(WARN).problems.length === 0, JSON.stringify(scan(WARN).problems));
	ok("a multi-path step with the key unset is NOT reported", scan(UNSET).problems.length === 0, JSON.stringify(scan(UNSET).problems));
	ok("...and both are still counted as multi-entry", scan(WARN).multi === 1 && scan(UNSET).multi === 1);
	// The two deliberate multi-path uploads in this repo, LIFTED VERBATIM — ci.yml's `ui-audit` and
	// release-gate.yml's per-project report. Composed lookalikes were the first version of this
	// case, and a composed fixture only ever proves the guard agrees with what its author already
	// believed the file said.
	const UI_AUDIT =
		"      - name: Upload the audit report\n" +
		"        if: ${{ !cancelled() && steps.checkout.outcome == 'success' }}\n" +
		"        uses: actions/upload-artifact@v7\n" +
		"        with:\n" +
		"          name: ui-audit\n" +
		"          path: |\n" +
		"            apps/console/playwright-report/\n" +
		"            apps/console/test-results/ui-audit*.json\n" +
		"          retention-days: 14\n";
	const RELEASE_GATE =
		"      - name: Upload the report, traces and the JSON the ratchet read\n" +
		"        if: ${{ !cancelled() && steps.checkout.outcome == 'success' }}\n" +
		"        uses: actions/upload-artifact@v7\n" +
		"        with:\n" +
		"          name: release-gate-${{ matrix.project }}\n" +
		"          path: |\n" +
		"            apps/console/playwright-report/\n" +
		"            apps/console/test-results/\n" +
		"          retention-days: 14\n";
	ok("ci.yml's `ui-audit` upload, verbatim, is clean", scan(UI_AUDIT).problems.length === 0, JSON.stringify(scan(UI_AUDIT).problems));
	ok("...and is seen as the multi-path step it is", scan(UI_AUDIT).multi === 1 && scan(UI_AUDIT).uploads === 1, JSON.stringify(scan(UI_AUDIT)));
	ok("release-gate.yml's per-project upload, verbatim, is clean", scan(RELEASE_GATE).problems.length === 0, JSON.stringify(scan(RELEASE_GATE).problems));
	ok("...and it too is seen as multi-path", scan(RELEASE_GATE).multi === 1 && scan(RELEASE_GATE).uploads === 1, JSON.stringify(scan(RELEASE_GATE)));
	// Both are one edit from being reportable, and that edit must report.
	ok("...and adding `if-no-files-found: error` to it DOES report", scan(RELEASE_GATE.replace("          retention-days: 14\n", "          if-no-files-found: error\n          retention-days: 14\n")).problems.length === 1);

	// A single path with `error` is the whole point of the setting and must never be reported.
	const SINGLE = "      - uses: actions/upload-artifact@v7\n        with:\n          name: post-deploy-smoke\n          path: apps/console/smoke-results/\n          if-no-files-found: error\n";
	ok("a single-path `error` upload is clean", scan(SINGLE).problems.length === 0, JSON.stringify(scan(SINGLE).problems));
	ok("...and is counted as guarded", scan(SINGLE).guarded === 1);
	ok("...and is not counted as multi-entry", scan(SINGLE).multi === 0);

	// ── the cheap escape routes ──────────────────────────────────────────────────────────────────
	// Each of these is a one-edit change that a text matcher would let through while leaving the
	// defect exactly where it was. A guard whose cheapest escape deepens the defect is worse than
	// no guard.
	const QUOTED = SITE1.replace("if-no-files-found: error", "if-no-files-found: 'error'");
	ok("a quoted `'error'` does not dodge it", scan(QUOTED).problems.length === 1, JSON.stringify(scan(QUOTED).problems));
	const DQUOTED = SITE1.replace("if-no-files-found: error", 'if-no-files-found: "error"');
	ok("...nor a double-quoted one", scan(DQUOTED).problems.length === 1);
	const REORDERED =
		"      - uses: actions/upload-artifact@v7\n" +
		"        with:\n" +
		"          if-no-files-found: error\n" +
		"          name: compliance\n" +
		"          path: |\n" +
		"            dist/compliance\n" +
		"            dist/community-source\n";
	ok("putting `if-no-files-found:` before `path:` does not dodge it", scanUploads(wf(REORDERED)).problems.length === 1, JSON.stringify(scanUploads(wf(REORDERED)).problems));
	const KEEP = SITE1.replace("path: |\n", "path: |+\n");
	ok("a `|+` block indicator is still a block", scan(KEEP).problems.length === 1, JSON.stringify(scan(KEEP).problems));
	const BLANKLINE = SITE1.replace("            dist/compliance\n", "            dist/compliance\n\n");
	ok("a blank line inside the block is not a third path", scan(BLANKLINE).problems[0]?.entries.length === 2, JSON.stringify(scan(BLANKLINE).problems[0]?.entries));
	const OLDVERSION = SITE1.replace("upload-artifact@v7", "upload-artifact@v4");
	ok("an older action version is the same action", scan(OLDVERSION).problems.length === 1);

	// ── THE SIX EVASIONS AN ADVERSARIAL READ FOUND (#4595 review) ────────────────────────────────
	//
	// Every one of these is valid YAML, passes actionlint, and parses to a step semantically
	// IDENTICAL to SITE1. The first pass of this check walked past all six. They are asserted
	// against the resolver directly as well as end to end, so a regression says which half broke.

	// E1 — a double-quoted scalar with an escaped newline. Not a block scalar, so a check that
	// tests "is it a block?" takes the whole thing as one path.
	const E1 = '      - uses: actions/upload-artifact@v7\n        with:\n          name: compliance\n          path: "dist/compliance\\ndist/community-source"\n          if-no-files-found: error\n';
	ok("E1 a double-quoted `\\n` is two paths", scan(E1).problems[0]?.entries.length === 2, JSON.stringify(scan(E1)));
	ok("...and both are printed", scan(E1).problems[0]?.entries.join(",") === "dist/compliance,dist/community-source", JSON.stringify(scan(E1).problems[0]?.entries));

	// E2 — a single-quoted flow scalar spanning lines. YAML folds a lone break to a SPACE and a
	// blank line to a newline, so the blank line is what makes this two patterns.
	const E2 = "      - uses: actions/upload-artifact@v7\n        with:\n          name: compliance\n          path: 'dist/compliance\n\n            dist/community-source'\n          if-no-files-found: error\n";
	ok("E2 a folded single-quoted scalar over a blank line is two paths", scan(E2).problems[0]?.entries.length === 2, JSON.stringify(scan(E2)));
	// The same scalar WITHOUT the blank line folds to one pattern and must NOT be reported.
	const E2_ONE = E2.replace("dist/compliance\n\n", "dist/compliance\n");
	ok("...and without the blank line it folds to ONE pattern and is clean", scan(E2_ONE).problems.length === 0, JSON.stringify(scan(E2_ONE)));

	// E3 — `with:` children indented by four. The worst of the six: a matcher pinned to two spaces
	// found no `path:` key at all, and a step scored as declaring nothing also kept the repo-wide
	// "read zero `path:` keys" floor from ever noticing.
	const E3 = SITE1.replace(/^ {10}/gm, "            ").replace(/^ {12}dist/gm, "              dist");
	ok("the E3 fixture really re-indented", E3 !== SITE1);
	ok("E3 four-space `with:` children are read", scan(E3).problems.length === 1, JSON.stringify(scan(E3)));
	ok("...and the step is not scored as pathless", scan(E3).pathKeys === 1 && scan(E3).unreadable.length === 0, JSON.stringify(scan(E3)));

	// E4 — extra spaces after the sequence dash. A re-base of `indent + 2` shifts every following
	// line, so `uses:` never matches and the step is not seen at all.
	// The whole body shifts with the dash: `-   name:` starts the mapping at column 10, so its
	// siblings align there too. A fixture that moved only the dash would not be valid YAML, and a
	// self-test that feeds the parser something Actions would reject proves nothing about either.
	const E4 = SITE1.split("\n")
		.map((l, i) => (i === 0 ? l.replace("      - ", "      -   ") : l === "" ? l : `  ${l}`))
		.join("\n");
	ok("E4 extra spaces after the dash still yield a step", scan(E4).uploads === 1, JSON.stringify(scan(E4)));
	ok("...and it is still caught", scan(E4).problems.length === 1, JSON.stringify(scan(E4)));

	// E5 — a quoted `uses:`. One character in front of an anchored match.
	const E5 = SITE1.replace("uses: actions/upload-artifact@v7", 'uses: "actions/upload-artifact@v7"');
	ok("E5 a quoted `uses:` is the same action", scan(E5).uploads === 1 && scan(E5).problems.length === 1, JSON.stringify(scan(E5)));
	const E5B = SITE1.replace("uses: actions/upload-artifact@v7", "uses: 'actions/upload-artifact@v7'");
	ok("...single quotes too", scan(E5B).problems.length === 1);

	// E6 — the value on the line below its key. A reader of the key's own line sees "" and skips.
	const E6 = SITE1.replace("          if-no-files-found: error\n", "          if-no-files-found:\n            error\n");
	ok("the E6 fixture really moved the value", E6 !== SITE1);
	ok("E6 a next-line scalar value is read", scan(E6).problems.length === 1, JSON.stringify(scan(E6)));
	ok("...and counted as guarded", scan(E6).guarded === 1, JSON.stringify(scan(E6)));

	// The resolver, directly — the six above go through `scanUploads`, so a resolver regression
	// could hide behind a walk regression and vice versa.
	const rv = (src) => resolveValue(src.split("\n"), 0, src.split("\n")[0].replace(/^\s*path:\s*/, ""));
	ok("resolveValue: a literal block splits per line", rv("path: |\n  a\n  b\n").value === "a\nb");
	ok("resolveValue: a FOLDED block joins with a space", rv("path: >\n  a\n  b\n").value === "a b");
	ok("resolveValue: a folded block with a blank line yields a newline", rv("path: >\n  a\n\n  b\n").value === "a\nb");
	ok("resolveValue: a double-quoted `\\n` unescapes", rv('path: "a\\nb"\n').value === "a\nb");
	ok("resolveValue: `\\\\n` is a literal backslash-n, not a break", rv('path: "a\\\\nb"\n').value === "a\\nb", JSON.stringify(rv('path: "a\\\\nb"\n').value));
	ok("resolveValue: a single-quoted `''` is one quote", rv("path: 'a''b'\n").value === "a'b");
	ok("resolveValue: an unterminated quote is UNREADABLE, not one entry", rv("path: 'a\n").readable === false);
	ok("resolveValue: a plain multi-line scalar folds to one", rv("path: a\n  b\n").value === "a b");

	// And the refusal for a value that cannot be read: the point is that it is not scored as one
	// path, because "unread" and "one path" are the same green line otherwise.
	const UNCLOSED = "      - uses: actions/upload-artifact@v7\n        with:\n          name: x\n          path: 'dist/compliance\n";
	ok("an unclosable `path:` scalar is REFUSED, not scored as one path", scanUploads(wf(UNCLOSED)).unreadable.length === 1, JSON.stringify(scanUploads(wf(UNCLOSED))));
	const INLINE_WITH = "      - uses: actions/upload-artifact@v7\n        with: { name: x, path: dist/compliance }\n";
	ok("an inline `with:` mapping is REFUSED rather than skipped", scanUploads(wf(INLINE_WITH)).unreadable.length === 1, JSON.stringify(scanUploads(wf(INLINE_WITH))));
	const NOPATH = "      - uses: actions/upload-artifact@v7\n        with:\n          name: x\n          if-no-files-found: error\n";
	ok("an upload step with no `path:` at all is REFUSED — the action requires one", scanUploads(wf(NOPATH)).unreadable.length === 1, JSON.stringify(scanUploads(wf(NOPATH))));
	const refusal = check("d", () => ["a.yml"], () => wf(UNCLOSED));
	ok("...and the refusal reaches check() and names the artifact", refusal.some((p) => /could not be read/.test(p) && /artifact `x`/.test(p)), JSON.stringify(refusal));

	// Three paths is worse, not different.
	const THREE = SITE1.replace("            dist/community-source\n", "            dist/community-source\n            dist/sbom\n");
	ok("three paths are reported, and all three printed", scan(THREE).problems[0]?.entries.length === 3, JSON.stringify(scan(THREE).problems[0]?.entries));

	// An exclusion is not another way to satisfy the guard.
	const EXCLUDE =
		"      - uses: actions/upload-artifact@v7\n" +
		"        with:\n" +
		"          name: one\n" +
		"          path: |\n" +
		"            dist/compliance\n" +
		"            !dist/compliance/tmp\n" +
		"          if-no-files-found: error\n";
	ok("a `!` exclusion beside ONE real path is clean", scan(EXCLUDE).problems.length === 0, JSON.stringify(scan(EXCLUDE).problems));
	const EXCLUDE2 = EXCLUDE.replace("            !dist/compliance/tmp\n", "            dist/community-source\n            !dist/compliance/tmp\n");
	ok("...but two real paths beside one are not", scan(EXCLUDE2).problems.length === 1, JSON.stringify(scan(EXCLUDE2).problems));
	ok("...and the exclusion is reported separately from the offending paths", scan(EXCLUDE2).problems[0]?.excludes.length === 1 && scan(EXCLUDE2).problems[0]?.entries.length === 2);

	// ── false-positive directions ────────────────────────────────────────────────────────────────
	const DOWNLOAD =
		"      - uses: actions/download-artifact@v8\n" +
		"        with:\n" +
		"          pattern: go-floors-*\n" +
		"          path: |\n" +
		"            a\n" +
		"            b\n" +
		"          if-no-files-found: error\n";
	ok("a download-artifact step is not an upload", scan(DOWNLOAD).uploads === 0 && scan(DOWNLOAD).problems.length === 0);
	const NOTSTEPS = `on:\n  push:\n    paths:\n      - "apps/**"\n      - "packages/**"\njobs:\n  a:\n    strategy:\n      matrix:\n        include:\n          - project: console\n          - project: cli\n    steps:\n${SINGLE}`;
	ok("on:/paths: and matrix lists are not steps", scanUploads(NOTSTEPS).uploads === 1, `uploads=${scanUploads(NOTSTEPS).uploads}`);
	const RUNBODY = '      - name: n\n        run: |\n          echo "path: |"\n          echo "  a"\n          echo "  b"\n          echo "if-no-files-found: error"\n';
	ok("a run: body that quotes the shape is not an upload step", scan(RUNBODY).uploads === 0 && scan(RUNBODY).problems.length === 0);
	// A sequence may sit at the SAME column as the key that owns it. No workflow here writes steps
	// that way, which is exactly why it would go unnoticed: the file would scan to zero uploads and
	// read as clean, and only an all-files-zero tree trips the floor.
	const FLUSH = `name: x\njobs:\n  a:\n    steps:\n${SITE1.replace(/^ {2}/gm, "")}`;
	ok("a steps list flush with its own key is still read", scanUploads(FLUSH).uploads === 1, `uploads=${scanUploads(FLUSH).uploads}`);
	ok("...and its merged upload is still caught", scanUploads(FLUSH).problems.length === 1, JSON.stringify(scanUploads(FLUSH).problems));
	const NOWITH = "      - uses: actions/upload-artifact@v7\n";
	ok("an upload step with no `with:` is counted, not crashed on", scan(NOWITH).uploads === 1 && scan(NOWITH).problems.length === 0);
	ok("a workflow with no jobs: block scans to zero rather than throwing", scanUploads("name: x\non: push\n").uploads === 0);

	// ── the floors ───────────────────────────────────────────────────────────────────────────────
	const noDir = check("nope", () => {
		throw new Error("ENOENT");
	});
	ok("an unreadable directory fails", /cannot run, which is not the same as passing/.test(noDir[0] ?? ""), JSON.stringify(noDir));
	const empty = check("d", () => []);
	ok("an empty directory fails", /no workflow files found/.test(empty[0] ?? ""), JSON.stringify(empty));
	const noUploads = check("d", () => ["a.yml"], () => "name: x\njobs:\n  a:\n    runs-on: x\n    steps:\n      - run: true\n");
	ok("a tree with ZERO upload steps fails rather than passing", noUploads.some((p) => /ZERO `actions\/upload-artifact` steps/.test(p)), JSON.stringify(noUploads));
	const noPaths = check("d", () => ["a.yml"], () => wf("      - uses: actions/upload-artifact@v7\n        with:\n          name: x\n"));
	ok("upload steps whose `path:` cannot be found fail", noPaths.some((p) => /read ZERO `path:` keys/.test(p)), JSON.stringify(noPaths));
	const noGuarded = check("d", () => ["a.yml"], () => wf(UI_AUDIT));
	ok("a tree where nothing reads as `error` fails", noGuarded.some((p) => /not one of them reading as/.test(p)), JSON.stringify(noGuarded));

	// End to end: the refusal must carry the file, the step, and the paths, or the next person
	// cannot act on it.
	const viaCheck = check("d", () => ["ci.yml"], () => wf(SITE1) + "\n");
	ok("the merged step is refused through check()", viaCheck.some((p) => /d\/ci\.yml:\d+:/.test(p)), JSON.stringify(viaCheck));
	ok("...and the refusal names the step", viaCheck.some((p) => /Upload compliance evidence/.test(p)));
	ok("...and prints both paths", viaCheck.some((p) => /dist\/compliance/.test(p) && /dist\/community-source/.test(p)));
	ok("...and states the mechanism, not just the verdict", viaCheck.some((p) => /filesToUpload\.length === 0/.test(p) && /AGGREGATE/.test(p)));
	ok("...and names the fix", viaCheck.some((p) => /its own `actions\/upload-artifact` step/.test(p)));

	if (fails > 0) {
		console.error(`\ncheck-upload-aggregate self-test: ${fails} failure(s)`);
		process.exit(1);
	}
	console.log("\nself-test: all passed");
}

// ── entry ─────────────────────────────────────────────────────────────────────────────────────
if (process.argv.includes("--self-test")) {
	selfTest();
} else {
	const problems = check();
	for (const p of problems) console.error(`::error::upload-aggregate: ${p}`);
	if (problems.length > 0) {
		console.error(
			`\n${problems.length} problem(s). Each is an upload step that CANNOT fail the way it reads: ` +
				"`if-no-files-found: error` is aggregate, so one path matching lets every other path produce nothing and the step " +
				"still reports success.",
		);
		process.exit(1);
	}
	const files = fs.readdirSync(DIR).filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"));
	let uploads = 0;
	let guarded = 0;
	let multi = 0;
	for (const f of files) {
		const scan = scanUploads(fs.readFileSync(path.join(DIR, f), "utf8"));
		uploads += scan.uploads;
		guarded += scan.guarded;
		multi += scan.multi;
	}
	// The quantities are printed because a green line that names none is indistinguishable from a
	// green line produced by a scanner that matched nothing.
	console.log(
		`upload-aggregate: ${files.length} workflow(s), ${uploads} \`actions/upload-artifact\` step(s), ` +
			`${guarded} of them asserting \`if-no-files-found: error\`, ${multi} listing more than one path — ` +
			"and no step is in both sets, so no `error` in this tree is satisfiable by a path other than the one it guards",
	);
}
