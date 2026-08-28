#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
//
// Every step in every workflow must have a `run:` or a `uses:`.
//
// WHY THIS EXISTS. A workflow file can be VALID YAML and still be REJECTED by Actions:
//
//     - name: Compute aggregate Go coverage → badge JSON
//       run: node scripts/go-coverage-badge.mjs
//     - name: Commit the badge if it changed        ← no `run:`, no `uses:`
//     - name: Publish the badge
//       run: |
//
// That is a well-formed mapping with one key, so every YAML parser accepts it. Actions does not —
// it rejects the whole file. The run completes as `completed/failure` with `jobs total_count: 0`.
//
// THE ZERO IS THE DANGEROUS PART. No jobs means not one of the nine required checks ever reports,
// so the PR does not go RED — it sits BLOCKED with an EMPTY status rollup, which reads exactly like
// "CI hasn't started yet". Nothing in the checks list names the cause. It is this repo's recurring
// shape: a failure that leaves no red signal.
//
// `yaml.parse()` passes on this input, which is the whole point — parsing is not validation, and a
// verification note saying "ci.yml parses" is true and worthless here.
//
//   node scripts/ci/check-workflow-shape.mjs
//   node scripts/ci/check-workflow-shape.mjs --self-test
//
// Line-based, because `yaml` is a dependency of apps/console and not of the root while this runs
// under plain `node` — the same constraint and the same shape as check-guards-independent.mjs. A
// line parser that stops matching finds nothing and reports success, so the blindness guards below
// are not optional decoration; they are what makes a green result mean anything.

import fs from "node:fs";
import path from "node:path";

const DIR = ".github/workflows";

/**
 * Walk one workflow's steps.
 *
 * Deliberately shallow: it tracks indentation rather than modelling YAML, because the only question
 * asked is "does this list item carry a run/uses key". Anything it cannot confidently read is
 * REPORTED, never skipped.
 *
 * @param {string} text
 * @returns {{jobs: number, steps: number, problems: {line: number, name: string}[], readable: boolean}}
 */
/**
 * The GITHUB_TOKEN permission scopes Actions accepts. Closed set, from the workflow syntax
 * reference — there is no way to enumerate it at runtime, and getting it wrong in the PERMISSIVE
 * direction is the only mistake that matters here.
 */
export const PERMISSION_SCOPES = new Set([
	"actions",
	"attestations",
	"checks",
	"contents",
	"deployments",
	"discussions",
	"id-token",
	"issues",
	"models",
	"packages",
	"pages",
	"pull-requests",
	"repository-projects",
	"security-events",
	"statuses",
]);

/** The three access levels a scope may be granted. */
const PERMISSION_LEVELS = new Set(["read", "write", "none"]);

/** Shorthands that stand in for the whole mapping. */
const PERMISSION_SHORTHANDS = new Set(["read-all", "write-all", "{}"]);

/**
 * Nearest valid scope by edit distance, so a refusal can say what was probably meant. A guard that
 * only says no is one people learn to route around; `administration` → `attestations` is not a
 * useful suggestion, so anything past a small distance is left unsuggested rather than guessed.
 */
function nearestScope(key) {
	let best = null;
	let bestD = Infinity;
	for (const scope of PERMISSION_SCOPES) {
		const d = editDistance(key, scope);
		if (d < bestD) {
			bestD = d;
			best = scope;
		}
	}
	return bestD <= 3 ? best : null;
}

function editDistance(a, b) {
	const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
	for (let i = 1; i <= a.length; i++) {
		let diag = prev[0];
		prev[0] = i;
		for (let j = 1; j <= b.length; j++) {
			const tmp = prev[j];
			prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
			diag = tmp;
		}
	}
	return prev[b.length];
}

/**
 * Every `permissions:` mapping in one workflow, top-level and per-job, as `{line, key, value}`.
 *
 * WHY THIS IS WORTH A CHECK. An unrecognised permission scope does not degrade — Actions rejects
 * the WHOLE FILE, and the run completes with zero jobs and an empty status rollup. On 2026-08-28 an
 * `administration: read` added to workflow-health.yml (#3229, chasing a ruleset read that does not
 * need it) took the daily health workflow off the air entirely. Four runs failed with no jobs and
 * no annotation anyone saw, on `dev` and on three feature branches, and it was noticed only because
 * somebody went looking at that workflow for an unrelated reason.
 *
 * That is the same failure this file already guards for a step with no `run:`/`uses:` — a workflow
 * that stops existing rather than going red — arriving through a different key. `yaml.parse()`
 * accepts it, so parsing proves nothing here either.
 *
 * Line-scanned, matching the rest of this file: a `permissions:` key, then the indented `k: v`
 * pairs beneath it until the indentation returns.
 */
export function scanPermissions(text) {
	const lines = text.split("\n");
	const entries = [];
	for (let i = 0; i < lines.length; i++) {
		const head = lines[i].match(/^(\s*)permissions:\s*(\S.*)?$/);
		if (head === null) continue;
		const indent = head[1].length;
		const inline = (head[2] ?? "").replace(/\s*#.*$/, "").trim();
		if (inline !== "") {
			// `permissions: read-all` / `write-all` / `{}` — a whole-mapping shorthand, not a scope.
			entries.push({ line: i + 1, key: null, shorthand: inline });
			continue;
		}
		for (let j = i + 1; j < lines.length; j++) {
			if (lines[j].trim() === "" || /^\s*#/.test(lines[j])) continue;
			const lead = lines[j].match(/^(\s*)/)?.[1].length ?? 0;
			if (lead <= indent) break;
			const pair = lines[j].match(/^\s*([A-Za-z0-9_-]+):\s*([^#]*?)\s*(?:#.*)?$/);
			if (pair === null) break;
			entries.push({ line: j + 1, key: pair[1], value: pair[2] });
		}
	}
	return entries;
}

export function scanWorkflow(text) {
	const lines = text.split("\n");
	const jobsAt = lines.findIndex((l) => /^jobs:\s*$/.test(l));
	if (jobsAt === -1) return { jobs: 0, steps: 0, problems: [], readable: false };

	let jobs = 0;
	let steps = 0;
	const problems = [];

	for (let i = jobsAt + 1; i < lines.length; i++) {
		if (/^ {2}[A-Za-z0-9_-]+:\s*$/.test(lines[i])) jobs += 1;
		// A steps list item, at any indent — jobs nest their `steps:` at a known depth, but matrix
		// and reusable-workflow shapes vary, so the item marker is what is matched.
		const head = lines[i].match(/^(\s+)-\s+(\S.*)$/);
		if (head === null) continue;
		const indent = head[1].length;
		// Only list items INSIDE a steps: block count. Walk back to the nearest key at a shallower
		// indent and require it to be `steps:`; this is what keeps `on:`/`with:`/`paths:` lists out.
		let owner = null;
		for (let b = i - 1; b > jobsAt; b--) {
			const key = lines[b].match(/^(\s*)([A-Za-z0-9_-]+):\s*$/);
			if (key === null) continue;
			if (key[1].length < indent) {
				owner = key[2];
				break;
			}
		}
		if (owner !== "steps") continue;

		steps += 1;
		// The step's own keys run from its head line to the next item at the same indent, or to a
		// line at a shallower indent (the end of the list).
		let hasAction = /^(run|uses):/.test(head[2]);
		let name = head[2];
		for (let j = i + 1; j < lines.length; j++) {
			if (new RegExp(`^\\s{${indent}}-\\s`).test(lines[j])) break;
			if (lines[j].trim() !== "" && (lines[j].match(/^(\s*)/)?.[1].length ?? 0) <= indent && !/^\s*#/.test(lines[j])) break;
			if (new RegExp(`^\\s{${indent + 2}}(run|uses):`).test(lines[j])) hasAction = true;
			const n = lines[j].match(/^\s+name:\s*(.+)$/);
			if (n && !/^name:/.test(name)) name = n[1];
		}
		if (!hasAction) {
			problems.push({ line: i + 1, name: name.replace(/^name:\s*/, "").trim() });
		}
	}
	return { jobs, steps, problems, readable: true };
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
	// A repo with no workflows is not a repo this check should pass in silence.
	if (files.length === 0) {
		return [`no workflow files found in ${dir} — the matcher has stopped matching, or the directory moved.`];
	}

	let totalSteps = 0;
	let unreadable = 0;
	let permissionEntries = 0;
	for (const f of files.sort()) {
		const text = readFile(path.join(dir, f));
		const { jobs, steps, problems, readable } = scanWorkflow(text);
		if (!readable) {
			// A workflow with no `jobs:` block at all is a shape this parser does not understand.
			// Counted and reported rather than skipped — see the total-steps guard below.
			unreadable += 1;
			continue;
		}
		totalSteps += steps;
		for (const p of scanPermissions(text)) {
			permissionEntries += 1;
			if (p.key === null) {
				if (!PERMISSION_SHORTHANDS.has(p.shorthand)) {
					out.push(
						`${dir}/${f}:${p.line}: \`permissions: ${p.shorthand}\` is not one of ${[...PERMISSION_SHORTHANDS].join(", ")}. ` +
							"Actions REJECTS the whole file for an unrecognised permissions value — the workflow stops running entirely, " +
							"with zero jobs and no red step to explain it.",
					);
				}
				continue;
			}
			if (!PERMISSION_SCOPES.has(p.key)) {
				const near = nearestScope(p.key);
				out.push(
					`${dir}/${f}:${p.line}: \`${p.key}\` is not a GITHUB_TOKEN permission scope${near ? `. Did you mean \`${near}\`?` : "."} ` +
						"An unknown key does not degrade — Actions REJECTS the whole file, so the workflow silently stops running: " +
						"zero jobs, an empty status rollup, and nothing red anywhere. That is how #3229 took workflow-health off the air. " +
						`The scopes are: ${[...PERMISSION_SCOPES].join(", ")}.`,
				);
				continue;
			}
			if (!PERMISSION_LEVELS.has(p.value)) {
				out.push(
					`${dir}/${f}:${p.line}: \`${p.key}: ${p.value}\` — the level must be one of ${[...PERMISSION_LEVELS].join(", ")}. ` +
						"An unrecognised value rejects the file exactly as an unknown key does.",
				);
			}
		}
		if (jobs === 0) {
			out.push(`${dir}/${f}: a \`jobs:\` block with no jobs under it — Actions would reject this file, producing a run with zero jobs and an EMPTY status rollup.`);
		}
		for (const p of problems) {
			out.push(
				`${dir}/${f}:${p.line}: the step \`${p.name}\` has neither \`run:\` nor \`uses:\`. ` +
					"Actions REJECTS the whole file for this — the run completes with zero jobs, so not one required " +
					"check reports and the PR sits BLOCKED with an empty rollup instead of going red.",
			);
		}
	}

	// THE BLINDNESS GUARD. Every failure above is "this file is wrong"; this one is "I am wrong".
	// A parser that stopped understanding the layout finds no steps and reports a clean bill of
	// health, which is precisely the shape this whole check exists to remove from the repo.
	if (totalSteps === 0) {
		out.push(
			`parsed ${files.length} workflow file(s) and found ZERO steps. There are hundreds, so this ` +
				"parser has stopped matching — fix it rather than trusting the green.",
		);
	}
	// The same blindness guard, for the permissions scanner. Every workflow in this repo declares
	// permissions; finding none means the scanner stopped matching, and a scanner that finds nothing
	// reports a clean bill of health.
	if (permissionEntries === 0) {
		out.push(
			`parsed ${files.length} workflow file(s) and found ZERO \`permissions:\` entries. Every workflow here declares them, ` +
				"so this scanner has stopped matching — fix it rather than trusting the green.",
		);
	}
	if (unreadable === files.length) {
		out.push(`none of the ${files.length} workflow files had a \`jobs:\` block this parser could find.`);
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

	// THE EXACT INPUT THAT PRODUCED THIS ISSUE, from feat/badge-honesty.
	const BAD = `name: x
jobs:
  badge:
    runs-on: ubuntu-latest
    steps:
      - name: Compute aggregate Go coverage
        run: node scripts/go-coverage-badge.mjs
      - name: Commit the badge if it changed
      - name: Publish the badge
        run: |
          echo hi
`;
	const bad = scanWorkflow(BAD);
	ok("the known-bad step is found", bad.problems.length === 1, JSON.stringify(bad.problems));

	// ── permissions (#3229's regression, and the class) ───────────────────────────────────────────
	//
	// The negatives first. An unknown scope does not degrade — Actions rejects the WHOLE file, the
	// run completes with ZERO jobs, and nothing goes red: on 2026-08-28 an `administration: read`
	// took workflow-health off the air across dev and three branches, and it was found only because
	// somebody opened that workflow for an unrelated reason.
	const permsOf = (body) => scanPermissions(`name: x\n${body}jobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: true\n`);
	const checkOne = (body) =>
		check(
			"wf",
			() => ["w.yml"],
			() => `name: x\n${body}jobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: true\n`,
		);

	const REAL = "permissions:\n  contents: read\n  administration: read # the #3229 regression\n  issues: write\n";
	ok("the exact #3229 line is refused", checkOne(REAL).some((p) => /`administration` is not a GITHUB_TOKEN permission scope/.test(p)), JSON.stringify(checkOne(REAL)));
	// A refusal that does not name the consequence reads as pedantry, and this consequence is the
	// entire reason the check exists: the workflow stops running rather than failing.
	ok("...and it names the consequence, not just the rule", checkOne(REAL).some((p) => /zero jobs/.test(p)));
	ok("...and lists the scopes that ARE accepted", checkOne(REAL).some((p) => /pull-requests/.test(p)));

	ok("a near-miss gets a suggestion", checkOne("permissions:\n  content: read\n").some((p) => /Did you mean `contents`\?/.test(p)));
	// And a key that resembles nothing gets no invented suggestion. `administration` → `attestations`
	// would be a confident wrong answer, which is worse than none.
	ok("...and a key resembling nothing is not given a guessed one", !checkOne(REAL).some((p) => /Did you mean/.test(p)));

	ok("a bad LEVEL is refused too", checkOne("permissions:\n  contents: readonly\n").some((p) => /the level must be one of/.test(p)));

	// The positives. A rule that fires on the repo's own workflows is not a check.
	ok("every real scope passes", checkOne("permissions:\n  contents: read\n  id-token: write\n  pull-requests: write\n  security-events: write\n  none-check: none\n".replace("  none-check: none\n", "  checks: none\n")).length === 0);
	ok("a trailing comment does not become part of the level", checkOne("permissions:\n  contents: read # a comment mentioning administration\n").length === 0);
	ok("the read-all shorthand passes", checkOne("permissions: read-all\n").length === 0);
	ok("the write-all shorthand passes", checkOne("permissions: write-all\n").length === 0);
	ok("the empty-mapping shorthand passes", checkOne("permissions: {}\n").length === 0);
	ok("an unknown shorthand is refused", checkOne("permissions: all\n").some((p) => /is not one of/.test(p)));

	// Job-level permissions are the same key at a deeper indent, and are just as fatal.
	const JOBLEVEL = `name: x
jobs:
  a:
    runs-on: ubuntu-latest
    permissions:
      administration: read
    steps:
      - run: true
`;
	ok("a JOB-level bad scope is refused", check("wf", () => ["w.yml"], () => JOBLEVEL).some((p) => /`administration`/.test(p)));

	// The scanner must stop at the end of the mapping, or it swallows the rest of the file and
	// reports every key in the workflow as a bad permission scope.
	ok("the scan stops at the end of the block", permsOf("permissions:\n  contents: read\non:\n  push:\n").length === 1, JSON.stringify(permsOf("permissions:\n  contents: read\non:\n  push:\n")));

	// THE BLINDNESS GUARD, which is what makes a green result mean anything.
	ok(
		"a tree whose permissions cannot be found FAILS rather than passing",
		check("wf", () => ["w.yml"], () => "name: x\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: true\n").some((p) => /ZERO `permissions:` entries/.test(p)),
	);
	ok("...and it is named", bad.problems[0]?.name === "Commit the badge if it changed", JSON.stringify(bad.problems));
	ok("...and its siblings are not", bad.steps === 3, `steps=${bad.steps}`);

	const GOOD = BAD.replace("      - name: Commit the badge if it changed\n", "      - name: Commit the badge if it changed\n        run: git commit -am badge\n");
	ok("the same file with the step fixed is clean", scanWorkflow(GOOD).problems.length === 0, JSON.stringify(scanWorkflow(GOOD).problems));

	// A `uses:` step is as valid as a `run:` one.
	ok("a uses-only step is fine", scanWorkflow(`jobs:\n  a:\n    steps:\n      - uses: actions/checkout@v7\n`).problems.length === 0);
	ok("an inline `- run:` with no name is fine", scanWorkflow(`jobs:\n  a:\n    steps:\n      - run: pnpm i\n`).problems.length === 0);
	ok("a step with with: and uses: is fine",
		scanWorkflow(`jobs:\n  a:\n    steps:\n      - uses: x@v1\n        with:\n          k: v\n`).problems.length === 0);
	// A step whose `if:` comes first still needs an action.
	ok("an if-first step with a run is fine",
		scanWorkflow(`jobs:\n  a:\n    steps:\n      - name: n\n        if: \${{ !cancelled() }}\n        run: x\n`).problems.length === 0);
	ok("...and without one is caught",
		scanWorkflow(`jobs:\n  a:\n    steps:\n      - name: n\n        if: \${{ !cancelled() }}\n`).problems.length === 1);

	// Lists that are NOT steps must not be scanned — this is where a naive matcher goes wrong.
	const NOTSTEPS = `on:
  push:
    branches: [main]
    paths:
      - "apps/**"
      - "packages/**"
jobs:
  a:
    strategy:
      matrix:
        include:
          - project: console
          - project: cli
    steps:
      - run: echo hi
`;
	ok("on:/paths: list items are not steps", scanWorkflow(NOTSTEPS).problems.length === 0, JSON.stringify(scanWorkflow(NOTSTEPS).problems));
	ok("...and a matrix include is not a step either", scanWorkflow(NOTSTEPS).steps === 1, `steps=${scanWorkflow(NOTSTEPS).steps}`);

	// Blindness. Each of these would otherwise be a clean report.
	ok("a file with no jobs: block is unreadable, not clean", scanWorkflow("name: x\non: push\n").readable === false);
	const noDir = check("nope", () => { throw new Error("ENOENT"); });
	ok("an unreadable directory fails", /cannot run, which is not the same as passing/.test(noDir[0] ?? ""), JSON.stringify(noDir));
	const empty = check("d", () => []);
	ok("an empty directory fails", /no workflow files found/.test(empty[0] ?? ""), JSON.stringify(empty));
	const noSteps = check("d", () => ["a.yml"], () => "jobs:\n  a:\n    runs-on: x\n");
	ok("finding zero steps across every file fails", noSteps.some((p) => /found ZERO steps/.test(p)), JSON.stringify(noSteps));

	if (fails > 0) {
		console.error(`\ncheck-workflow-shape self-test: ${fails} failure(s)`);
		process.exit(1);
	}
	console.log("\nself-test: all passed");
}

// ── entry ─────────────────────────────────────────────────────────────────────────────────────
if (process.argv.includes("--self-test")) {
	selfTest();
} else {
	const problems = check();
	for (const p of problems) console.error(`::error::workflow-shape: ${p}`);
	if (problems.length > 0) {
		console.error(`\n${problems.length} problem(s) — Actions would reject a file and the PR would sit BLOCKED with an empty rollup.`);
		process.exit(1);
	}
	const files = fs.readdirSync(DIR).filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"));
	let steps = 0;
	let perms = 0;
	for (const f of files) {
		const text = fs.readFileSync(path.join(DIR, f), "utf8");
		steps += scanWorkflow(text).steps;
		perms += scanPermissions(text).length;
	}
	// The counts are printed because a green line that names no quantity is indistinguishable from a
	// green line produced by a scanner that matched nothing.
	console.log(
		`workflow-shape: ${files.length} workflow(s), ${steps} steps, every one carrying a \`run:\` or \`uses:\`; ` +
			`${perms} permission entr(ies), every scope and level one Actions accepts`,
	);
}
