#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
//
// THE RELEASE GATE IS GREEN-BY-RATCHET, AND THIS IS THE RATCHET.
//
// The browser suites were 39% green when the gate was built. That figure is ONE DATED RUN OF ONE
// PROJECT — `--project=qa`, 346 tests, 2026-09-02, 136 passed / 192 failed / 1 skipped / 17 never
// ran, written up in apps/console/docs/qa/findings.md — and it is NOT this ratchet's ledger, which
// today spans six projects. Those two numbers sat adjacent here with nothing to tell them apart,
// and were read as one (#4536); "17 never ran" in particular describes that run and no state the
// ledger has ever had. So the ledger's own census is derived on demand rather than typed, and the
// sentence you are reading is history that cannot go stale because it is dated.
//
// An absolute-green requirement would have blocked every promotion for weeks, so the gate could
// not have been REQUIRED on day one — and a gate that is not required is a gate people learn to
// read past. Instead every leg fails on REGRESSION against a committed baseline: the repo's own
// pattern for a measurement that is allowed to be red while it is being worked through
// (`ui-conformance-live.json`, `required-checks-divergence.json` — shrink-only, captured before
// the fix, moved in the same PR as the code).
//
// ── THE LEDGER TODAY: ASK FOR IT. IT IS NOT WRITTEN DOWN ANYWHERE ────────────────────────────
//
//   node scripts/e2e-ratchet.mjs --census
//
// recounts apps/console/e2e/gate-baseline.json and prints one line — tests, projects,
// passed/failed/fixme/data-skip, and which projects are failing. No run, no network, no results
// file: it reads the committed ledger and nothing else. `--self-test` prints the same line last,
// so the required `Authz / open-core guards` job carries today's census in its log on every PR.
//
// THAT LINE USED TO BE COMMITTED IN THIS HEADER, AND A COMMITTED SUM OVER A PARTITIONED LEDGER
// CANNOT MERGE (#4648). The ledger partitions by project → file → title, so two lanes regenerating
// different slices merge; a repo-wide sum over it partitions not at all, so every lane rewrote the
// same line and they were mutually exclusive by construction. Six open PRs went DIRTY on this one
// line within minutes of two merges, and again on the next merge, four for four.
//
// The resolution was the worse half. The value is a SUM, so neither side of the conflict is true
// once both land: measured on 2026-09-17, `dev` said `647 tests / 40 failed`, the branch said
// `645 / 42`, and the true merged value was `649 / 25`. Taking ours or theirs commits a number
// that was never true of any tree — and a wrong sum reds `Authz / open-core guards`, a REQUIRED
// check, after the PR has already been dequeued. A whole class of correct-looking resolutions was
// silently wrong, and the only way through it was arithmetic under time pressure.
//
// So the census is not stored, and `--self-test` refuses to let it come back: a committed census
// line in this file is now a FAILURE rather than a value to compare. A number recomputed from the
// ledger on demand cannot go stale, cannot conflict, and cannot be resolved into a value no tree
// ever had — the wrong value is impossible rather than merely detected. #4536's reason for
// deriving it becomes absolute rather than checked: there is no typed figure left here to be
// misread as the ledger's state.
//
// What that gives up is the totals moving visibly inside a PR diff. What still stops the ledger
// shrinking is unchanged, and all of it runs in the same required job: this file's rules 3, 4 and
// 6 on every gate leg; `scripts/ci/check-gate-baseline-consistency.mjs` (tree ↔ ledger identity,
// and a floor under the ledger's size); `scripts/ci/check-gate-baseline-slice-ownership.mjs` (a
// slice a PR did not earn the right to rewrite). None of the three ever read the census line.
//
//   node scripts/e2e-ratchet.mjs --project=<name> --results=<playwright json> [--baseline=<file>]
//   node scripts/e2e-ratchet.mjs --project=<name> --results=<json> --write [--only=<spec file>]...
//   node scripts/e2e-ratchet.mjs --census [--baseline=<file>]
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
//   5. `skipped` in CI                             → FAIL   unless the baseline RECORDS the skip:
//                                                    a `{fixme}` whose description matches
//                                                    /^BUG: .+#\d+/, or a `{skip: "<why>"}` for a
//                                                    data-dependent condition (which then tolerates
//                                                    skipped AND passed, never failed). An
//                                                    UNRECORDED skip is always a failure — that is
//                                                    the anti-`HAVE_MEMBER` rule at the ledger: an
//                                                    unset variable used to turn every RBAC denial
//                                                    into a green skip for two months.
//   6. fewer tests than the baseline counts         → FAIL   found-nothing is not nothing-wrong
//   7. `flaky` (passed on retry)                    → counts as passed, and is LISTED
//   8. a `bootstrap: true` baseline                 → FAIL   the baseline was never captured; a
//                                                    gate that passes on an empty ledger is vacuous
//
// --write regenerates a project's entries from a results file. With --only=<file> it replaces only
// that file's entries, so two lanes regenerating at once produce diffs that touch their own files.
// A skip is recorded only if it states WHY: `test.fixme(true, "BUG: <what> #<issue>")` becomes a
// `{fixme}`, `test.skip(cond, "why")` becomes a `{skip}`. A skip with no reason is refused, not
// recorded — a reason is what makes the entry reviewable in the diff.
//
// Do NOT pipe this into `tail`/`head`: a pipe reports the exit code of the LAST command in it.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const DEFAULT_BASELINE = "apps/console/e2e/gate-baseline.json";
export const FIXME_RE = /^BUG: .+#\d+/;

/**
 * Is this baseline entry a recorded data-dependent skip (`{skip: "<why>"}`)?
 *
 * Narrowed here rather than inline so the three call sites in `compareProject` cannot drift on
 * what counts — a `{fixme}` and a `{skip}` are both objects, and treating one as the other would
 * either re-open the skip hole or demand a ledger move that flip-flops with the org's state.
 *
 * @param {Recorded|undefined} known
 * @returns {known is {skip: string}}
 */
export function isSkipRecord(known) {
	return typeof known === "object" && known !== null && typeof known.skip === "string";
}

// ── the ledger's own census ──────────────────────────────────────────────────────────────────

/**
 * The marker a census line carries when it is PRINTED — and the token `--self-test` refuses to
 * find committed in this file.
 *
 * Held as a constant so the writer (`censusLine`) and the reader (`censusLinesIn`) cannot come to
 * disagree about what they are looking for — the failure mode of a hand-copied token is that the
 * check quietly finds nothing and reports green.
 */
const CENSUS_MARKER = "LEDGER-CENSUS: ";

/**
 * Recount a whole baseline document: totals across every project, and per-project failures.
 *
 * Throws on an entry that is none of `passed | failed | {fixme} | {skip}` rather than skipping it:
 * an uncounted entry would shrink the census silently, which is the same defect the census exists
 * to close.
 *
 * @param {unknown} doc parsed `apps/console/e2e/gate-baseline.json`
 * @returns {{tests: number, projects: number, passed: number, failed: number, fixme: number, dataSkip: number, failedBy: Array<[string, number]>}}
 */
export function census(doc) {
	if (typeof doc !== "object" || doc === null || typeof doc.projects !== "object" || doc.projects === null) {
		throw new Error("census: the baseline has no `projects` object.");
	}
	const c = { tests: 0, projects: 0, passed: 0, failed: 0, fixme: 0, dataSkip: 0, failedBy: [] };
	// Sorted, so the rendered line does not depend on the order projects happen to have been
	// captured in — `--write` appends a new project, and an insertion-ordered census would churn
	// the header for a reason that is not a change in the ledger.
	for (const name of Object.keys(doc.projects).sort()) {
		c.projects++;
		let failed = 0;
		for (const tests of Object.values(doc.projects[name])) {
			for (const outcome of Object.values(tests)) {
				c.tests++;
				if (outcome === "passed") c.passed++;
				else if (outcome === "failed") {
					c.failed++;
					failed++;
				} else if (isSkipRecord(outcome)) c.dataSkip++;
				else if (typeof outcome === "object" && outcome !== null && typeof outcome.fixme === "string") c.fixme++;
				else throw new Error(`census: project "${name}" carries an entry that is none of passed|failed|{fixme}|{skip}: ${JSON.stringify(outcome)}`);
			}
		}
		if (failed > 0) c.failedBy.push([name, failed]);
	}
	return c;
}

/**
 * Render a census as one line, comment prefix and all — what `--census` prints.
 *
 * The `// ` prefix is kept so the line still reads as the thing it replaced, and so the guard
 * below is asked about exactly the shape a reader might be tempted to paste back into a source
 * file. It is printed, never committed.
 *
 * @param {ReturnType<typeof census>} c
 * @returns {string} the rendered census line
 */
export function censusLine(c) {
	const failing = c.failedBy.length ? c.failedBy.map(([name, n]) => `${name} ${n}`).join(", ") : "none";
	return `// ${CENSUS_MARKER}${c.tests} tests across ${c.projects} projects — ${c.passed} passed, ${c.failed} failed, ${c.fixme} fixme, ${c.dataSkip} data-skip; failing: ${failing}`;
}

/**
 * Every line of a source file that COMMITS a census — the marker as a comment at column 0.
 *
 * `--self-test` requires this to be empty of this file. A stored census is a global aggregate over
 * a partitioned ledger: every lane that moves any slice rewrites the same line, so the lanes are
 * mutually exclusive, and because the value is a sum neither side of the resulting conflict is
 * true of the merged tree (#4648). The list is returned rather than a boolean so the failure can
 * name what it found — a guard that says only "no" sends the reader looking.
 *
 * It matches the RENDERED shape, not the topic: a sentence about the census, or the marker inside
 * backticks or mid-line, is prose and is left alone. Only a line that could be read as the value
 * counts, which is the only thing that can be merged into a lie.
 *
 * @param {string} source the file's text
 * @returns {string[]}
 */
export function censusLinesIn(source) {
	return source.split("\n").filter((line) => line.startsWith(`// ${CENSUS_MARKER}`));
}

// ── Playwright JSON → { file → { test → outcome } } ──────────────────────────────────────────

/**
 * @typedef {{status: "passed"|"failed"|"flaky"|"skipped", fixme: string|null, skip: string|null}} Outcome
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
				// A conditional `test.skip(cond, "why")` lands as a `skip` annotation, not a `fixme`.
				// Both are read: a fixme records a KNOWN BUG, a skip records a data-dependent
				// condition. They are different ledger entries and must not be conflated.
				const skip = (t.annotations ?? []).find((a) => a && a.type === "skip");
				const status =
					t.status === "expected" ? "passed" : t.status === "flaky" ? "flaky" : t.status === "unexpected" ? "failed" : "skipped";
				(out[file] ??= {})[key] = {
					status,
					fixme: fixme && typeof fixme.description === "string" ? fixme.description : null,
					skip: skip && typeof skip.description === "string" ? skip.description : null,
				};
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
 * @typedef {"passed"|"failed"|{fixme: string}|{skip: string}} Recorded
 * @typedef {Record<string, Record<string, Recorded>>} ProjectBaseline
 *
 * Four recordable outcomes, and the difference between the last two is the whole point:
 *
 * - `"passed"` / `"failed"` — the ordinary ledger. Shrink-only.
 * - `{fixme}` — a KNOWN BUG, skipped deliberately, carrying `BUG: <what> #<issue>`. The test is
 *   expected to stay skipped until the issue is fixed; if it runs and passes, the ledger moves.
 * - `{skip}` — a DATA-DEPENDENT condition, e.g. `test.skip(connected > 0, "Azure is connected
 *   (seeded) in the shared org")`. On a shared persona org at `--workers=3` such a test skips in
 *   one run and passes in the next, through no change of anyone's. Recording it as `passed` makes
 *   the gate flip red on org state rather than on a regression; refusing to record it at all (the
 *   original rule 5) makes the leg un-baselineable, because `--write` throws on the first one.
 *
 *   A `{skip}` entry therefore tolerates BOTH skipped and passed, and still fails on `failed`.
 *   The hole rule 5 was written to close stays closed: an UNRECORDED skip is still a failure in
 *   CI, so an unset variable that silently turns a denial into a green skip is caught the first
 *   time it happens. Only skips written into the ledger — visible in a diff, reviewable — are
 *   tolerated, and each one names its condition.
 */

/**
 * Compare one project's run with its baseline. Returns the failures and a per-file summary.
 *
 * @param {{baseline: ProjectBaseline|undefined, run: ProjectRun, ci: boolean, bootstrap: boolean, project: string}} args
 */
export function compareProject({ baseline, run, ci, bootstrap, project }) {
	/** @type {string[]} */
	const failures = [];
	/** @type {Record<string, {passed: number, failed: number, flaky: number, fixme: number, skipped: number, dataSkip: number, newTests: number, regressions: number, nowPassing: number}>} */
	const perFile = {};
	const row = (file) =>
		(perFile[file] ??= { passed: 0, failed: 0, flaky: 0, fixme: 0, skipped: 0, dataSkip: 0, newTests: 0, regressions: 0, nowPassing: 0 });

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
				else if (isSkipRecord(known)) {
					// A data-dependent skip that ran and passed this time. Both outcomes are
					// recorded as acceptable, so this is not a ledger move — demanding one would
					// send the lane into a loop, since the next run may skip it again.
					r.dataSkip++;
				} else if (known === "failed" || (typeof known === "object" && known !== null)) {
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
				} else if (isSkipRecord(known)) {
					r.regressions++;
					failures.push(
						`${id}: recorded as a data-dependent skip ("${known.skip}"), but the run FAILED. ` +
							"A skip entry tolerates skipped and passed, never failed.",
					);
				} else if (typeof known === "object" && known !== null) {
					r.regressions++;
					failures.push(`${id}: the fixme was lifted (the test ran) but it still fails. Re-mark it, or fix it.`);
				}
				// known === "failed": recorded debt, unchanged.
			} else {
				// skipped
				const fixme = outcome.fixme;
				const isBugFixme = typeof fixme === "string" && FIXME_RE.test(fixme);
				const baselineFixme = typeof known === "object" && known !== null && "fixme" in known ? known.fixme : null;
				if (isBugFixme && baselineFixme === fixme) {
					r.fixme++;
				} else if (isSkipRecord(known)) {
					// Recorded data-dependent skip. It skipped, which is one of the two outcomes
					// the entry accepts. The reason is not re-compared: the condition is the
					// point, and its wording is allowed to be refined without reddening a gate.
					r.dataSkip++;
				} else if (ci) {
					r.skipped++;
					failures.push(
						`${id}: SKIPPED in CI. ` +
							(isBugFixme
								? `Its fixme ("${fixme}") is not in the baseline — regenerate with --write --only=${file}.`
								: fixme
									? `A fixme must read "BUG: <what> #<issue>"; got "${fixme}".`
									: outcome.skip
										? `It is a data-dependent skip ("${outcome.skip}") that the baseline does not record. If that condition is legitimate, record it with --write --only=${file}; the entry then accepts skipped or passed, never failed.`
										: "A skip with no reason is never accepted in CI; an unset variable once turned every RBAC denial into a green skip."),
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
			else if (typeof o.skip === "string" && o.skip.trim() !== "") v = { skip: o.skip };
			else {
				// A skip with NO stated reason stays un-baselineable, deliberately. That is the
				// shape an unset variable produces — `test.skip(!process.env.X)` with nothing to
				// say — and it is the one that once turned every RBAC denial into a green skip.
				// A reason is what makes the entry reviewable, so a reason is the price of record.
				throw new Error(
					`${file} › ${title}: skipped with ${o.fixme ? `a fixme that is not "BUG: … #<issue>" ("${o.fixme}")` : "no reason given"} — cannot be baselined. ` +
						'Give the skip a reason (`test.skip(cond, "why")`) to record it as a data-dependent skip, ' +
						'or `test.fixme(true, "BUG: <what> #<issue>")` to record it as a known bug.',
				);
			}
			(out[file] ??= {})[title] = v;
		}
	}
	return out;
}

/** A markdown table of per-file deltas, for $GITHUB_STEP_SUMMARY. */
export function stepSummary(project, perFile, failures) {
	const L = [
		`### Release gate · ${project} · ratchet`,
		"",
		"| file | passed | failed | fixme | data-skip | flaky | new | regressions | now passing |",
		"|---|--:|--:|--:|--:|--:|--:|--:|--:|",
	];
	for (const [file, r] of Object.entries(perFile).sort(([a], [b]) => a.localeCompare(b))) {
		L.push(
			`| \`${file}\` | ${r.passed} | ${r.failed} | ${r.fixme} | ${r.dataSkip} | ${r.flaky} | ${r.newTests} | ${r.regressions} | ${r.nowPassing} |`,
		);
	}
	L.push("", failures.length === 0 ? "**ratchet: no regression against the baseline.**" : `**ratchet: ${failures.length} problem(s)**`, "");
	for (const f of failures) L.push(`- ${f}`);
	return L.join("\n");
}

// ── CLI ──────────────────────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
	const out = { project: "", results: "", baseline: path.join(ROOT, DEFAULT_BASELINE), write: false, only: [], summary: false, selfTest: false, censusOnly: false, help: false, unknown: [] };
	for (const a of argv) {
		if (a === "--self-test") out.selfTest = true;
		else if (a === "--census") out.censusOnly = true;
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
	"  node scripts/e2e-ratchet.mjs --census [--baseline=<file>]",
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
	if (args.censusOnly) {
		// Read-only, and it reads the LEDGER — never a results file, never this file. That is the
		// whole point: the census has exactly one source, so the printed number is true of the
		// tree it was read from by construction. `census()` throws on an entry it cannot
		// classify, and that throw is the answer — a smaller, quieter number is the defect the
		// census exists to expose.
		console.log(censusLine(census(readJson(args.baseline, "baseline"))));
		return 0;
	}
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
		// `--only` is applied to the RUN, before `toBaseline` sees it. Converting the whole run
		// first and filtering afterwards meant one un-baselineable test in an unrelated file threw
		// and a lane could not regenerate its own entries at all — including the very first
		// bootstrap capture, which is the one moment every file is unrecorded.
		const current = baselineDoc.projects[args.project] ?? {};
		let next;
		if (args.only.length) {
			for (const file of args.only) {
				if (!(file in run)) throw new Error(`--only=${file}: the run holds no tests for that file under project "${args.project}".`);
			}
			const scoped = Object.fromEntries(Object.entries(run).filter(([file]) => args.only.includes(file)));
			next = { ...current, ...toBaseline(scoped) };
		} else next = toBaseline(run);
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
	// BOTH streams, always. The workflow runs this as `… --step-summary >> "$GITHUB_STEP_SUMMARY"`,
	// so stdout is redirected away from the job log; emitting the annotations only in the `else`
	// left a failing required check whose step log was completely EMPTY, with nothing on the job
	// to say why. stdout and stderr are independent here, so printing both costs nothing.
	if (args.summary) console.log(stepSummary(args.project, perFile, failures));
	for (const f of failures) console.error(`::error::${f}`);
	if (failures.length === 0) console.log(`e2e-ratchet: ${args.project} — no regression against the baseline.`);
	return failures.length === 0 ? 0 : 1;
}

const BASELINE_COMMENT = [
	"The release gate's ratchet — apps/console/e2e/gate-baseline.json. GENERATED by scripts/e2e-ratchet.mjs --write; never hand-edited.",
	"One entry per (project, spec file, test): passed | failed | {fixme: 'BUG: … #n'} | {skip: '<why>'}. The gate fails on any",
	"regression against this file, on a new test that does not pass, on a skip this file does not record, and on a test that",
	"starts passing while still recorded as failed — shrink-only, so a fix and the ledger move in one PR (--write --only=<file>).",
	"A {skip} is a data-dependent condition and tolerates skipped OR passed; a {fixme} is a known bug and must stay skipped.",
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
		"--write refuses a skip with no reason",
		(() => {
			try {
				toBaseline({ f: { t: { status: "skipped", fixme: null, skip: null } } });
				return false;
			} catch {
				return true;
			}
		})(),
	);
	ok(
		"--write records a data-dependent skip that states its reason",
		(() => {
			const b = toBaseline({ f: { t: { status: "skipped", fixme: null, skip: "Azure is connected (seeded) in the shared org" } } });
			return b.f.t.skip === "Azure is connected (seeded) in the shared org";
		})(),
	);
	ok(
		"--write still refuses a skip whose only reason is whitespace",
		(() => {
			try {
				toBaseline({ f: { t: { status: "skipped", fixme: null, skip: "   " } } });
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

	// ── a recorded data-dependent skip tolerates skipped AND passed, never failed ──────────────
	// The `qa` leg's real shape: `test.skip(connected > 0, "…seeded in the shared org")` skips in
	// one run and passes in the next on a shared persona org. Both must be clean once recorded,
	// or the required check flips red on org state rather than on a regression.
	const skipBase = structuredClone(baseline);
	skipBase[F]["A — journey › passes"] = { skip: "Azure is connected (seeded) in the shared org" };
	const asSkip = (r) => ((r[F]["A — journey › passes"] = { status: "skipped", fixme: null, skip: "Azure is connected (seeded) in the shared org" }), r);
	ok("a recorded data-dependent skip that skips is clean", cmp(asSkip, skipBase).failures.length === 0);
	ok("a recorded data-dependent skip that PASSES is clean, with no ledger move demanded", cmp((r) => r, skipBase).failures.length === 0);
	ok("a recorded data-dependent skip is counted separately from a fixme", cmp(asSkip, skipBase).perFile[F].dataSkip === 1);
	ok(
		"a recorded data-dependent skip that FAILS is still a regression",
		has(cmp((r) => ((r[F]["A — journey › passes"] = { status: "failed", fixme: null, skip: null }), r), skipBase).failures, /tolerates skipped and passed, never failed/),
	);
	ok(
		"an UNRECORDED data-dependent skip still fails in CI, naming how to record it",
		has(cmp(asSkip).failures, /--write --only=flows\/a\.spec\.ts/),
	);
	ok(
		"a skip with no reason at all keeps the original unset-variable message",
		has(cmp((r) => ((r[F]["A — journey › passes"] = { status: "skipped", fixme: null, skip: null }), r)).failures, /unset variable/),
	);

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

	// `--write --only=<file>` must convert ONLY that file. A run holding an un-baselineable test
	// in an UNRELATED file used to make the whole call throw, so a lane could not regenerate its
	// own entries — and neither could the first bootstrap capture, where nothing is recorded yet.
	const twoFiles = structuredClone(report);
	twoFiles.suites.push({
		title: "flows/b.spec.ts",
		file: "flows/b.spec.ts",
		specs: [
			{
				title: "unbaselineable",
				tests: [{ projectName: "qa", status: "skipped", annotations: [] }],
			},
		],
	});
	const results2 = path.join(dir, "results2.json");
	const base2 = path.join(dir, "gate-baseline2.json");
	fs.writeFileSync(results2, JSON.stringify(twoFiles));
	fs.writeFileSync(base2, JSON.stringify({ version: 1, bootstrap: true, projects: {} }));
	restore = quiet();
	let onlyExit;
	try {
		onlyExit = main([`--project=qa`, `--results=${results2}`, `--baseline=${base2}`, "--write", "--only=flows/a.spec.ts"]);
	} catch {
		onlyExit = "threw";
	}
	restore();
	const scoped = JSON.parse(fs.readFileSync(base2, "utf8"));
	ok("CLI: --write --only is scoped past an un-baselineable test in another file", onlyExit === 0);
	ok("CLI: --write --only records the named file and not the other", Boolean(scoped.projects?.qa?.["flows/a.spec.ts"]) && scoped.projects?.qa?.["flows/b.spec.ts"] === undefined);
	restore = quiet();
	let allExit;
	try {
		allExit = main([`--project=qa`, `--results=${results2}`, `--baseline=${base2}`, "--write"]);
	} catch {
		allExit = "threw";
	}
	restore();
	ok("CLI: an unscoped --write still refuses the un-baselineable test", allExit === "threw");

	fs.rmSync(dir, { recursive: true, force: true });

	// ── the census: NOT committed, and the REAL ledger still countable ───────────────────────
	//
	// Every assertion above runs on a fixture. These deliberately do not: they read the real
	// apps/console/e2e/gate-baseline.json and this file's own text, because a census pinned to a
	// fixture is a census of the fixture.
	//
	// THE INVARIANT INVERTED IN #4648. It used to be "the header's line equals the ledger,
	// recounted" — a stored copy of a derived value, checked in both directions. That check was
	// working; what it was asked to guard was the wrong shape. A repo-wide sum over a ledger that
	// partitions by project → file → title is a shared counter: every lane that moves any slice
	// rewrites the same line, so the lanes are mutually exclusive by construction, and because the
	// value is a SUM neither side of the conflict is true once both land. So the assertion is now
	// that the file commits NO census at all, and the number is recomputed by `--census`.
	//
	// The two assertions that survived the inversion are the two that never depended on a stored
	// number: the ledger is there, and every entry in it can be classified.
	const source = fs.readFileSync(fileURLToPath(import.meta.url), "utf8");
	const committed = censusLinesIn(source);
	if (committed.length) {
		for (const line of committed) console.error(`     committed: ${line}`);
		console.error("     → a census over the whole ledger cannot merge (#4648): every lane that moves any slice rewrites this one line,");
		console.error("       and because it is a sum, resolving that conflict commits a number no tree ever had. Delete it — `--census` prints it on demand.");
	}
	ok(`this file commits no census line (found ${committed.length})`, committed.length === 0);
	// ...and that guard is not vacuous. It must FIND a re-introduced line — the direction it
	// exists for — while leaving prose and code that merely name the marker alone, so the cheapest
	// way past it stays "delete the line" rather than "rephrase around the matcher".
	ok(
		"censusLinesIn finds a re-introduced committed census, and does not match prose or code that names the marker",
		(() => {
			const reintroduced = censusLine(census({ projects: { qa: { "a.spec.ts": { one: "passed", two: "failed" } } } }));
			const found = censusLinesIn(
				[
					"// ── a header ───",
					reintroduced,
					`// the marker is ${CENSUS_MARKER} when a line carries it in prose`,
					`const MARKER = "${CENSUS_MARKER}";`,
					`\t// ${CENSUS_MARKER}indented, so not a committed line either`,
				].join("\n"),
			);
			return found.length === 1 && found[0] === reintroduced;
		})(),
	);
	const ledgerFile = path.join(ROOT, DEFAULT_BASELINE);
	const ledgerExists = fs.existsSync(ledgerFile);
	ok(`the ledger ${DEFAULT_BASELINE} is there to be counted`, ledgerExists);
	let live = null;
	if (ledgerExists) {
		let why = null;
		try {
			live = censusLine(census(readJson(ledgerFile, "baseline")));
		} catch (err) {
			why = err instanceof Error ? err.message : String(err);
			console.error(`     ${why}`);
			console.error("     → the ledger holds an entry the census cannot classify. That is the ledger's defect, not the census's.");
		}
		ok("the real ledger counts — every entry is one of passed|failed|{fixme}|{skip}", live !== null);
	}
	// The census counter itself, on fixtures — including that it REFUSES an entry it cannot
	// classify, rather than dropping it and reporting a smaller, quieter number.
	ok(
		"census: counts every outcome kind, names the failing projects in NAME order not capture order, and omits the clean ones",
		(() => {
			// `zed` is declared first and must still be reported second; `mid` is clean and must
			// not be reported at all. Both are what the label claims, so both are exercised.
			const c = census({
				projects: {
					zed: { "z.spec.ts": { one: "passed", two: "failed" } },
					alpha: { "a.spec.ts": { one: "passed", two: "failed", three: { fixme: "BUG: x #1" }, four: { skip: "no org" } } },
					mid: { "m.spec.ts": { one: "passed" } },
				},
			});
			return (
				c.tests === 7 &&
				c.projects === 3 &&
				c.passed === 3 &&
				c.failed === 2 &&
				c.fixme === 1 &&
				c.dataSkip === 1 &&
				JSON.stringify(c.failedBy) === JSON.stringify([
					["alpha", 1],
					["zed", 1],
				])
			);
		})(),
	);
	ok(
		"census: an unclassifiable entry throws rather than going uncounted",
		(() => {
			try {
				census({ projects: { qa: { "a.spec.ts": { one: "wobbly" } } } });
				return false;
			} catch (err) {
				return err instanceof Error && /none of passed\|failed/.test(err.message);
			}
		})(),
	);
	ok("censusLine: a ledger with no failures says so, rather than trailing an empty list", censusLine(census({ projects: { qa: { "a.spec.ts": { one: "passed" } } } })).endsWith("failing: none"));

	// ── `--census` through the CLI, on a fixture ledger ──────────────────────────────────────
	//
	// The flag replaces a committed line, so it has to be the thing a lane reaches for on a rebase
	// with no run and no results file to hand. Asserted on what it PRINTS, not on its exit code
	// alone: a census command that exits 0 and says nothing is the failure mode that would send
	// somebody back to retyping the number from memory (#4536).
	const cdir = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-ratchet-census-"));
	const cbase = path.join(cdir, "gate-baseline.json");
	const cdoc = { version: 1, projects: { qa: { "a.spec.ts": { one: "passed", two: "failed" } }, hero: { "h.spec.ts": { one: "passed" } } } };
	fs.writeFileSync(cbase, JSON.stringify(cdoc));
	const printed = [];
	const captured = () => {
		const orig = console.log;
		console.log = (...a) => printed.push(a.join(" "));
		return () => {
			console.log = orig;
		};
	};
	let uncapture = captured();
	const censusExit = main(["--census", `--baseline=${cbase}`]);
	uncapture();
	ok(
		"CLI: --census exits 0 and prints exactly the ledger's census, recounted — no run, no results file",
		censusExit === 0 && printed.length === 1 && printed[0] === censusLine(census(cdoc)) && /3 tests across 2 projects/.test(printed[0]),
	);
	fs.writeFileSync(cbase, JSON.stringify({ version: 1, projects: { qa: { "a.spec.ts": { one: "wobbly" } } } }));
	let uncountable;
	uncapture = captured();
	try {
		uncountable = main(["--census", `--baseline=${cbase}`]);
	} catch {
		uncountable = "threw";
	}
	uncapture();
	ok("CLI: --census refuses an entry it cannot classify rather than printing a smaller, quieter number", uncountable === "threw");
	fs.rmSync(cdir, { recursive: true, force: true });

	// The census itself, last and derived, so the required job's log carries today's number on
	// every PR — the visibility the committed line used to buy, at no merge cost.
	if (live) console.log(`\n${DEFAULT_BASELINE}, recounted (derived, never committed — \`--census\` prints this line):\n${live}`);
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
