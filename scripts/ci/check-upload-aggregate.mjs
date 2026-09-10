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
// whose `with.path` resolves to TWO OR MORE inclusion entries, and whose `with.if-no-files-found`
// is `error`. Reformatting the block, quoting the value or reordering the keys does not dodge it,
// because none of those changes the shape. The fix is one step per artefact, each keeping its own
// `if-no-files-found: error` — the shape `go-floors-rerecord.yml` and `deploy-console.yml` already
// use — or an explicit pre-upload assertion that each specific path is non-empty.
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
//   * Reusable workflows and composite actions are invisible to a line scan, as they are to every
//     other line-based check here.

import fs from "node:fs";
import path from "node:path";

const DIR = ".github/workflows";

/** The action this is about. Matched on the owner/repo, so any `@version` is covered. */
const UPLOAD = /^actions\/upload-artifact@/;

/** A block scalar indicator — `|`, `|-`, `|+`, `>`, `>-`, `>2`, and so on. */
const BLOCK_SCALAR = /^[|>][-+]?\d*$/;

/**
 * Every `actions/upload-artifact` step in one workflow, with its `path:` entries resolved.
 *
 * The step walk is check-workflow-shape.mjs's: a list item whose nearest shallower bare key is
 * `steps`, so `on:`/`paths:`/`with:`/matrix lists are not mistaken for steps. Comment lines are
 * dropped from the step's key list — re-basing one turns `# path: |` into `path: |` — but the
 * `path:` block is then read back from the RAW lines, where a `#` inside a literal block is the
 * content YAML says it is.
 *
 * @param {string} text
 * @returns {{uploads: number, pathKeys: number, guarded: number, multi: number, problems: {line: number, name: string, artifact: string, entries: string[], excludes: string[]}[]}}
 */
export function scanUploads(text) {
	const lines = text.split("\n");
	const jobsAt = lines.findIndex((l) => /^jobs:\s*$/.test(l));
	if (jobsAt === -1) return { uploads: 0, pathKeys: 0, guarded: 0, multi: 0, problems: [] };

	let uploads = 0;
	let pathKeys = 0;
	let guarded = 0;
	let multi = 0;
	const problems = [];

	for (let i = jobsAt + 1; i < lines.length; i++) {
		const item = lines[i].match(/^(\s+)-\s+(\S.*)$/);
		if (item === null) continue;
		const indent = item[1].length;

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

		// The step's own lines, re-based so a top-level key of the step sits at column 0. Each
		// keeps its absolute line number, which is what the `path:` block re-read needs.
		const own = [{ text: item[2], line: i + 1, raw: i }];
		for (let j = i + 1; j < lines.length; j++) {
			if (new RegExp(`^\\s{${indent}}-\\s`).test(lines[j])) break;
			if (lines[j].trim() !== "" && (lines[j].match(/^(\s*)/)?.[1].length ?? 0) <= indent && !/^\s*#/.test(lines[j])) break;
			if (/^\s*#/.test(lines[j])) continue;
			own.push({ text: lines[j].slice(indent + 2), line: j + 1, raw: j });
		}

		const usesAt = own.find((o) => /^uses:\s*\S/.test(o.text));
		if (usesAt === undefined) continue;
		if (!UPLOAD.test(usesAt.text.replace(/^uses:\s*/, "").trim())) continue;
		uploads += 1;

		let name = own.find((o) => /^name:\s*\S/.test(o.text))?.text.replace(/^name:\s*/, "").trim() ?? usesAt.text.trim();

		// The direct children of the step's `with:` — column 2 exactly, so a `path: |` block's own
		// deeper lines cannot be read as keys of it.
		const withIdx = own.findIndex((o) => /^with:\s*$/.test(o.text));
		if (withIdx === -1) continue;
		const withKeys = [];
		for (let k = withIdx + 1; k < own.length; k++) {
			const t = own[k].text;
			if (t.trim() === "") continue;
			if (/^\S/.test(t)) break;
			const m = t.match(/^ {2}([A-Za-z0-9_-]+):\s*(.*)$/);
			if (m !== null) withKeys.push({ key: m[1], value: m[2].trim(), line: own[k].line, raw: own[k].raw });
		}

		const artifact = withKeys.find((w) => w.key === "name")?.value ?? "(unnamed)";
		const pathKey = withKeys.find((w) => w.key === "path");
		const inffKey = withKeys.find((w) => w.key === "if-no-files-found");
		if (pathKey === undefined) continue;
		pathKeys += 1;

		// The entries. A block scalar's are read from the raw lines below the key: everything
		// indented past the key's own column, up to the next line that is not.
		let entries = [];
		if (pathKey.value === "" || BLOCK_SCALAR.test(pathKey.value)) {
			const col = lines[pathKey.raw].match(/^(\s*)/)?.[1].length ?? 0;
			for (let r = pathKey.raw + 1; r < lines.length; r++) {
				if (lines[r].trim() === "") continue;
				if ((lines[r].match(/^(\s*)/)?.[1].length ?? 0) <= col) break;
				entries.push(lines[r].trim());
			}
		} else {
			entries = [pathKey.value.replace(/^['"]|['"]$/g, "")];
		}

		const excludes = entries.filter((e) => e.startsWith("!"));
		const includes = entries.filter((e) => !e.startsWith("!"));
		if (includes.length > 1) multi += 1;

		const inff = inffKey?.value.replace(/^['"]|['"]$/g, "");
		if (inff === "error") guarded += 1;
		if (inff !== "error" || includes.length < 2) continue;

		problems.push({ line: pathKey.line, name, artifact, entries: includes, excludes });
	}

	return { uploads, pathKeys, guarded, multi, problems };
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
	// ci.yml's `ui-audit` and release-gate.yml's per-project report, in shape.
	const UI_AUDIT =
		"      - name: Upload the audit report\n" +
		"        uses: actions/upload-artifact@v7\n" +
		"        with:\n" +
		"          name: ui-audit\n" +
		"          path: |\n" +
		"            apps/console/playwright-report/\n" +
		"            apps/console/test-results/ui-audit*.json\n" +
		"          retention-days: 14\n";
	ok("the two deliberate multi-path uploads in this repo are clean", scan(UI_AUDIT).problems.length === 0, JSON.stringify(scan(UI_AUDIT).problems));

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
