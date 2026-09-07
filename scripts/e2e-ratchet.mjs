#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
//
// THE RELEASE GATE IS GREEN-BY-RATCHET, AND THIS IS THE RATCHET.
//
// The browser suites the gate runs were 39% green when it was built (apps/console/docs/qa/
// findings.md, 2026-09-02: 136 pass / 192 fail / 17 never ran). An absolute-green requirement
// would have blocked every promotion for weeks, so the gate could not have been REQUIRED on day
// one — and a gate that is not required is a gate people learn to read past. Instead every leg
// fails on REGRESSION against a committed baseline: the repo's own pattern for a measurement that
// is allowed to be red while it is being worked through (`ui-conformance-live.json`,
// `required-checks-divergence.json` — shrink-only, captured before the fix, moved in the same PR
// as the code).
//
//   node scripts/e2e-ratchet.mjs --project=<name> --results=<playwright json> [--baseline=<file>]
//   node scripts/e2e-ratchet.mjs --project=<name> --results=<json> --write [--only=<spec file>]...
//   node scripts/e2e-ratchet.mjs --self-test
//
// The results file is Playwright's `json` reporter output (`--reporter=json`, or
// PLAYWRIGHT_JSON_OUTPUT_NAME). The baseline is `apps/console/e2e/gate-baseline.json`.
//
// ── THE RULES, each with a fixture in BOTH directions in --self-test ──────────────────────────
//
//   1. baseline `passed`, now not passed          → FAIL   a regression
//   2. a test the baseline does not know           → must be `passed`, else FAIL
//   3. baseline `failed`, now passing              → FAIL   "regenerate with --write --only=<file>"
//                                                    (shrink-only: the ledger never overstates debt,
//                                                    and the fix and the ledger move in one PR)
//   4. baseline names a test the run lacks         → FAIL   a stale record, or a renamed test
//   5. `skipped` in CI                             → FAIL   unless it is a `fixme` whose description
//                                                    matches /^BUG: .+#\d+/ AND the baseline carries
//                                                    that fixme. `test.skip` is never accepted in
//                                                    CI. This is the anti-`HAVE_MEMBER` rule at the
//                                                    ledger: an unset variable used to turn every
//                                                    RBAC denial into a green skip for two months.
//   6. fewer tests than the baseline counts         → FAIL   found-nothing is not nothing-wrong
//   7. `flaky` (passed on retry)                    → counts as passed, and is LISTED
//   8. a `bootstrap: true` baseline                 → FAIL   the baseline was never captured; a
//                                                    gate that passes on an empty ledger is vacuous
//
// --write regenerates a project's entries from a results file. With --only=<file> it replaces only
// that file's entries, so two lanes regenerating at once produce diffs that touch their own files.
// A `skipped` test with no BUG fixme cannot be baselined: it is refused, not recorded.
//
// Do NOT pipe this into `tail`/`head`: a pipe reports the exit code of the LAST command in it.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const DEFAULT_BASELINE = "apps/console/e2e/gate-baseline.json";
export const FIXME_RE = /^BUG: .+#\d+/;

// ── Playwright JSON → { file → { test → outcome } } ──────────────────────────────────────────

/**
 * @typedef {{status: "passed"|"failed"|"flaky"|"skipped", fixme: string|null}} Outcome
 * @typedef {Record<string, Record<string, Outcome>>} ProjectRun
 */

/**
 * Flatten one project's tests out of a Playwright JSON report.
 *
 * Keys are the spec file relative to the test dir (the root suite's title) and the test's title
 * path below it joined with " › " — the same identity the html report shows.
 *
 * @param {unknown} report parsed JSON reporter output
 * @param {string} project
 * @returns {ProjectRun}
 */
export function flattenResults(report, project) {
	if (typeof report !== "object" || report === null || !Array.isArray(report.suites)) {
		throw new Error("results: not a Playwright JSON report (no `suites` array). Was the json reporter enabled?");
	}
	/** @type {ProjectRun} */
	const out = {};
	let seen = 0;
	const walk = (suite, file, titles) => {
		for (const spec of suite.specs ?? []) {
			for (const t of spec.tests ?? []) {
				if (t.projectName !== project) continue;
				seen++;
				const key = [...titles, spec.title].join(" › ");
				const fixme = (t.annotations ?? []).find((a) => a && a.type === "fixme");
				const status =
					t.status === "expected" ? "passed" : t.status === "flaky" ? "flaky" : t.status === "unexpected" ? "failed" : "skipped";
				(out[file] ??= {})[key] = { status, fixme: fixme && typeof fixme.description === "string" ? fixme.description : null };
			}
		}
		for (const child of suite.suites ?? []) walk(child, file, [...titles, child.title]);
	};
	for (const root of report.suites) walk(root, root.file ?? root.title, []);
	if (seen === 0) {
		throw new Error(`results: no tests for project "${project}". A run that measured nothing must not ratchet as clean.`);
	}
	return out;
}

// ── The comparison ───────────────────────────────────────────────────────────────────────────

/**
 * @typedef {"passed"|"failed"|{fixme: string}} Recorded
 * @typedef {Record<string, Record<string, Recorded>>} ProjectBaseline
 */

/**
 * Compare one project's run with its baseline. Returns the failures and a per-file summary.
 *
 * @param {{baseline: ProjectBaseline|undefined, run: ProjectRun, ci: boolean, bootstrap: boolean, project: string}} args
 */
export function compareProject({ baseline, run, ci, bootstrap, project }) {
	/** @type {string[]} */
	const failures = [];
	/** @type {Record<string, {passed: number, failed: number, flaky: number, fixme: number, skipped: number, newTests: number, regressions: number, nowPassing: number}>} */
	const perFile = {};
	const row = (file) =>
		(perFile[file] ??= { passed: 0, failed: 0, flaky: 0, fixme: 0, skipped: 0, newTests: 0, regressions: 0, nowPassing: 0 });

	if (bootstrap) {
		failures.push(
			`${DEFAULT_BASELINE} is still the bootstrap placeholder — no baseline has been captured for "${project}". ` +
				`Run the gate once and commit \`node scripts/e2e-ratchet.mjs --project=${project} --results=<json> --write\`. ` +
				"A gate that passes against an empty ledger is vacuous, so this is a failure, not a pass.",
		);
	}
	const base = baseline ?? {};

	let runCount = 0;
	for (const [file, tests] of Object.entries(run)) {
		for (const [title, outcome] of Object.entries(tests)) {
			runCount++;
			const r = row(file);
			const known = base[file]?.[title];
			const id = `${file} › ${title}`;
			if (outcome.status === "passed" || outcome.status === "flaky") {
				r.passed++;
				if (outcome.status === "flaky") r.flaky++;
				if (known === undefined) r.newTests++;
				else if (known === "failed" || (typeof known === "object" && known !== null)) {
					r.nowPassing++;
					failures.push(
						`${id}: baseline says ${known === "failed" ? "failed" : "fixme"}, the run says passed. Good — now move the ledger: ` +
							`\`node scripts/e2e-ratchet.mjs --project=${project} --results=<json> --write --only=${file}\` in this PR. ` +
							"The ratchet is shrink-only, so a ledger that overstates debt is as wrong as one that hides it.",
					);
				}
			} else if (outcome.status === "failed") {
				r.failed++;
				if (known === undefined) {
					r.newTests++;
					failures.push(`${id}: a NEW test must pass. It is not in the baseline and it failed.`);
				} else if (known === "passed") {
					r.regressions++;
					failures.push(`${id}: REGRESSION — passed at the baseline, failed now.`);
				} else if (typeof known === "object" && known !== null) {
					r.regressions++;
					failures.push(`${id}: the fixme was lifted (the test ran) but it still fails. Re-mark it, or fix it.`);
				}
				// known === "failed": recorded debt, unchanged.
			} else {
				// skipped
				const fixme = outcome.fixme;
				const isBugFixme = typeof fixme === "string" && FIXME_RE.test(fixme);
				const baselineFixme = typeof known === "object" && known !== null ? known.fixme : null;
				if (isBugFixme && baselineFixme === fixme) {
					r.fixme++;
				} else if (ci) {
					r.skipped++;
					failures.push(
						`${id}: SKIPPED in CI. ` +
							(isBugFixme
								? `Its fixme ("${fixme}") is not in the baseline — regenerate with --write --only=${file}.`
								: fixme
									? `A fixme must read "BUG: <what> #<issue>"; got "${fixme}".`
									: "A plain test.skip is never accepted in CI; an unset variable once turned every RBAC denial into a green skip."),
					);
				} else {
					r.skipped++; // local: reported, not failed
				}
			}
		}
	}

	let baselineCount = 0;
	for (const [file, tests] of Object.entries(base)) {
		for (const title of Object.keys(tests)) {
			baselineCount++;
			if (run[file]?.[title] === undefined) {
				failures.push(`${file} › ${title}: the baseline names a test this run does not contain — a renamed or deleted test. Regenerate with --write --only=${file}.`);
			}
		}
	}
	if (!bootstrap && runCount < baselineCount) {
		failures.push(`the run contains ${runCount} tests for "${project}" and the baseline ${baselineCount}. Fewer tests than the ledger is found-nothing, not nothing-wrong.`);
	}
	return { failures, perFile, runCount, baselineCount };
}

/**
 * The entries `--write` records for a project from a run. Refuses a skip that is not a BUG fixme.
 * @param {ProjectRun} run
 * @returns {ProjectBaseline}
 */
export function toBaseline(run) {
	/** @type {ProjectBaseline} */
	const out = {};
	for (const [file, tests] of Object.entries(run)) {
		for (const [title, o] of Object.entries(tests)) {
			let v;
			if (o.status === "passed" || o.status === "flaky") v = "passed";
			else if (o.status === "failed") v = "failed";
			else if (typeof o.fixme === "string" && FIXME_RE.test(o.fixme)) v = { fixme: o.fixme };
			else {
				throw new Error(
					`${file} › ${title}: skipped with ${o.fixme ? `fixme "${o.fixme}"` : "no fixme"} — cannot be baselined. ` +
						'A skip must be `test.fixme(true, "BUG: <what> #<issue>")` to be recorded as debt.',
				);
			}
			(out[file] ??= {})[title] = v;
		}
	}
	return out;
}

/** A markdown table of per-file deltas, for $GITHUB_STEP_SUMMARY. */
export function stepSummary(project, perFile, failures) {
	const L = [`### Release gate · ${project} · ratchet`, "", "| file | passed | failed | fixme | flaky | new | regressions | now passing |", "|---|--:|--:|--:|--:|--:|--:|--:|"];
	for (const [file, r] of Object.entries(perFile).sort(([a], [b]) => a.localeCompare(b))) {
		L.push(`| \`${file}\` | ${r.passed} | ${r.failed} | ${r.fixme} | ${r.flaky} | ${r.newTests} | ${r.regressions} | ${r.nowPassing} |`);
	}
	L.push("", failures.length === 0 ? "**ratchet: no regression against the baseline.**" : `**ratchet: ${failures.length} problem(s)**`, "");
	for (const f of failures) L.push(`- ${f}`);
	return L.join("\n");
}

// ── CLI ──────────────────────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
	const out = { project: "", results: "", baseline: path.join(ROOT, DEFAULT_BASELINE), write: false, only: [], summary: false, selfTest: false, help: false, unknown: [] };
	for (const a of argv) {
		if (a === "--self-test") out.selfTest = true;
		else if (a === "--write") out.write = true;
		else if (a === "--step-summary") out.summary = true;
		else if (a === "--help" || a === "-h") out.help = true;
		else if (a.startsWith("--project=")) out.project = a.slice("--project=".length);
		else if (a.startsWith("--results=")) out.results = a.slice("--results=".length);
		else if (a.startsWith("--baseline=")) out.baseline = path.resolve(a.slice("--baseline=".length));
		else if (a.startsWith("--only=")) out.only.push(a.slice("--only=".length));
		else out.unknown.push(a);
	}
	return out;
}

const USAGE = [
	"usage:",
	"  node scripts/e2e-ratchet.mjs --project=<name> --results=<playwright json> [--baseline=<file>] [--step-summary]",
	"  node scripts/e2e-ratchet.mjs --project=<name> --results=<json> --write [--only=<spec file>]... [--baseline=<file>]",
	"  node scripts/e2e-ratchet.mjs --self-test",
].join("\n");

function readJson(file, what) {
	if (!fs.existsSync(file)) throw new Error(`${what}: ${file} does not exist.`);
	return JSON.parse(fs.readFileSync(file, "utf8"));
}

function main(argv) {
	const args = parseArgs(argv);
	if (args.unknown.length) {
		console.error(`e2e-ratchet: unrecognised argument(s): ${args.unknown.join(", ")}\n${USAGE}`);
		return 2;
	}
	if (args.help) {
		console.log(USAGE);
		return 0;
	}
	if (args.selfTest) return selfTest();
	if (!args.project || !args.results) {
		console.error(`e2e-ratchet: --project and --results are required.\n${USAGE}`);
		return 2;
	}
	const report = readJson(args.results, "results");
	const run = flattenResults(report, args.project);
	const baselineDoc = fs.existsSync(args.baseline)
		? readJson(args.baseline, "baseline")
		: { version: 1, bootstrap: true, projects: {} };
	if (typeof baselineDoc !== "object" || baselineDoc === null || typeof baselineDoc.projects !== "object") {
		throw new Error(`baseline: ${args.baseline} has no \`projects\` object.`);
	}

	if (args.write) {
		const fresh = toBaseline(run);
		const current = baselineDoc.projects[args.project] ?? {};
		let next;
		if (args.only.length) {
			next = { ...current };
			for (const file of args.only) {
				if (!(file in fresh)) throw new Error(`--only=${file}: the run holds no tests for that file under project "${args.project}".`);
				next[file] = fresh[file];
			}
		} else next = fresh;
		baselineDoc.projects[args.project] = Object.fromEntries(Object.entries(next).sort(([a], [b]) => a.localeCompare(b)));
		delete baselineDoc.bootstrap;
		baselineDoc.version = 1;
		baselineDoc.$comment = BASELINE_COMMENT;
		fs.writeFileSync(args.baseline, `${JSON.stringify(baselineDoc, null, "\t")}\n`);
		const n = Object.values(baselineDoc.projects[args.project]).reduce((s, t) => s + Object.keys(t).length, 0);
		console.log(`e2e-ratchet: wrote ${n} entries for "${args.project}" to ${path.relative(ROOT, args.baseline)}${args.only.length ? ` (only: ${args.only.join(", ")})` : ""}`);
		return 0;
	}

	const { failures, perFile } = compareProject({
		baseline: baselineDoc.projects[args.project],
		run,
		ci: Boolean(process.env.CI),
		bootstrap: Boolean(baselineDoc.bootstrap) || baselineDoc.projects[args.project] === undefined,
		project: args.project,
	});
	if (args.summary) console.log(stepSummary(args.project, perFile, failures));
	else for (const f of failures) console.error(`::error::${f}`);
	if (failures.length === 0) console.log(`e2e-ratchet: ${args.project} — no regression against the baseline.`);
	return failures.length === 0 ? 0 : 1;
}

const BASELINE_COMMENT = [
	"The release gate's ratchet — apps/console/e2e/gate-baseline.json. GENERATED by scripts/e2e-ratchet.mjs --write; never hand-edited.",
	"One entry per (project, spec file, test): passed | failed | {fixme: 'BUG: … #n'}. The gate fails on any regression against",
	"this file, on a new test that does not pass, on a skip that is not a BUG fixme, and on a test that starts passing while",
	"still recorded as failed — shrink-only, so a fix and the ledger move in one PR (--write --only=<file>).",
];

// ── self-test ────────────────────────────────────────────────────────────────────────────────

function selfTest() {
	let failures = 0;
	const ok = (label, cond) => {
		console.log(`${cond ? "ok  " : "FAIL"} - ${label}`);
		if (!cond) failures++;
	};
	const has = (list, re) => list.some((f) => re.test(f));

	// A report in the JSON reporter's shape: one file with a describe, tests in two projects.
	const test = (title, projectName, status, annotations = []) => ({ title, tests: [{ projectName, status, annotations }] });
	const report = {
		suites: [
			{
				title: "flows/a.spec.ts",
				file: "flows/a.spec.ts",
				specs: [test("top", "qa", "expected")],
				suites: [
					{
						title: "A — journey",
						specs: [
							test("passes", "qa", "expected"),
							test("fails", "qa", "unexpected"),
							test("flakes", "qa", "flaky"),
							test("fixme", "qa", "skipped", [{ type: "fixme", description: "BUG: the thing #123" }]),
							test("other project", "hero", "expected"),
						],
					},
				],
			},
		],
	};
	const run = flattenResults(report, "qa");
	ok("only the named project's tests are read", Object.keys(run["flows/a.spec.ts"]).length === 5);
	ok("titles are path-joined below the file", "A — journey › fails" in run["flows/a.spec.ts"]);
	ok("a fixme annotation is carried", run["flows/a.spec.ts"]["A — journey › fixme"].fixme === "BUG: the thing #123");
	ok("a report with no tests for the project raises", (() => { try { flattenResults(report, "nope"); return false; } catch { return true; } })());
	ok("a non-report raises", (() => { try { flattenResults({}, "qa"); return false; } catch { return true; } })());

	const baseline = toBaseline(run);
	ok("--write records passed/failed/fixme", baseline["flows/a.spec.ts"]["A — journey › fails"] === "failed" && baseline["flows/a.spec.ts"]["A — journey › flakes"] === "passed" && typeof baseline["flows/a.spec.ts"]["A — journey › fixme"] === "object");
	ok(
		"--write refuses a plain skip",
		(() => {
			try {
				toBaseline({ f: { t: { status: "skipped", fixme: null } } });
				return false;
			} catch {
				return true;
			}
		})(),
	);

	const cmp = (mut = (r) => r, b = baseline, ci = true, bootstrap = false) =>
		compareProject({ baseline: b, run: mut(structuredClone(run)), ci, bootstrap, project: "qa" });
	const F = "flows/a.spec.ts";

	ok("an unchanged run is clean", cmp().failures.length === 0);
	ok("rule 8: a bootstrap baseline fails", has(cmp((r) => r, baseline, true, true).failures, /bootstrap/));
	ok("rule 1: a regression fails", has(cmp((r) => ((r[F]["A — journey › passes"].status = "failed"), r)).failures, /REGRESSION/));
	ok("rule 2: a new failing test fails", has(cmp((r) => ((r[F]["A — journey › brand new"] = { status: "failed", fixme: null }), r)).failures, /NEW test must pass/));
	ok("rule 2: a new passing test is fine", cmp((r) => ((r[F]["A — journey › brand new"] = { status: "passed", fixme: null }), r)).failures.length === 0);
	ok("rule 3: baseline failed now passing fails with the regenerate instruction", has(cmp((r) => ((r[F]["A — journey › fails"].status = "passed"), r)).failures, /--write --only=flows\/a\.spec\.ts/));
	ok("rule 4: a baseline test the run lacks fails", has(cmp((r) => (delete r[F]["A — journey › passes"], r)).failures, /does not contain/));
	ok("rule 5: a plain skip in CI fails", has(cmp((r) => ((r[F]["A — journey › passes"] = { status: "skipped", fixme: null }), r)).failures, /SKIPPED in CI/));
	ok("rule 5: a BUG fixme the baseline carries is accepted", cmp().failures.length === 0 && cmp().perFile[F].fixme === 1);
	ok("rule 5: a BUG fixme the baseline does not carry fails", has(cmp((r) => ((r[F]["A — journey › passes"] = { status: "skipped", fixme: "BUG: new #9" }), r)).failures, /not in the baseline/));
	ok("rule 5: a fixme without an issue number fails", has(cmp((r) => ((r[F]["A — journey › fixme"].fixme = "BUG: no number"), r)).failures, /must read/));
	ok("rule 5: locally a plain skip is reported, not failed", cmp((r) => ((r[F]["A — journey › passes"] = { status: "skipped", fixme: null }), r), baseline, false).failures.length === 0);
	ok("rule 6: fewer tests than the baseline fails (via rule 4 too)", has(cmp((r) => (delete r[F]["A — journey › passes"], r)).failures, /Fewer tests/));
	ok("rule 7: flaky counts as passed and is listed", cmp().perFile[F].flaky === 1 && cmp().perFile[F].passed >= 3);
	ok("a lifted fixme that still fails is a regression", has(cmp((r) => ((r[F]["A — journey › fixme"] = { status: "failed", fixme: null }), r)).failures, /fixme was lifted/));
	ok("the step summary names the project and each file", /flows\/a\.spec\.ts/.test(stepSummary("qa", cmp().perFile, [])) && /Release gate · qa/.test(stepSummary("qa", {}, [])));

	// End to end through the CLI, in a temp dir: write, then compare, then a regression.
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-ratchet-"));
	const results = path.join(dir, "results.json");
	const base = path.join(dir, "gate-baseline.json");
	fs.writeFileSync(results, JSON.stringify(report));
	fs.writeFileSync(base, JSON.stringify({ version: 1, bootstrap: true, projects: {} }));
	const quiet = () => {
		const orig = { log: console.log, error: console.error };
		console.log = () => {};
		console.error = () => {};
		return () => Object.assign(console, orig);
	};
	let restore = quiet();
	const bootstrapExit = main([`--project=qa`, `--results=${results}`, `--baseline=${base}`]);
	restore();
	ok("CLI: comparing against a bootstrap baseline exits 1", bootstrapExit === 1);
	restore = quiet();
	const writeExit = main([`--project=qa`, `--results=${results}`, `--baseline=${base}`, "--write"]);
	restore();
	const written = JSON.parse(fs.readFileSync(base, "utf8"));
	ok("CLI: --write exits 0 and drops the bootstrap flag", writeExit === 0 && written.bootstrap === undefined && written.projects.qa);
	restore = quiet();
	const cleanExit = main([`--project=qa`, `--results=${results}`, `--baseline=${base}`]);
	restore();
	ok("CLI: comparing a run to its own baseline exits 0", cleanExit === 0);
	const regressed = structuredClone(report);
	regressed.suites[0].suites[0].specs[0].tests[0].status = "unexpected";
	fs.writeFileSync(results, JSON.stringify(regressed));
	restore = quiet();
	const regExit = main([`--project=qa`, `--results=${results}`, `--baseline=${base}`]);
	restore();
	ok("CLI: a regression exits 1", regExit === 1);
	ok("CLI: an unknown argument exits 2", (() => { const r = quiet(); const e = main(["--nope"]); r(); return e === 2; })());
	fs.rmSync(dir, { recursive: true, force: true });

	console.log(failures === 0 ? "\nself-test: all passed" : `\nself-test: ${failures} FAILED`);
	return failures === 0 ? 0 : 1;
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
	try {
		process.exit(main(process.argv.slice(2)));
	} catch (err) {
		console.error(`::error::e2e-ratchet: ${err instanceof Error ? err.message : String(err)}`);
		process.exit(1);
	}
}
