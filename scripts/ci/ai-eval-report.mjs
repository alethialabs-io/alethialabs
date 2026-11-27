#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
//
// ai-eval-report — turns a real-model run into something a person can ACT on (epic #7840).
//
// WHY THIS EXISTS. The real-model legs used to write one line of truth: the job went red or green.
// A red nightly said "something about the model changed" and nothing else, and the per-case token
// cost lived only in the soak's job summary. The paid runs are worth their credit only when they
// answer "did this change make the assistant BETTER or WORSE, on which case, at what cost" — so this
// reads the eval's own outputs and says exactly that:
//
//   eval        the tool-choice eval (apps/console/tests/ai-eval/agent-behavior.eval.ts). Each run dir
//               holds vitest's `results.json` (the json reporter), the eval's `usage.json`
//               (AI_EVAL_USAGE_FILE) and `exit` (vitest's exit code). With --base-dir it compares the
//               PR's head with its base case by case: a case that passed on the base and fails on
//               the head is a REGRESSION, the reverse is a FIX.
//   playwright  the `elench-live` journeys: per-test outcome from Playwright's json reporter.
//
// The markdown goes to stdout (the job appends it to $GITHUB_STEP_SUMMARY). Exit codes are the
// verdict, the text is a report:
//
//   eval --fail-on-regression  exits 1 when any case regressed, a NEW case fails, or the head run
//                              produced no results at all (an eval that never reached a model must
//                              not read as "no regressions"). A case failing on BOTH sides is
//                              reported but does not fail the PR: it was not this change.
//   eval --fail-on-failure     exits 1 when any head case failed (the nightly's question).
//
//   node scripts/ci/ai-eval-report.mjs eval --head-dir D [--base-dir D] [--failing-out F] [--fail-on-regression|--fail-on-failure]
//   node scripts/ci/ai-eval-report.mjs playwright --results F
//   node scripts/ci/ai-eval-report.mjs --self-test

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Read a JSON file, or null when it is absent or unreadable.
 * @param {string} file
 * @returns {any}
 */
function readJson(file) {
	try {
		return JSON.parse(fs.readFileSync(file, "utf8"));
	} catch {
		return null;
	}
}

/**
 * The per-case outcome from a vitest json report (jest-compatible shape), keyed by test title.
 * @param {any} report
 * @returns {Map<string, {status: string, message: string}>}
 */
export function vitestCases(report) {
	const out = new Map();
	for (const file of report?.testResults ?? []) {
		for (const a of file.assertionResults ?? []) {
			const first = (a.failureMessages ?? [])[0] ?? "";
			out.set(a.title, { status: a.status, message: firstLine(first) });
		}
	}
	return out;
}

/**
 * The first non-empty line of a failure message, ANSI-stripped and clipped for a table cell.
 * @param {string} msg
 * @returns {string}
 */
function firstLine(msg) {
	// eslint-disable-next-line no-control-regex
	const line = String(msg).replace(/\u001b\[[0-9;]*m/g, "").split("\n").find((l) => l.trim()) ?? "";
	const clipped = line.trim().replace(/\|/g, "\\|");
	return clipped.length > 140 ? `${clipped.slice(0, 137)}…` : clipped;
}

/**
 * Load one eval run directory: results, usage and the recorded exit code.
 * @param {string} dir
 * @returns {{cases: Map<string, {status: string, message: string}> | null, usage: any, exit: string | null}}
 */
export function loadRun(dir) {
	const results = readJson(path.join(dir, "results.json"));
	let exit = null;
	try {
		exit = fs.readFileSync(path.join(dir, "exit"), "utf8").trim();
	} catch {
		// no exit file: the step never ran
	}
	return { cases: results ? vitestCases(results) : null, usage: readJson(path.join(dir, "usage.json")), exit };
}

/**
 * The usage row for a case. The eval records `test` (vitest's current test name, "suite > title");
 * an older eval (a PR's base) recorded only a short `name`, so no join is attempted there.
 * @param {any} usage
 * @param {string} title
 */
function usageFor(usage, title) {
	return (usage?.cases ?? []).find((c) => typeof c.test === "string" && c.test.endsWith(title));
}

/** A status as a table cell. */
function cell(status) {
	if (status === "passed") return "pass";
	if (status === "failed") return "**FAIL**";
	if (status === undefined) return "—";
	return status;
}

/**
 * Compare a head run with an optional base run.
 * @param {{cases: Map<string, {status: string, message: string}> | null, usage: any, exit: string | null}} head
 * @param {{cases: Map<string, {status: string, message: string}> | null, usage: any, exit: string | null} | null} base
 */
export function compareEval(head, base) {
	const rows = [];
	const regressions = [];
	const fixes = [];
	const failing = [];
	const newFailing = [];
	for (const [title, h] of head.cases ?? new Map()) {
		const b = base?.cases?.get(title);
		const u = usageFor(head.usage, title);
		let delta = "";
		if (b) {
			if (b.status === "passed" && h.status === "failed") {
				delta = "REGRESSED";
				regressions.push(title);
			} else if (b.status === "failed" && h.status === "passed") {
				delta = "fixed";
				fixes.push(title);
			}
		} else if (base?.cases) {
			delta = "new";
			if (h.status === "failed") newFailing.push(title);
		}
		if (h.status === "failed") failing.push({ title, message: h.message });
		rows.push({ title, head: h.status, base: b?.status, delta, usage: u, message: h.message });
	}
	return { rows, regressions, fixes, failing, newFailing };
}

/**
 * Render the eval comparison as markdown.
 * @param {ReturnType<typeof compareEval>} cmp
 * @param {{cases: any, usage: any, exit: string | null}} head
 * @param {{cases: any, usage: any, exit: string | null} | null} base
 * @returns {string}
 */
export function renderEval(cmp, head, base) {
	const model = head.usage?.model ?? process.env.AI_EXECUTOR_MODEL ?? "unknown model";
	const out = [`### Tool-choice eval — ${model}`, ""];
	if (!head.cases) {
		out.push(`The eval produced no results (vitest exit ${head.exit ?? "unknown"}) — it never reached a model, so nothing here says the tools are fine.`);
		return out.join("\n");
	}
	const passed = cmp.rows.filter((r) => r.head === "passed").length;
	const failed = cmp.rows.filter((r) => r.head === "failed").length;
	const skipped = cmp.rows.length - passed - failed;
	out.push(`**${passed} passed · ${failed} failed${skipped ? ` · ${skipped} skipped` : ""}** of ${cmp.rows.length} cases.`);
	if (base) {
		if (!base.cases) out.push("", "The base run produced no results, so there is nothing to compare against.");
		else out.push("", `Against the base: **${cmp.regressions.length} regressed · ${cmp.fixes.length} fixed · ${cmp.newFailing.length} new and failing**. A real model varies run to run — a single regression is a reason to look, not proof.`);
	}
	out.push("");
	const baseCol = base ? " base |" : "";
	const baseSep = base ? "---|" : "";
	out.push(`| case | head |${baseCol} change | input tok | cached | output tok | cost (USD) | first failure line |`);
	out.push(`|---|---|${baseSep}---|---:|---:|---:|---:|---|`);
	for (const r of cmp.rows) {
		const u = r.usage;
		const b = base ? ` ${cell(r.base)} |` : "";
		out.push(
			`| ${r.title} | ${cell(r.head)} |${b} ${r.delta} | ${u?.inputTokens ?? "—"} | ${u?.cachedInputTokens ?? "—"} | ${u?.outputTokens ?? "—"} | ${u?.costUsd ?? "—"} | ${r.head === "failed" ? r.message : ""} |`,
		);
	}
	out.push("");
	const total = head.usage?.totalCostUsd;
	const baseTotal = base?.usage?.totalCostUsd;
	out.push(`**Eval cost: USD ${total ?? "unknown"}${base ? ` (head) + USD ${baseTotal ?? "unknown"} (base)` : ""}.**`);
	return out.join("\n");
}

/**
 * The per-test outcome of a Playwright json report: one row per test, its final status and retries.
 * @param {any} report
 * @returns {{title: string, file: string, status: string, retries: number}[]}
 */
export function playwrightRows(report) {
	const rows = [];
	/** @param {any} suite @param {string[]} trail */
	const walk = (suite, trail) => {
		const here = suite.title && !suite.title.endsWith(".ts") ? [...trail, suite.title] : trail;
		for (const spec of suite.specs ?? []) {
			for (const t of spec.tests ?? []) {
				const results = t.results ?? [];
				const last = results[results.length - 1];
				rows.push({
					title: [...here, spec.title].join(" › "),
					file: spec.file ?? suite.file ?? "",
					status: t.status === "flaky" ? "flaky" : (last?.status ?? t.status ?? "unknown"),
					retries: Math.max(0, results.length - 1),
				});
			}
		}
		for (const child of suite.suites ?? []) walk(child, here);
	};
	for (const s of report?.suites ?? []) walk(s, []);
	return rows;
}

/**
 * Render the Playwright rows as markdown.
 * @param {ReturnType<typeof playwrightRows>} rows
 * @returns {string}
 */
export function renderPlaywright(rows) {
	const out = ["### Real-model journeys (elench-live)", ""];
	if (rows.length === 0) {
		out.push("No Playwright results were written — the journeys never ran.");
		return out.join("\n");
	}
	const by = (s) => rows.filter((r) => r.status === s).length;
	out.push(`**${by("passed")} passed · ${by("failed") + by("timedOut")} failed · ${by("flaky")} flaky · ${by("skipped")} skipped**`, "");
	out.push("| journey | file | result | retries |", "|---|---|---|---:|");
	for (const r of rows) {
		const res = r.status === "passed" ? "pass" : r.status === "skipped" ? "skipped" : `**${r.status}**`;
		out.push(`| ${r.title.replace(/\|/g, "\\|")} | ${r.file} | ${res} | ${r.retries} |`);
	}
	return out.join("\n");
}

/**
 * Parse `--key value` and `--flag` arguments.
 * @param {string[]} argv
 */
function parseArgs(argv) {
	const opts = {};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (!a.startsWith("--")) continue;
		const next = argv[i + 1];
		if (next === undefined || next.startsWith("--")) opts[a.slice(2)] = true;
		else {
			opts[a.slice(2)] = next;
			i++;
		}
	}
	return opts;
}

/** Self-test: fixtures for every branch whose answer decides the exit code. */
function selfTest() {
	let failures = 0;
	const check = (name, cond) => {
		if (!cond) {
			failures++;
			console.error(`FAIL ${name}`);
		}
	};
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ai-eval-report-"));
	const write = (dir, results, usage, exit) => {
		fs.mkdirSync(dir, { recursive: true });
		if (results) fs.writeFileSync(path.join(dir, "results.json"), JSON.stringify(results));
		if (usage) fs.writeFileSync(path.join(dir, "usage.json"), JSON.stringify(usage));
		fs.writeFileSync(path.join(dir, "exit"), exit);
	};
	const vr = (pairs) => ({
		testResults: [{ assertionResults: pairs.map(([title, status]) => ({ title, status, failureMessages: status === "failed" ? ["\u001b[31mAssertionError: expected [] to include 'x'\u001b[0m\n at y"] : [] })) }],
	});
	write(path.join(tmp, "head"), vr([["a", "failed"], ["b", "passed"], ["c", "failed"], ["d", "failed"]]), {
		model: "m",
		totalCostUsd: 0.01,
		cases: [{ name: "a", test: "suite > a", inputTokens: 10, cachedInputTokens: 0, outputTokens: 2, costUsd: 0.001 }],
	}, "1");
	write(path.join(tmp, "base"), vr([["a", "passed"], ["b", "failed"], ["c", "failed"]]), null, "1");
	write(path.join(tmp, "empty"), null, null, "1");

	const head = loadRun(path.join(tmp, "head"));
	const base = loadRun(path.join(tmp, "base"));
	const cmp = compareEval(head, base);
	check("a regressed", cmp.regressions.join() === "a");
	check("b fixed", cmp.fixes.join() === "b");
	check("d is new and failing", cmp.newFailing.join() === "d");
	check("c failing on both is not a regression", !cmp.regressions.includes("c"));
	check("failing lists a, c, d", cmp.failing.map((f) => f.title).join() === "a,c,d");
	check("failure message is ANSI-stripped", cmp.failing[0].message === "AssertionError: expected [] to include 'x'");
	const md = renderEval(cmp, head, base);
	check("usage joined on the test name", md.includes("| a | **FAIL** | pass | REGRESSED | 10 | 0 | 2 | 0.001 |"));
	check("unjoined usage renders a dash", md.includes("| b | pass | **FAIL** | fixed | — |"));

	const empty = loadRun(path.join(tmp, "empty"));
	check("no results reads as no results", empty.cases === null && renderEval(compareEval(empty, null), empty, null).includes("never reached a model"));

	const pw = playwrightRows({
		suites: [{ title: "x.spec.ts", file: "x.spec.ts", specs: [], suites: [{ title: "grp", specs: [{ title: "t1", file: "x.spec.ts", tests: [{ status: "flaky", results: [{ status: "failed" }, { status: "passed" }] }] }, { title: "t2", file: "x.spec.ts", tests: [{ status: "unexpected", results: [{ status: "failed" }, { status: "failed" }, { status: "failed" }] }] }] }] }],
	});
	check("playwright rows", pw.length === 2 && pw[0].status === "flaky" && pw[0].retries === 1 && pw[1].status === "failed" && pw[1].title === "grp › t2");
	check("playwright empty", renderPlaywright([]).includes("never ran"));

	// The CLI's exit codes are the verdict — exercise them end to end.
	const run = (args) => {
		const saved = process.exitCode;
		process.exitCode = 0;
		const log = console.log;
		console.log = () => {};
		try {
			main(args);
			return process.exitCode;
		} finally {
			console.log = log;
			process.exitCode = saved;
		}
	};
	check("regression fails the PR", run(["eval", "--head-dir", path.join(tmp, "head"), "--base-dir", path.join(tmp, "base"), "--fail-on-regression"]) === 1);
	check("no results fails the PR", run(["eval", "--head-dir", path.join(tmp, "empty"), "--fail-on-regression"]) === 1);
	write(path.join(tmp, "ok"), vr([["a", "passed"], ["c", "failed"]]), null, "1");
	check("a both-sides failure does not fail the PR", run(["eval", "--head-dir", path.join(tmp, "ok"), "--base-dir", path.join(tmp, "base"), "--fail-on-regression"]) === 0);
	check("any failure fails the nightly", run(["eval", "--head-dir", path.join(tmp, "ok"), "--fail-on-failure"]) === 1);
	const failingOut = path.join(tmp, "failing.json");
	run(["eval", "--head-dir", path.join(tmp, "ok"), "--failing-out", failingOut]);
	check("failing-out lists the failing cases", readJson(failingOut)?.failing?.[0]?.title === "c");

	fs.rmSync(tmp, { recursive: true, force: true });
	if (failures) {
		console.error(`${failures} self-test check(s) failed`);
		process.exit(1);
	}
	console.log("ai-eval-report self-test: ok");
}

/**
 * Entry point.
 * @param {string[]} argv
 */
function main(argv) {
	const [cmd, ...rest] = argv;
	const opts = parseArgs(rest);
	if (cmd === "eval") {
		if (typeof opts["head-dir"] !== "string") throw new Error("eval needs --head-dir");
		const head = loadRun(opts["head-dir"]);
		const base = typeof opts["base-dir"] === "string" ? loadRun(opts["base-dir"]) : null;
		const cmp = compareEval(head, base);
		console.log(renderEval(cmp, head, base));
		if (typeof opts["failing-out"] === "string") {
			fs.writeFileSync(
				opts["failing-out"],
				JSON.stringify({ model: head.usage?.model ?? null, ran: head.cases !== null, failing: cmp.failing }, null, 2),
			);
		}
		if (opts["fail-on-regression"] && (!head.cases || cmp.regressions.length || cmp.newFailing.length)) process.exitCode = 1;
		if (opts["fail-on-failure"] && (!head.cases || cmp.failing.length)) process.exitCode = 1;
		return;
	}
	if (cmd === "playwright") {
		if (typeof opts.results !== "string") throw new Error("playwright needs --results");
		console.log(renderPlaywright(playwrightRows(readJson(opts.results))));
		return;
	}
	throw new Error(`unknown command: ${cmd ?? "(none)"} — expected eval, playwright or --self-test`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
	if (process.argv.includes("--self-test")) selfTest();
	else main(process.argv.slice(2));
}
