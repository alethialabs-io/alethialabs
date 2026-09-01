#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// An e2e exclusion's tracking issue must still be OPEN, and nothing checked it.
//
// `test/e2e/addon_exclusions.go` withholds a catalog add-on from the `addons` dimension's
// convergence assertion, and each entry carries an `Issue` so the exclusion cannot become
// permanent by being forgotten. The field's own docstring states the contract:
//
//     It must be OPEN: a CLOSED issue defeats the whole point of the field, and that is not
//     hypothetical — external-dns cited #2734 for two days after #2777 closed it by fixing the
//     very gap the Why described.
//
// `addon_exclusions_pure_test.go` checks `^#\d+$` — the SHAPE. Shape is not state, so the contract
// the docstring spells out was enforced by nobody, and it was already violated on `dev`: the sole
// entry cited #2717, closed on 2026-08-29. The prose said the right thing for six days and the
// tree disagreed with it.
//
// WHY THIS IS NOT A GO TEST. The question needs the network, and every existing check in
// `addon_exclusions_pure_test.go` is pure by design — the file is `_pure_test.go` and runs on every
// PR with no credentials. Putting a GitHub call in it would make the whole file conditional on the
// API, which is how a pure guard becomes a flaky one. So the state question lives here, beside the
// other CI guards, where failing closed on an unreachable API costs a re-run and not a suite.
//
// WHY ONLY addon_exclusions.go. `test/e2e/t2_cli_demo.go` carries an `Issue` field too, and all
// four of its numbers are ALSO closed — but its contract is different, and stated differently:
// "Required for CLIGap and CloudManual — the maintainer's ruling is that every one of these is
// filed, so a verdict without a number is an unkept promise." FILED, not OPEN. Two of the four are
// permanent CLOUD CEILINGS (#2332 hetzner Object Storage keys, #2333 alibaba CR EE), and a ceiling
// does not lift because its issue was closed. Applying this file's rule there would red the build
// over four entries that may be entirely correct, which is a ruling for the maintainer to make and
// not for a guard to assume. It is reported rather than enforced — see the notice this prints.
//
// FAIL-CLOSED. An issue whose state cannot be read is an ERROR, not an "assume open". A guard that
// answers "no problem" for "I could not ask" is the defect class this repository has paid for more
// than once: the report and the silence must not render the same.
//
// Usage:
//   node scripts/check-exclusion-issues.mjs              # the check (needs `gh` + a token)
//   node scripts/check-exclusion-issues.mjs --self-test  # the pure halves, no network

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** The file whose contract is "the Issue must be OPEN", and the field that carries it. */
const GUARDED = "test/e2e/addon_exclusions.go";

/**
 * Files that carry a tracking-issue field under a DIFFERENT contract ("filed", not "open"). Named
 * so the notice can point at them rather than leaving the reader to assume this guard covers every
 * `Issue:` in the tree.
 */
const REPORTED_ONLY = ["test/e2e/t2_cli_demo.go"];

/**
 * Every issue number a Go source file records in an `Issue:` struct field.
 *
 * It matches the FIELD, not a bare `#1234` — the exclusion files are dense with prose citing runs
 * and issues by number, and a text scan would hand this guard forty numbers it has no contract
 * over. Anchoring on `Issue:` mirrors the emitter: the struct field is the promise, the prose is
 * commentary.
 *
 * @param {string} source the file's contents
 * @returns {number[]} the issue numbers, de-duplicated, in ascending order
 */
export function issueNumbersIn(source) {
	const found = new Set();
	// `Issue:` then optional whitespace then a quoted "#<digits>". gofmt aligns the value, so the
	// gap is one-or-more spaces or tabs, and a line-anchored match keeps a mention inside a comment
	// (`// Issue: "#1" was wrong`) out — comments are stripped below before this runs.
	for (const m of source.matchAll(/^\s*Issue:\s*"#(\d+)"\s*,/gm)) found.add(Number(m[1]));
	return [...found].sort((a, b) => a - b);
}

/**
 * Strip `//` line comments so a number quoted inside prose cannot be read as a field.
 *
 * Deliberately line-comments only: this repository's Go has no `/* *\/` blocks in these files, and
 * a half-right block-comment stripper that mangles a string literal would silently drop a REAL
 * field — which is the failure direction that matters, because a dropped field is an unchecked
 * exclusion.
 *
 * @param {string} source
 * @returns {string}
 */
export function stripLineComments(source) {
	return source
		.split("\n")
		.map((line) => {
			const i = line.indexOf("//");
			return i === -1 ? line : line.slice(0, i);
		})
		.join("\n");
}

/**
 * The verdict, given each issue's state. Pure — the part that decides is separated from the part
 * that asks, because only the deciding part can be wrong in a way a test can catch.
 *
 * @param {Map<number, string>} states issue number → "OPEN" | "CLOSED" | "" (unreadable)
 * @returns {{closed: number[], unreadable: number[], open: number[]}}
 */
export function verdict(states) {
	const closed = [];
	const unreadable = [];
	const open = [];
	for (const [n, state] of [...states.entries()].sort(([a], [b]) => a - b)) {
		if (state === "OPEN") open.push(n);
		else if (state === "CLOSED") closed.push(n);
		// Anything else — an empty string, an unexpected verb, a null — is NOT closed and NOT open.
		// Bucketing it with either would be the guard answering a question it did not get an answer
		// to; it is an error, and the caller exits non-zero on it.
		else unreadable.push(n);
	}
	return { closed, unreadable, open };
}

/**
 * Ask GitHub for one issue's state.
 *
 * @param {number} n
 * @returns {string} "OPEN", "CLOSED", or "" when the state could not be read
 */
function readState(n) {
	try {
		const out = execFileSync("gh", ["issue", "view", String(n), "--json", "state", "--jq", ".state"], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		});
		return out.trim();
	} catch {
		return "";
	}
}

// ── --self-test ───────────────────────────────────────────────────────────────────────────────────
//
// The two halves that can be wrong without the network: what the scan FINDS, and what the verdict
// MAKES of it. Both are driven in each direction — a guard whose only exercised branch is the one
// it was designed around has been shown to fire, not to be right.
if (process.argv.includes("--self-test")) {
	let pass = 0;
	let fail = 0;
	/** @param {boolean} cond @param {string} what */
	const t = (cond, what) => {
		if (cond) {
			pass += 1;
			console.log(`  ✓ ${what}`);
		} else {
			fail += 1;
			console.error(`  ✗ ${what}`);
		}
	};

	console.log("check-exclusion-issues --self-test\n\n the scan");
	t(
		JSON.stringify(issueNumbersIn('\t\tIssue:  "#2717",\n\t\tIssue: "#3524",\n')) === "[2717,3524]",
		"finds every Issue field, sorted",
	);
	t(JSON.stringify(issueNumbersIn('\t\tIssue:  "#42",\n\t\tIssue: "#42",\n')) === "[42]", "de-duplicates");
	t(JSON.stringify(issueNumbersIn("no fields here\n")) === "[]", "an empty file yields nothing");
	// The reason it anchors on the FIELD: these files quote dozens of run ids and issue numbers in
	// prose, and a bare `#\d+` scan would hand the guard numbers it has no contract over.
	t(
		JSON.stringify(issueNumbersIn('\t\tWhy: "see #2811 and run 33095437088",\n\t\tIssue: "#7",\n')) === "[7]",
		"a number quoted in another FIELD is not read as a tracking issue",
	);
	t(
		JSON.stringify(issueNumbersIn(stripLineComments('\t\t// Issue: "#999" used to be here\n\t\tIssue: "#7",\n'))) ===
			"[7]",
		"a number in a COMMENT is not read as a tracking issue",
	);
	// The failure direction that matters: a real field must survive comment-stripping.
	t(
		stripLineComments('\t\tIssue: "#7", // was #999\n').includes('Issue: "#7",'),
		"stripping a trailing comment leaves the field intact",
	);

	console.log("\n the verdict");
	const v = verdict(new Map([[1, "OPEN"], [2, "CLOSED"], [3, ""], [4, "SOMETHING_ELSE"]]));
	t(JSON.stringify(v.open) === "[1]", "OPEN is open");
	t(JSON.stringify(v.closed) === "[2]", "CLOSED is closed");
	// THE FAIL-CLOSED CASE, both shapes. An unreadable state must never be bucketed with open —
	// that is the guard reporting green over a question it never got an answer to.
	t(JSON.stringify(v.unreadable) === "[3,4]", "an empty OR unexpected state is unreadable, not open");
	t(!v.open.includes(3) && !v.open.includes(4), "an unreadable state is never counted as open");
	t(!v.closed.includes(3) && !v.closed.includes(4), "…and never as closed either");
	t(JSON.stringify(verdict(new Map()).unreadable) === "[]", "no issues yields no findings");

	console.log("");
	if (fail === 0) {
		console.log(`check-exclusion-issues self-test: all ${pass} passed`);
		process.exit(0);
	}
	console.error(`check-exclusion-issues self-test: ${fail} of ${pass + fail} FAILED`);
	process.exit(1);
}

// ── the check ─────────────────────────────────────────────────────────────────────────────────────

const source = stripLineComments(readFileSync(path.join(ROOT, GUARDED), "utf8"));
const numbers = issueNumbersIn(source);

// An empty scan is an ERROR. `addOnExclusions` may legitimately become empty — that is the whole
// point of the ratchet above it — but a scan that finds nothing is indistinguishable from a regex
// that stopped matching after a gofmt change, and this guard reporting "all clear" over a broken
// scan is exactly what it exists to prevent one level down.
if (numbers.length === 0) {
	console.error(`::error::check-exclusion-issues: found NO Issue fields in ${GUARDED}.`);
	console.error("  Either every exclusion has been removed — in which case delete this check in the");
	console.error("  same PR — or the scan has stopped matching the field. It is an error either way:");
	console.error("  a guard that silently checks nothing is worse than no guard.");
	process.exit(1);
}

const states = new Map(numbers.map((n) => [n, readState(n)]));
const { closed, unreadable, open } = verdict(states);

for (const n of open) console.log(`  ✓ #${n} is OPEN`);

let bad = false;
if (unreadable.length > 0) {
	bad = true;
	console.error(`::error::check-exclusion-issues: could not read the state of ${unreadable.map((n) => `#${n}`).join(", ")}.`);
	console.error("  This is NOT a pass. `gh` needs a token with issue read access; without one the");
	console.error("  check cannot tell an open issue from a closed one, and assuming open is how a");
	console.error("  stale exclusion survives the guard written to catch it.");
}
if (closed.length > 0) {
	bad = true;
	console.error(`::error::check-exclusion-issues: ${GUARDED} cites CLOSED issue(s): ${closed.map((n) => `#${n}`).join(", ")}.`);
	console.error("  The Issue field's contract is that it stays OPEN — an exclusion whose tracker is");
	console.error("  closed has nothing left to make it come off the list, which is how it becomes");
	console.error("  permanent. Either the exclusion is no longer true (delete the entry), or it is");
	console.error("  still true and needs a tracking issue that is still open (file one and point at it).");
}

if (!bad) {
	console.log(`✓ every tracking issue in ${GUARDED} is open (${open.length})`);
	console.log(
		`  NOTE — not covered here: ${REPORTED_ONLY.join(", ")} also carries an Issue field, under a` +
			' different contract ("filed", not "open"), so this check deliberately says nothing about it.',
	);
}
process.exit(bad ? 1 : 0);
