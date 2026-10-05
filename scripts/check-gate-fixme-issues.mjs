#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
//
// A `{fixme}` IN THE RELEASE GATE'S LEDGER MUST CITE AN ISSUE THAT IS STILL OPEN (#5410).
//
// `apps/console/e2e/gate-baseline.json` records a known bug as `{fixme: "BUG: <what> #<n>"}`, and
// the ratchet (`scripts/e2e-ratchet.mjs`) REQUIRES that entry to stay skipped: a test recorded as a
// fixme that starts passing is a regression of the ledger, not a fix. That rule is right — it is what
// makes a fixme reviewable — and it has a consequence nobody instrumented: once the bug is FIXED, the
// test still never runs, so the fix can never show as passing. The `#n` is the only thing that could
// say "this skip is over", and nothing compared it with that issue's state.
//
// It was already wrong on `dev` when this was written (origin/dev @ 95a82e64b, 2026-10-03): all FOUR
// fixmes cited CLOSED issues — three on `flows/billing.spec.ts` citing #4633 (closed 2026-09-19) and
// one on `flows/cross-cutting.spec.ts` citing #4612 (closed 2026-09-18). Four tests the gate counted
// as "known bug, stays skipped" were guarding nothing.
//
// ── WHAT THIS ASKS ────────────────────────────────────────────────────────────────────────────────
//
// For every `{fixme}` in the ledger: is the issue it cites still OPEN?
//
//   exit 0  every cited issue is OPEN (or the ledger carries no fixme — printed in its own words, so
//           "found nothing" never renders like "found nothing wrong").
//   exit 1  at least one fixme cites a CLOSED issue. Each is named: project, spec, test title, issue.
//   exit 2  the instrument could not answer — an issue's state was unreadable (gh missing, no token,
//           rate limit, deleted issue, an unexpected state word), a fixme carries no parseable `#n`,
//           a fixme cites MORE than one `#n` (ambiguous — see below), or the ledger could not be read. NEVER 0: an unanswered question is not an open issue,
//           and assuming "open" is exactly how a stale fixme survives the guard written to catch it.
//           When findings AND blindness coexist the findings are still printed and the exit is 2,
//           because a partial answer must not read as a complete one.
//
// Whether a string IS a fixme is decided by the ratchet's OWN `FIXME_RE` — imported, not copied, so
// the two can never disagree about it. `FIXME_RE` is `/^BUG: .+#\d+/`, which requires AT LEAST one
// `#<digits>` and does not limit how many: "BUG: regressed by #12, tracked in #4612" is a fixme the
// ratchet accepts. Nothing structural says which of the two is the tracking issue, so a fixme citing
// more than one `#n` is AMBIGUOUS and exits 2 rather than silently checking one of them — picking the
// last would let a closed tracking issue hide behind an open "regressed by" reference, or vice versa.
// The fix is to cite exactly one issue in the fixme and move the other reference into the spec.
//
// ── WHAT THIS DOES NOT DO ─────────────────────────────────────────────────────────────────────────
//
// It never edits the ledger and never edits the ratchet.
//
// ── WHERE IT RUNS ─────────────────────────────────────────────────────────────────────────────────
//
// On PRs, in the release gate's `Gate ledger` job (`.github/workflows/release-gate.yml`, #5417),
// which runs on every non-draft PR and on `workflow_dispatch`:
//
//   · `--self-test` runs on every one of those runs.
//   · The live check (the one that asks GitHub) runs unconditionally on a PR into `main` or `staging`
//     and on a dispatch, because those ship the ledger as it stands. On a PR into `dev` it runs only
//     when the PR changes `apps/console/e2e/gate-baseline.json`, this script, or
//     `scripts/e2e-ratchet.mjs`: an issue closing is a state change in GitHub, not in the diff, so
//     asking on every dev PR would red PRs that touched nothing.
//
// That job is NOT a required check — no ruleset and nothing in `.mergify.yml` names it — so its red
// is visible on the PR and nothing enforces it.
//
// Daily, from `.github/workflows/gate-fixme-currency.yml` — but only once that workflow is on `main`.
// A `schedule:` runs the default branch's copy of the workflow, so until it has ridden
// dev → staging → main the daily run does not happen at all, and afterwards it checks main's ledger.
//
//   node scripts/check-gate-fixme-issues.mjs                    # live: asks GitHub (needs gh + token)
//   node scripts/check-gate-fixme-issues.mjs --self-test        # hermetic: fixtures + a mutation control
//   node scripts/check-gate-fixme-issues.mjs --baseline=<path>  # a different ledger file
//   node scripts/check-gate-fixme-issues.mjs --states-from=<file.json>  # fixture states, not GitHub
//
// `--states-from=<file.json>` replaces the GitHub reads with a `{ "<n>": "OPEN" | "CLOSED" | … }`
// map. It exists so `--self-test` can drive the REAL exit path in a child process; the workflow
// never passes it, and every run that uses it says so on stderr.
//
// Do NOT pipe this into `tail`/`head`: a pipe reports the exit code of the LAST command in it.

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { DEFAULT_BASELINE, FIXME_RE } from "./e2e-ratchet.mjs";

const SELF = fileURLToPath(import.meta.url);

const USAGE = "usage: node scripts/check-gate-fixme-issues.mjs [--baseline=<path>] [--states-from=<file.json>] [--self-test]";
const ROOT = path.resolve(path.dirname(SELF), "..");

export const EXIT_OK = 0;
export const EXIT_CLOSED = 1;
export const EXIT_BLIND = 2;

/**
 * @typedef {{project: string, spec: string, title: string, fixme: string, issue: number | null, cited: number[]}} Fixme
 * @typedef {{state: string, error: string}} StateRead
 */

/**
 * Every `#<digits>` a fixme cites, in order, or [] when the string is not a fixme the ratchet would
 * accept. More than one entry means the fixme is ambiguous.
 *
 * @param {string} fixme
 * @returns {number[]}
 */
export function citedIssues(fixme) {
	if (!FIXME_RE.test(fixme)) return [];
	return [...fixme.matchAll(/#(\d+)/g)].map((m) => Number(m[1]));
}

/**
 * The ONE issue a fixme cites, or null when it is not a fixme the ratchet would accept OR it cites
 * more than one `#n` (ambiguous — `decide` reports that as its own bucket).
 *
 * @param {string} fixme
 * @returns {number | null}
 */
export function citedIssue(fixme) {
	const cited = citedIssues(fixme);
	return cited.length === 1 ? cited[0] : null;
}

/**
 * Every `{fixme}` entry in a parsed ledger, in ledger order, plus how many entries were walked in
 * total — the second number is the vacuity floor: a walk that read zero entries did not read the
 * ledger, whatever it found.
 *
 * @param {unknown} doc the parsed gate-baseline.json
 * @returns {{fixmes: Fixme[], entries: number}}
 */
export function fixmesIn(doc) {
	/** @type {Fixme[]} */
	const fixmes = [];
	let entries = 0;
	const projects = isObject(doc) ? doc.projects : undefined;
	if (!isObject(projects)) return { fixmes, entries };
	for (const [project, specs] of Object.entries(projects)) {
		if (!isObject(specs)) continue;
		for (const [spec, tests] of Object.entries(specs)) {
			if (!isObject(tests)) continue;
			for (const [title, recorded] of Object.entries(tests)) {
				entries += 1;
				if (isObject(recorded) && typeof recorded.fixme === "string") {
					fixmes.push({ project, spec, title, fixme: recorded.fixme, issue: citedIssue(recorded.fixme), cited: citedIssues(recorded.fixme) });
				}
			}
		}
	}
	return { fixmes, entries };
}

/**
 * Narrow an unknown to a plain object.
 *
 * @param {unknown} v
 * @returns {v is Record<string, unknown>}
 */
function isObject(v) {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * The verdict, given the fixmes and each cited issue's state. Pure — the deciding half is separated
 * from the asking half because only the deciding half can be wrong in a way a fixture can catch.
 *
 * @param {Fixme[]} fixmes
 * @param {Map<number, StateRead>} states issue number → what reading its state produced
 * @returns {{code: number, open: Fixme[], closed: Fixme[], ambiguous: Fixme[], unparseable: Fixme[], unreadable: Fixme[]}}
 */
export function decide(fixmes, states) {
	/** @type {Fixme[]} */ const ambiguous = [];
	/** @type {Fixme[]} */ const open = [];
	/** @type {Fixme[]} */ const closed = [];
	/** @type {Fixme[]} */ const unparseable = [];
	/** @type {Fixme[]} */ const unreadable = [];
	for (const f of fixmes) {
		if (f.cited.length > 1) {
			ambiguous.push(f);
			continue;
		}
		if (f.issue === null) {
			unparseable.push(f);
			continue;
		}
		const state = states.get(f.issue)?.state ?? "";
		if (state === "OPEN") open.push(f);
		else if (state === "CLOSED") closed.push(f);
		// Anything else — empty, an unexpected word, a missing read — is NOT open and NOT closed.
		// Bucketing it with either would be the guard answering a question it got no answer to.
		else unreadable.push(f);
	}
	const blind = ambiguous.length + unparseable.length + unreadable.length > 0;
	const code = blind ? EXIT_BLIND : closed.length > 0 ? EXIT_CLOSED : EXIT_OK;
	return { code, open, closed, ambiguous, unparseable, unreadable };
}

/**
 * Ask GitHub for one issue's state. gh's own diagnostic is KEPT on failure: a missing `gh`, a token
 * without `issues: read`, a deleted issue, a rate limit and a dead network all land here and send
 * an operator to five different places.
 *
 * @param {number} n
 * @returns {StateRead}
 */
function readStateFromGitHub(n) {
	const repo = process.env.GITHUB_REPOSITORY;
	const args = ["issue", "view", String(n), "--json", "state", "--jq", ".state", ...(repo ? ["--repo", repo] : [])];
	try {
		const out = execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
		return { state: out.trim(), error: "" };
	} catch (err) {
		const e = /** @type {{stderr?: Buffer|string, message?: string}} */ (err);
		const stderr = typeof e.stderr === "string" ? e.stderr : e.stderr?.toString("utf8");
		const reason = (stderr || e.message || String(err)).trim().split("\n")[0];
		return { state: "", error: reason || "gh failed with no diagnostic" };
	}
}

/**
 * A state reader backed by a fixture map, for `--states-from`. A number the map does not name reads
 * as unreadable — never as open.
 *
 * @param {Record<string, unknown>} map
 * @returns {(n: number) => StateRead}
 */
function readStateFromMap(map) {
	return (n) => {
		const v = map[String(n)];
		return typeof v === "string" ? { state: v, error: "" } : { state: "", error: `#${n} is not in the --states-from fixture` };
	};
}

/**
 * Render one fixme for a report line.
 *
 * @param {Fixme} f
 * @returns {string}
 */
function describe(f) {
	const cites = f.cited.length === 0 ? "(no #n)" : f.cited.map((n) => `#${n}`).join(", ");
	return `[${f.project}] ${f.spec} › ${f.title} — cites ${cites}`;
}

/**
 * Parse argv. Unknown flags are collected, not ignored, so a typo cannot silently run the live check.
 *
 * @param {string[]} argv
 */
function parseArgs(argv) {
	const out = { selfTest: false, baseline: path.join(ROOT, DEFAULT_BASELINE), statesFrom: "", help: false, unknown: /** @type {string[]} */ ([]) };
	for (const a of argv) {
		if (a === "--self-test") out.selfTest = true;
		else if (a === "--help" || a === "-h") out.help = true;
		else if (a.startsWith("--baseline=")) out.baseline = path.resolve(a.slice("--baseline=".length));
		else if (a.startsWith("--states-from=")) out.statesFrom = path.resolve(a.slice("--states-from=".length));
		else out.unknown.push(a);
	}
	return out;
}

/**
 * The live check (or a fixture-driven one under `--states-from`). Returns the exit code.
 *
 * @param {string[]} argv
 * @returns {number}
 */
export function main(argv) {
	const args = parseArgs(argv);
	if (args.help) {
		console.log(USAGE);
		return EXIT_OK;
	}
	if (args.unknown.length > 0) {
		console.error(`::error::check-gate-fixme-issues: unknown argument(s): ${args.unknown.join(" ")}`);
		return EXIT_BLIND;
	}
	if (args.selfTest) return selfTest();

	let doc;
	try {
		doc = JSON.parse(fs.readFileSync(args.baseline, "utf8"));
	} catch (err) {
		console.error(`::error::check-gate-fixme-issues: cannot read ${args.baseline}: ${err instanceof Error ? err.message : String(err)}`);
		return EXIT_BLIND;
	}
	const { fixmes, entries } = fixmesIn(doc);
	const rel = path.relative(ROOT, args.baseline) || args.baseline;
	if (entries === 0) {
		console.error(`::error::check-gate-fixme-issues: walked ZERO entries in ${rel} — the ledger's shape is not the one this reads.`);
		console.error("  This is NOT a pass: a walk that read nothing cannot say whether any fixme is stale.");
		return EXIT_BLIND;
	}
	if (fixmes.length === 0) {
		console.log(`◻ ${rel} carries NO {fixme} (${entries} entries walked) — this check asserted nothing, which is not an error.`);
		console.log("  That it can still discriminate is proven by --self-test, which flips a fixture issue OPEN → CLOSED and asserts the run reds.");
		return EXIT_OK;
	}

	let read = readStateFromGitHub;
	if (args.statesFrom) {
		console.error(`note: issue states come from the fixture ${args.statesFrom}, NOT from GitHub.`);
		let map;
		try {
			map = JSON.parse(fs.readFileSync(args.statesFrom, "utf8"));
		} catch (err) {
			console.error(`::error::check-gate-fixme-issues: cannot read --states-from: ${err instanceof Error ? err.message : String(err)}`);
			return EXIT_BLIND;
		}
		read = readStateFromMap(isObject(map) ? map : {});
	}

	// One read per DISTINCT issue: three fixmes citing #4633 is one question, not three.
	const numbers = [...new Set(fixmes.map((f) => f.issue).filter((n) => n !== null))].sort((a, b) => a - b);
	const states = new Map(numbers.map((n) => [n, read(n)]));
	const v = decide(fixmes, states);

	console.log(`check-gate-fixme-issues: ${fixmes.length} {fixme} in ${rel}, citing ${numbers.length} distinct issue(s)`);
	for (const f of v.open) console.log(`  ✓ ${describe(f)} (OPEN)`);

	if (v.closed.length > 0) {
		console.error(`::error::check-gate-fixme-issues: ${v.closed.length} {fixme} in ${rel} cite a CLOSED issue.`);
		for (const f of v.closed) console.error(`  ✗ ${describe(f)} (CLOSED)`);
		console.error("  The ratchet keeps a {fixme} SKIPPED, so a fixed bug behind one can never show as passing.");
		console.error("  Either the bug is fixed — drop the test.fixme, run it, and move the ledger with");
		console.error("  `node scripts/e2e-ratchet.mjs --project=<p> --results=<json> --write --only=<spec>` in the same PR — or it is still true");
		console.error("  and needs an OPEN issue: reopen it, or file one and cite that.");
	}
	if (v.ambiguous.length > 0) {
		console.error(`::error::check-gate-fixme-issues: ${v.ambiguous.length} {fixme} cite MORE than one issue — which one tracks the bug is ambiguous.`);
		for (const f of v.ambiguous) console.error(`  ? ${describe(f)}: ${JSON.stringify(f.fixme)}`);
		console.error("  Cite exactly ONE #n (the issue that tracks this bug) and move any other reference into the spec.");
	}
	if (v.unparseable.length > 0) {
		console.error(`::error::check-gate-fixme-issues: ${v.unparseable.length} {fixme} carry no issue FIXME_RE can read ("BUG: … #<n>").`);
		for (const f of v.unparseable) console.error(`  ? ${describe(f)}: ${JSON.stringify(f.fixme)}`);
	}
	if (v.unreadable.length > 0) {
		console.error(`::error::check-gate-fixme-issues: could not read the state of ${v.unreadable.length} cited issue(s).`);
		for (const f of v.unreadable) {
			const r = f.issue === null ? undefined : states.get(f.issue);
			const why = r?.error || (r?.state ? `unexpected state ${JSON.stringify(r.state)}` : "(no diagnostic)");
			console.error(`  ? ${describe(f)}: ${why}`);
		}
		console.error("  This is NOT a pass. Without an answer the check cannot tell an open issue from a closed one.");
		console.error("  If the diagnostics mention permissions, the job needs `issues: read`.");
	}
	if (v.code === EXIT_OK) console.log(`✓ every {fixme} in ${rel} cites an OPEN issue (${v.open.length} of ${fixmes.length})`);
	return v.code;
}

// ── --self-test ───────────────────────────────────────────────────────────────────────────────────

/**
 * Run this script as a child process and return its exit code — the self-test asserts on what the
 * process EXITS with, never on what it prints.
 *
 * @param {string[]} args
 * @param {Record<string, string>} [env]  overrides on top of the (token-stripped) parent environment
 * @returns {number}
 */
function runChild(args, env = {}) {
	const r = spawnSync(process.execPath, [SELF, ...args], { encoding: "utf8", env: { ...process.env, GH_TOKEN: "", GITHUB_TOKEN: "", ...env } });
	return typeof r.status === "number" ? r.status : -1;
}

/**
 * Hermetic self-test: the pure halves in both directions, then the real CLI's exit codes against
 * fixture ledgers and fixture states — including the mutation control, a fixture flipped from OPEN
 * to CLOSED that must turn the run red. Returns non-zero on any failed assertion.
 *
 * @returns {number}
 */
function selfTest() {
	let failures = 0;
	/** @param {string} label @param {boolean} cond */
	const ok = (label, cond) => {
		console.log(`${cond ? "ok  " : "FAIL"} - ${label}`);
		if (!cond) failures++;
	};

	// citedIssue — the extraction rides FIXME_RE, so these also pin what that regex accepts.
	ok("a fixme's #n is extracted", citedIssue("BUG: the thing breaks #4633") === 4633);
	ok("two #n → no single cited issue (ambiguous)", citedIssue("BUG: regressed by #12, tracked in #4612") === null);
	ok("…but both are reported as cited", JSON.stringify(citedIssues("BUG: regressed by #12, tracked in #4612")) === "[12,4612]");
	ok("a fixme without BUG: is not one", citedIssue("the thing breaks #4633") === null);
	ok("a fixme without #n is not one", citedIssue("BUG: the thing breaks") === null);

	// fixmesIn
	const ledger = (/** @type {Record<string, unknown>} */ tests) => ({ version: 1, projects: { qa: { "flows/a.spec.ts": tests } } });
	const doc = ledger({ passes: "passed", fails: "failed", skip: { skip: "no org" }, fx: { fixme: "BUG: x #10" }, fy: { fixme: "BUG: y #20" } });
	const found = fixmesIn(doc);
	ok("every entry is walked", found.entries === 5);
	ok("only {fixme} entries are returned", found.fixmes.length === 2 && found.fixmes.every((f) => f.title.startsWith("f")));
	ok("a {skip} is not a fixme", !found.fixmes.some((f) => f.title === "skip"));
	ok("a non-ledger walks zero entries", fixmesIn({}).entries === 0 && fixmesIn(null).entries === 0);

	// decide — every bucket, and the precedence between them.
	const st = (/** @type {Record<number, string>} */ m) => new Map(Object.entries(m).map(([n, s]) => [Number(n), { state: s, error: "" }]));
	ok("all OPEN → 0", decide(found.fixmes, st({ 10: "OPEN", 20: "OPEN" })).code === EXIT_OK);
	ok("one CLOSED → 1", decide(found.fixmes, st({ 10: "OPEN", 20: "CLOSED" })).code === EXIT_CLOSED);
	ok("an empty state → 2, never 0", decide(found.fixmes, st({ 10: "OPEN", 20: "" })).code === EXIT_BLIND);
	ok("an unexpected state word → 2", decide(found.fixmes, st({ 10: "OPEN", 20: "MERGED" })).code === EXIT_BLIND);
	ok("a missing read → 2", decide(found.fixmes, st({ 10: "OPEN" })).code === EXIT_BLIND);
	ok("CLOSED plus unreadable → 2 (a partial answer is not a complete one)", decide(found.fixmes, st({ 10: "CLOSED" })).code === EXIT_BLIND);
	ok("a fixme with no #n → 2", decide([{ project: "qa", spec: "s", title: "t", fixme: "BUG: no number", issue: null, cited: [] }], new Map()).code === EXIT_BLIND);
	{
		const amb = fixmesIn(ledger({ fz: { fixme: "BUG: regressed by #12, tracked in #4612" } })).fixmes;
		const v = decide(amb, st({ 12: "OPEN", 4612: "OPEN" }));
		ok("a fixme citing two #n → 2 even when both are OPEN", v.code === EXIT_BLIND && v.ambiguous.length === 1);
	}

	// The real CLI, by exit code, against fixture files.
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gate-fixme-"));
	const write = (/** @type {string} */ name, /** @type {unknown} */ value) => {
		const p = path.join(dir, name);
		fs.writeFileSync(p, JSON.stringify(value));
		return p;
	};
	try {
		const base = write("baseline.json", doc);
		/** @type {Record<string, string>} */
		const openStates = { 10: "OPEN", 20: "OPEN" };
		const openFile = write("open.json", openStates);
		ok("CLI: every fixme cites an OPEN issue → exit 0", runChild([`--baseline=${base}`, `--states-from=${openFile}`]) === EXIT_OK);

		// THE MUTATION CONTROL: the same fixture, one issue flipped OPEN → CLOSED. Prove the mutation
		// applied before trusting its result — a mutation that silently did not apply passes.
		const mutated = { ...openStates, 20: "CLOSED" };
		const keys = [...new Set([...Object.keys(openStates), ...Object.keys(mutated)])];
		const differing = keys.filter((k) => openStates[k] !== mutated[k]);
		ok(
			"mutation applied: the fixture differs from the OPEN one in exactly one issue (#20, OPEN → CLOSED)",
			keys.length === Object.keys(openStates).length && differing.length === 1 && differing[0] === "20" && mutated[20] === "CLOSED",
		);
		const closedFile = write("closed.json", mutated);
		ok("CLI MUTATION: one issue flipped OPEN → CLOSED turns the run red → exit 1", runChild([`--baseline=${base}`, `--states-from=${closedFile}`]) === EXIT_CLOSED);

		ok("CLI: a state the fixture does not name → exit 2", runChild([`--baseline=${base}`, `--states-from=${write("partial.json", { 10: "OPEN" })}`]) === EXIT_BLIND);
		ok("CLI: an empty state string → exit 2", runChild([`--baseline=${base}`, `--states-from=${write("empty.json", { 10: "OPEN", 20: "" })}`]) === EXIT_BLIND);
		ok(
			"CLI: a fixme citing two #n → exit 2 (ambiguous), even with both OPEN",
			runChild([`--baseline=${write("twonum.json", ledger({ f: { fixme: "BUG: regressed by #10, tracked in #20" } }))}`, `--states-from=${openFile}`]) === EXIT_BLIND,
		);
		// The LIVE reader's fail-closed path: no --states-from and a PATH with no `gh` on it, so
		// readStateFromGitHub's catch runs for real. It must answer 2 — never treat the failure as OPEN.
		const noGhBin = fs.mkdtempSync(path.join(os.tmpdir(), "gate-fixme-nogh-"));
		try {
			ok("CLI: gh unavailable (no --states-from, PATH without gh) → exit 2, never 0", runChild([`--baseline=${base}`], { PATH: noGhBin }) === EXIT_BLIND);
		} finally {
			fs.rmSync(noGhBin, { recursive: true, force: true });
		}
		ok("CLI: a fixme with no #n → exit 2", runChild([`--baseline=${write("nonum.json", ledger({ f: { fixme: "BUG: nothing cited" } }))}`, `--states-from=${openFile}`]) === EXIT_BLIND);
		ok("CLI: a ledger whose shape it cannot walk → exit 2", runChild([`--baseline=${write("shape.json", { tests: {} })}`, `--states-from=${openFile}`]) === EXIT_BLIND);
		ok("CLI: a missing ledger → exit 2", runChild([`--baseline=${path.join(dir, "absent.json")}`, `--states-from=${openFile}`]) === EXIT_BLIND);
		ok("CLI: a ledger with no fixme → exit 0 (stated as asserting nothing)", runChild([`--baseline=${write("none.json", ledger({ p: "passed" }))}`, `--states-from=${openFile}`]) === EXIT_OK);
		ok("CLI: an unknown flag → exit 2, not a live run", runChild(["--baselin=typo"]) === EXIT_BLIND);
		ok("--help names every flag", ["--baseline=", "--states-from=", "--self-test"].every((f) => USAGE.includes(f)));
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}

	// The REAL ledger, scanned without the network: every fixme in it must yield an issue number,
	// or the live run would go blind on it.
	try {
		const real = fixmesIn(JSON.parse(fs.readFileSync(path.join(ROOT, DEFAULT_BASELINE), "utf8")));
		ok(`the real ledger is walkable (${real.entries} entries)`, real.entries > 0);
		ok(`every {fixme} in the real ledger cites exactly one #n (${real.fixmes.length} fixme(s))`, real.fixmes.every((f) => f.issue !== null && f.cited.length === 1));
	} catch (err) {
		ok(`the real ledger is readable: ${err instanceof Error ? err.message : String(err)}`, false);
	}

	console.log(failures === 0 ? "\nself-test: all passed" : `\nself-test: ${failures} FAILED`);
	return failures === 0 ? EXIT_OK : EXIT_CLOSED;
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === SELF;
if (invokedDirectly) {
	try {
		process.exit(main(process.argv.slice(2)));
	} catch (err) {
		console.error(`::error::check-gate-fixme-issues: ${err instanceof Error ? err.message : String(err)}`);
		process.exit(EXIT_BLIND);
	}
}
