#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
//
// The ONE reader for "which commit of each starter template was last green-proven" (#5411, epic
// #2766, unit 1).
//
// "Proven" is a fact about ONE commit. The starter repos move, and the console hands a user each
// template at HEAD — so a proof bundle that says PASS says nothing about today's HEAD unless
// something compares the two. This module answers the first half of that comparison and nothing
// else: per template, the commit the newest PASS bundle under
// `demos/proofs/templates/<template>/<timestamp>/template-summary.json` was proven on.
//
//   node scripts/lib/template-proofs.mjs                     # the three entries, as JSON
//   node scripts/lib/template-proofs.mjs --json              # the same, said out loud
//   node scripts/lib/template-proofs.mjs --self-test         # fixtures + the mutation control
//   node scripts/lib/template-proofs.mjs --mutation-control  # the self-test with one commit
//                                                            # edited — MUST exit non-zero
//   node scripts/lib/template-proofs.mjs --help
//
// Exit codes: 0 success · 1 a read raised, or a self-test assertion failed · 2 bad arguments.
// Do NOT pipe it: `… | jq` reports jq's exit code, and every raise below becomes invisible.
//
// ── WHAT IS READ, AND WHAT IS DELIBERATELY NOT ───────────────────────────────────────────────
//
// · The proven sha is the summary's `commit` field. NOT `ref`: every bundle on dev records
//   `"ref": "HEAD"`, which names a moving pointer, not a commit — reading it would report "proven
//   at HEAD" forever, which is the exact claim the drift check exists to stop making.
// · "Newest" is the bundle directory's timestamp name (`YYYYMMDDTHHMMSSZ`, UTC, fixed width), so
//   lexical order IS chronological order. Not the file's mtime: a checkout rewrites every mtime.
// · A FAIL bundle newer than a PASS one is skipped — the reader answers "last GREEN-proven".
//   NOTE: no producer writes a FAIL bundle today. `scripts/e2e/commit-proof.sh` files a template
//   under `demos/proofs/templates/<t>/` ONLY when that template's own verdict is PASS, so every
//   bundle on dev is a PASS. The FAIL handling here (and its fixtures) is for a bundle filed by
//   hand or by a future producer — it is not evidence that FAIL bundles exist.
// · No network. This reads the working tree only; comparing against the starter repo's live HEAD
//   is a different unit (#2766 unit 2), and a network call here would make every caller flaky.
// · Three templates, `apps`, `chart`, `ai`. Alibaba is not a template and is not added (#5411).
//
// ── WHY IT RAISES INSTEAD OF OMITTING ────────────────────────────────────────────────────────
//
// A drift check built on a reader that returns `{}` for "no bundles" reports "no drift" over zero
// templates — a clean bill of health that measured nothing. So every way this can fail to produce
// an entry is a THROW, never an absent key:
//
//   · the proofs root, or one template's directory, is missing
//   · a template has no bundle, or no bundle whose `verdict` is `PASS`
//   · a bundle directory has no `template-summary.json`, or it is not JSON
//   · a summary's `verdict` is neither PASS nor FAIL, its `template` names another template, its
//     `commit` is not a 40-hex sha, or its `repo` is not an https URL
//   · an entry under a template directory is not a timestamp-named bundle directory, or a
//     directory under the proofs root is not one of the three templates — an unrecognised entry
//     silently skipped is how a renamed bundle stops being read and nobody notices. A DOTFILE
//     (`.DS_Store`, left by macOS Finder) is refused the same way — it is still an entry nobody
//     filed as a proof — but the error names it as a dotfile, so the fix is "delete it", not a hunt
//     for a misnamed bundle.
//
// Every summary in a template's directory is parsed and validated, not only the newest PASS one:
// a malformed OLD bundle is still a malformed bundle, and validating only the winner would let a
// bad file sit until the day it became the winner.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** The starter templates this reader answers for, in a fixed order. */
export const TEMPLATES = Object.freeze(["apps", "chart", "ai"]);

/** The proofs root, relative to the repo root. */
export const PROOFS_DIR = path.join("demos", "proofs", "templates");

/** The summary file every bundle carries. */
export const SUMMARY_FILE = "template-summary.json";

const BUNDLE_NAME = /^\d{8}T\d{6}Z$/;
const SHA = /^[0-9a-f]{40}$/;

/**
 * The cause clause for an unexpected directory entry: a dotfile is named as one, because the
 * likeliest source (`.DS_Store`) is fixed by deleting it, not by renaming a bundle.
 *
 * @param {string} name  the entry's base name
 * @returns {string}  "" for an ordinary name, else a parenthesised cause
 */
function dotfileCause(name) {
	return name.startsWith(".") ? ` (a dotfile${name === ".DS_Store" ? " left by macOS Finder" : ""} — delete it; it is not a proof)` : "";
}

/** The repo root this module lives in (`scripts/lib/` → two levels up). */
function defaultRoot() {
	return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
}

/**
 * Read and validate one bundle's summary.
 *
 * @param {string} file      absolute path of the `template-summary.json`
 * @param {string} template  the template directory it was found under
 * @returns {{repo: string, commit: string, verdict: "PASS"|"FAIL"}}
 */
function readSummary(file, template) {
	if (!existsSync(file)) throw new Error(`template-proofs: ${file} is missing — every bundle must carry ${SUMMARY_FILE}`);
	/** @type {unknown} */
	let parsed;
	try {
		parsed = JSON.parse(readFileSync(file, "utf8"));
	} catch (err) {
		throw new Error(`template-proofs: ${file} is not valid JSON (${err instanceof Error ? err.message : String(err)})`);
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error(`template-proofs: ${file} is not a JSON object`);
	}
	const { verdict, template: named, commit, repo } = /** @type {Record<string, unknown>} */ (parsed);
	if (verdict !== "PASS" && verdict !== "FAIL") {
		throw new Error(`template-proofs: ${file} has verdict ${JSON.stringify(verdict)}; expected "PASS" or "FAIL"`);
	}
	if (named !== template) {
		throw new Error(`template-proofs: ${file} names template ${JSON.stringify(named)} but sits under ${template}/`);
	}
	if (typeof commit !== "string" || !SHA.test(commit)) {
		throw new Error(`template-proofs: ${file} has commit ${JSON.stringify(commit)}; expected a 40-hex sha (\`ref\` is not read — it is "HEAD")`);
	}
	if (typeof repo !== "string" || !/^https:\/\/\S+$/.test(repo)) {
		throw new Error(`template-proofs: ${file} has repo ${JSON.stringify(repo)}; expected an https URL`);
	}
	return { repo, commit, verdict };
}

/**
 * Return, per starter template, the commit it was last green-proven on.
 *
 * Reads only the local tree under `<root>/demos/proofs/templates`; never the network. Throws on
 * any template it cannot answer for — see the header for the full list — so the result always has
 * exactly the keys in `TEMPLATES`.
 *
 * @param {{root?: string}} [opts]  `root` is the repo root (defaults to this checkout's)
 * @returns {Record<"apps"|"chart"|"ai", {repo: string, provenCommit: string, bundle: string, verdict: "PASS"}>}
 *          `bundle` is the bundle directory, relative to `root`, with `/` separators
 */
export function readTemplateProofs(opts = {}) {
	const root = opts.root ?? defaultRoot();
	const proofsRoot = path.join(root, PROOFS_DIR);
	if (!existsSync(proofsRoot) || !statSync(proofsRoot).isDirectory()) {
		throw new Error(`template-proofs: ${proofsRoot} does not exist — no template has ever been proven here`);
	}
	for (const entry of readdirSync(proofsRoot).sort()) {
		if (!TEMPLATES.includes(entry)) {
			throw new Error(`template-proofs: ${path.join(proofsRoot, entry)} is not one of the templates (${TEMPLATES.join(", ")})${dotfileCause(entry)}`);
		}
	}

	/** @type {Record<string, {repo: string, provenCommit: string, bundle: string, verdict: "PASS"}>} */
	const out = {};
	for (const template of TEMPLATES) {
		const dir = path.join(proofsRoot, template);
		if (!existsSync(dir) || !statSync(dir).isDirectory()) {
			throw new Error(`template-proofs: ${template} has no proof directory (${dir})`);
		}
		const bundles = readdirSync(dir).sort();
		if (bundles.length === 0) throw new Error(`template-proofs: ${template} has no proof bundle under ${dir}`);
		/** @type {{name: string, summary: {repo: string, commit: string, verdict: "PASS"|"FAIL"}}[]} */
		const read = [];
		for (const name of bundles) {
			const full = path.join(dir, name);
			if (!BUNDLE_NAME.test(name) || !statSync(full).isDirectory()) {
				throw new Error(`template-proofs: ${full} is not a timestamp-named bundle directory (YYYYMMDDTHHMMSSZ)${dotfileCause(name)}`);
			}
			read.push({ name, summary: readSummary(path.join(full, SUMMARY_FILE), template) });
		}
		// Fixed-width UTC timestamps: lexical order is chronological, so the last PASS is the newest.
		const newestPass = read.filter((b) => b.summary.verdict === "PASS").at(-1);
		if (newestPass === undefined) {
			throw new Error(`template-proofs: ${template} has ${read.length} bundle(s) and none with verdict PASS — it has never been green-proven`);
		}
		out[template] = {
			repo: newestPass.summary.repo,
			provenCommit: newestPass.summary.commit,
			bundle: [...PROOFS_DIR.split(path.sep), template, newestPass.name].join("/"),
			verdict: "PASS",
		};
	}
	return /** @type {Record<"apps"|"chart"|"ai", {repo: string, provenCommit: string, bundle: string, verdict: "PASS"}>} */ (out);
}

// ── CLI argument parsing ─────────────────────────────────────────────────────────────────────

/** What the CLI does, printed for `--help` and after a refused argument. */
export const USAGE = [
	"Usage: node scripts/lib/template-proofs.mjs [--json|--self-test|--mutation-control|--help]",
	"",
	"  (no argument)       print each template's last green-proven commit as JSON",
	"  --json              the same, said out loud",
	"  --self-test         run the fixture suite (and the mutation control); exit 1 on any failure",
	"  --mutation-control  the self-test with one fixture commit edited; MUST exit 1",
	"  --help, -h          this text",
].join("\n");

/**
 * The whole argument parser. An unrecognised argument is an error (exit 2), never a fall-through
 * to the JSON — a typo that prints a valid answer and exits 0 is a silent success.
 *
 * @param {string[]} argv  arguments after the script name
 * @returns {{mode: "json"|"self-test"|"mutation-control"|"help", error: null} | {mode: null, error: string}}
 */
export function parseCliArgs(argv) {
	/** @type {Record<string, "json"|"self-test"|"mutation-control"|"help">} */
	const MODES = {
		"--json": "json",
		"--self-test": "self-test",
		"--mutation-control": "mutation-control",
		"--help": "help",
		"-h": "help",
	};
	if (argv.length === 0) return { mode: "json", error: null };
	// Object.hasOwn, not `in`: `in` walks the prototype, so `constructor` / `toString` would pass as
	// modes and fall through to an undefined one.
	const unknown = argv.filter((a) => !Object.hasOwn(MODES, a));
	if (unknown.length > 0) return { mode: null, error: `unrecognised argument${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")}` };
	if (argv.some((a) => MODES[a] === "help")) return { mode: "help", error: null };
	const distinct = [...new Set(argv.map((a) => MODES[a]))];
	if (distinct.length > 1) return { mode: null, error: `${distinct.join(" and ")} cannot both be asked for` };
	return { mode: distinct[0], error: null };
}

// ── self-test ────────────────────────────────────────────────────────────────────────────────
// Fixtures over a real temporary tree, not mocks: what is under test is directory ordering and
// file parsing, and a mocked `readdirSync` would prove only that the mock agrees with itself.

const SHA_OLD = "1".repeat(40);
const SHA_NEW = "2".repeat(40);
const SHA_FAIL = "3".repeat(40);
const SHA_EDITED = "e".repeat(40);

/**
 * Write one fixture bundle's summary.
 *
 * @param {string} root      the fixture repo root
 * @param {string} template  template directory
 * @param {string} name      bundle directory name
 * @param {string|object} body  the summary (an object is serialised; a string is written raw)
 */
function putBundle(root, template, name, body) {
	const dir = path.join(root, PROOFS_DIR, template, name);
	mkdirSync(dir, { recursive: true });
	writeFileSync(path.join(dir, SUMMARY_FILE), typeof body === "string" ? body : JSON.stringify(body));
}

/**
 * A summary in the shape the real bundles carry (`ref: "HEAD"` included, so a reader that took
 * `ref` would fail the sha check).
 *
 * @param {string} template
 * @param {string} commit
 * @param {"PASS"|"FAIL"} verdict
 */
function summary(template, commit, verdict) {
	return { template, repo: `https://github.com/alethialabs-io/alethia-starter-${template}`, ref: "HEAD", commit, verdict };
}

/**
 * Build a fresh fixture tree where all three templates are answerable.
 *
 * `apps` has an older PASS, a newer PASS and a newest FAIL — so the expected answer (SHA_NEW from
 * the MIDDLE bundle) is wrong both for "first bundle" and for "newest bundle regardless of verdict".
 * Bundle names are written out of order so creation order cannot stand in for the sort.
 *
 * @param {boolean} mutate  the mutation control: edit the winning bundle's commit after writing
 * @returns {string} the fixture root
 */
function goodTree(mutate) {
	const root = mkdtempSync(path.join(tmpdir(), "template-proofs-"));
	putBundle(root, "apps", "20261001T200301Z", summary("apps", SHA_NEW, "PASS"));
	putBundle(root, "apps", "20260901T000000Z", summary("apps", SHA_OLD, "PASS"));
	putBundle(root, "apps", "20261002T120000Z", summary("apps", SHA_FAIL, "FAIL"));
	putBundle(root, "chart", "20261001T200301Z", summary("chart", SHA_NEW, "PASS"));
	putBundle(root, "ai", "20261001T200301Z", summary("ai", SHA_NEW, "PASS"));
	if (mutate) {
		// THE MUTATION CONTROL. Edit the commit of the bundle the reader must pick. The assertions
		// below expect SHA_NEW, so a self-test whose assertions really discriminate goes red here.
		putBundle(root, "apps", "20261001T200301Z", summary("apps", SHA_EDITED, "PASS"));
	}
	return root;
}

/**
 * Run the fixture suite. Returns the exit code: 0 all passed, 1 any failure.
 *
 * @param {{mutate: boolean}} opts  `mutate` runs it as the mutation control (which must fail)
 * @returns {number}
 */
function selfTest({ mutate }) {
	let failures = 0;
	/** @type {string[]} */
	const roots = [];
	const ok = (/** @type {string} */ label, /** @type {boolean} */ cond) => {
		console.log(`${cond ? "ok  " : "FAIL"} - ${label}`);
		if (!cond) failures++;
	};
	const raises = (/** @type {string} */ label, /** @type {() => unknown} */ fn, /** @type {string} */ needle) => {
		try {
			fn();
			console.log(`FAIL - ${label} (did not raise)`);
			failures++;
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			const hit = msg.includes(needle);
			console.log(`${hit ? "ok  " : "FAIL"} - ${label}${hit ? "" : ` (wrong message: ${msg})`}`);
			if (!hit) failures++;
		}
	};
	const tree = (/** @type {boolean} */ m) => {
		const r = goodTree(m);
		roots.push(r);
		return r;
	};

	try {
		if (mutate) console.log("# MUTATION CONTROL: the winning apps bundle's commit is edited — this run MUST fail");

		// ── the happy path ──
		const root = tree(mutate);
		const got = readTemplateProofs({ root });
		ok("exactly the three templates, in order", JSON.stringify(Object.keys(got)) === JSON.stringify(["apps", "chart", "ai"]));
		ok("the newest PASS bundle wins (apps → the 2026-10-01 bundle's commit)", got.apps.provenCommit === SHA_NEW);
		ok("…not the oldest PASS", got.apps.provenCommit !== SHA_OLD);
		ok("a newer FAIL bundle is skipped", got.apps.provenCommit !== SHA_FAIL && got.apps.bundle.endsWith("/20261001T200301Z"));
		ok("bundle is repo-relative with / separators", got.apps.bundle === "demos/proofs/templates/apps/20261001T200301Z");
		ok("repo is read from the summary", got.chart.repo === "https://github.com/alethialabs-io/alethia-starter-chart");
		ok("verdict is PASS", got.ai.verdict === "PASS" && got.ai.provenCommit === SHA_NEW);
		ok(
			"each entry carries exactly {repo, provenCommit, bundle, verdict}",
			Object.values(got).every((e) => JSON.stringify(Object.keys(e).sort()) === JSON.stringify(["bundle", "provenCommit", "repo", "verdict"])),
		);

		// ── every failure is a throw, never an absent entry ──
		{
			const r = tree(false);
			rmSync(path.join(r, PROOFS_DIR, "chart"), { recursive: true });
			raises("a template with no directory throws", () => readTemplateProofs({ root: r }), "chart has no proof directory");
		}
		{
			const r = tree(false);
			rmSync(path.join(r, PROOFS_DIR, "chart", "20261001T200301Z"), { recursive: true });
			raises("a template with no bundle throws", () => readTemplateProofs({ root: r }), "chart has no proof bundle");
		}
		{
			const r = tree(false);
			putBundle(r, "ai", "20261001T200301Z", summary("ai", SHA_NEW, "FAIL"));
			raises("a template with only FAIL bundles throws", () => readTemplateProofs({ root: r }), "none with verdict PASS");
		}
		{
			const r = tree(false);
			putBundle(r, "apps", "20260801T000000Z", '{"verdict": "PASS", ');
			raises("malformed JSON throws — even in an OLD bundle that would not win", () => readTemplateProofs({ root: r }), "is not valid JSON");
		}
		{
			const r = tree(false);
			putBundle(r, "chart", "20261001T200301Z", "[]");
			raises("a JSON array summary throws", () => readTemplateProofs({ root: r }), "is not a JSON object");
		}
		{
			const r = tree(false);
			mkdirSync(path.join(r, PROOFS_DIR, "chart", "20261003T000000Z"));
			raises("a bundle with no summary file throws", () => readTemplateProofs({ root: r }), "is missing");
		}
		{
			const r = tree(false);
			putBundle(r, "chart", "20261001T200301Z", { ...summary("chart", SHA_NEW, "PASS"), commit: "HEAD" });
			raises("a non-sha commit throws (the `ref` value, \"HEAD\", is not a commit)", () => readTemplateProofs({ root: r }), "expected a 40-hex sha");
		}
		{
			const r = tree(false);
			putBundle(r, "chart", "20261001T200301Z", summary("chart", SHA_NEW, /** @type {"PASS"} */ (/** @type {unknown} */ ("GREEN"))));
			raises("an unknown verdict throws", () => readTemplateProofs({ root: r }), 'expected "PASS" or "FAIL"');
		}
		{
			const r = tree(false);
			putBundle(r, "chart", "20261001T200301Z", summary("apps", SHA_NEW, "PASS"));
			raises("a summary naming another template throws", () => readTemplateProofs({ root: r }), "but sits under chart/");
		}
		{
			const r = tree(false);
			putBundle(r, "chart", "20261001T200301Z", { ...summary("chart", SHA_NEW, "PASS"), repo: "" });
			raises("a missing repo throws", () => readTemplateProofs({ root: r }), "expected an https URL");
		}
		{
			const r = tree(false);
			putBundle(r, "chart", "latest", summary("chart", SHA_NEW, "PASS"));
			raises("a non-timestamp bundle name throws", () => readTemplateProofs({ root: r }), "not a timestamp-named bundle directory");
		}
		{
			const r = tree(false);
			putBundle(r, "alibaba", "20261001T200301Z", summary("alibaba", SHA_NEW, "PASS"));
			raises("an unknown template directory throws (alibaba is not a template)", () => readTemplateProofs({ root: r }), "is not one of the templates");
		}
		{
			const r = tree(false);
			writeFileSync(path.join(r, PROOFS_DIR, "chart", ".DS_Store"), "");
			raises("a .DS_Store in a template directory throws, and names itself a dotfile", () => readTemplateProofs({ root: r }), "a dotfile left by macOS Finder");
		}
		{
			const r = tree(false);
			writeFileSync(path.join(r, PROOFS_DIR, ".DS_Store"), "");
			raises("a .DS_Store under the proofs root throws, and names itself a dotfile", () => readTemplateProofs({ root: r }), "a dotfile left by macOS Finder");
		}
		{
			const r = mkdtempSync(path.join(tmpdir(), "template-proofs-empty-"));
			roots.push(r);
			raises("a missing proofs root throws", () => readTemplateProofs({ root: r }), "does not exist");
		}

		// ── the real tree: shape only. The shas are NOT pinned here — a pin would be a fixture
		// derived from today's value and would go red on the next legitimate proof run. ──
		const real = readTemplateProofs();
		ok("the real tree answers for all three templates", TEMPLATES.every((t) => real[t] !== undefined && SHA.test(real[t].provenCommit)));

		// ── the CLI parser ──
		ok("no argument is JSON", parseCliArgs([]).mode === "json");
		ok("--self-test is a mode", parseCliArgs(["--self-test"]).mode === "self-test");
		ok("--mutation-control is a mode", parseCliArgs(["--mutation-control"]).mode === "mutation-control");
		ok("an unknown argument is refused", parseCliArgs(["--jsn"]).error !== null);
		ok("two modes are refused", parseCliArgs(["--json", "--self-test"]).error !== null);
		ok("a prototype key (`constructor`) is refused by the parser", parseCliArgs(["constructor"]).error !== null);
		ok("…and by the CLI, with exit 2", spawnSync(process.execPath, [fileURLToPath(import.meta.url), "constructor"], { encoding: "utf8" }).status === 2);
		ok("USAGE names every flag", ["--json", "--self-test", "--mutation-control", "--help"].every((f) => USAGE.includes(f)));

		// ── the mutation control, judged by its EXIT CODE ──
		// Run in a child process so the verdict is the child's exit status, not text this process
		// printed. Skipped inside the control itself, which would otherwise recurse.
		if (!mutate) {
			const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), "--mutation-control"], { encoding: "utf8" });
			ok(`the mutation control (an edited commit) exits 1 — got ${child.status}`, child.status === 1);
			ok("…and it failed on the newest-bundle assertion, not on something incidental", /FAIL - the newest PASS bundle wins/.test(child.stdout));
		}
	} finally {
		for (const r of roots) rmSync(r, { recursive: true, force: true });
	}

	console.log(failures === 0 ? "\nself-test: all passed" : `\nself-test: ${failures} FAILED`);
	return failures === 0 ? 0 : 1;
}

// ── CLI ──────────────────────────────────────────────────────────────────────────────────────
const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
	const parsed = parseCliArgs(process.argv.slice(2));
	if (parsed.error !== null) {
		console.error(`template-proofs: ${parsed.error}\n\n${USAGE}`);
		process.exit(2);
	}
	if (parsed.mode === "help") {
		console.log(USAGE);
		process.exit(0);
	}
	if (parsed.mode === "self-test" || parsed.mode === "mutation-control") {
		// A throw is a failing self-test, not a crash: report it as the verdict this mode produces.
		try {
			process.exit(selfTest({ mutate: parsed.mode === "mutation-control" }));
		} catch (err) {
			console.error(`\nFAIL - the self-test raised before it could report: ${err instanceof Error ? err.message : String(err)}`);
			console.error("self-test: 1 FAILED");
			process.exit(1);
		}
	}
	try {
		console.log(JSON.stringify(readTemplateProofs(), null, 2));
	} catch (err) {
		console.error(err instanceof Error ? err.message : String(err));
		process.exit(1);
	}
}
