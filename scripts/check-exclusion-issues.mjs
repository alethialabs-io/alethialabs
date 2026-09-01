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
	// `Issue:` then optional whitespace then a quoted "#<digits>".
	//
	// NOT LINE-ANCHORED, and that is a correction rather than a preference. The first version was
	// `^\s*Issue:\s*"#(\d+)"\s*,`, which matched the gofmt-aligned multi-line entries this file
	// happens to contain today and matched NOTHING in a single-line composite literal
	// (`{Kind: NeedsUserConfig, Issue: "#42"}`) — a shape Go accepts and the test file already uses.
	// A future single-line entry would have been silently unchecked, which is the same "guard
	// matches a rendering rather than the thing" failure this guard exists to catch one level down.
	//
	// The boundary is kept — a `{`, a `,` or start-of-line before `Issue:` — so an identifier
	// ending in `Issue` (`TrackingIssue: "#1"`) is not read as this field. The trailing comma is
	// gone with the anchor: a single-line literal's LAST field has none.
	for (const m of source.matchAll(/(?:^|[{,])\s*Issue:\s*"#(\d+)"/gm)) found.add(Number(m[1]));
	return [...found].sort((a, b) => a - b);
}

/**
 * Every line that MENTIONS the field, whether or not the scan above could parse a number from it.
 *
 * This is the emitter-mirror: the pattern above decides what gets checked, and nothing said what
 * happened to an `Issue:` it could not read. A field written in a shape the regex misses would be
 * skipped in exactly the same silence as a file with no exclusions at all — and this guard's whole
 * argument is that those two must not render alike.
 *
 * @param {string} source comment-stripped Go source
 * @returns {string[]} the trimmed lines carrying an `Issue:` field
 */
export function issueFieldLines(source) {
	return source
		.split("\n")
		.filter((line) => /(?:^|[{,])\s*Issue:/.test(line))
		.map((line) => line.trim());
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
	return source.split("\n").map(stripLineComment).join("\n");
}

/**
 * Strip one line's `//` comment, ignoring a `//` that falls INSIDE a string literal.
 *
 * `line.indexOf("//")` was not enough, and the failure direction is the bad one: a `Why` string
 * citing a URL truncates its own line, so `{Why: "https://…", Issue: "#5"}` has its `Issue:` deleted
 * before the scan ever sees it — and the guard reports success over an entry it never read. The
 * `Why` strings in addon_exclusions.go already cite file paths and are one edit from citing a URL.
 *
 * Double quotes and backticks only, which is every string Go has. A rune literal cannot contain
 * `//` in one character, so `'` is deliberately not tracked — treating it as a quote would swallow
 * the rest of a line containing an apostrophe in a comment.
 *
 * @param {string} line
 * @returns {string}
 */
function stripLineComment(line) {
	let quote = "";
	for (let i = 0; i < line.length; i += 1) {
		const ch = line[i];
		if (quote) {
			// Backslash escapes apply inside "..." but NOT inside a raw `...` literal.
			if (quote === '"' && ch === "\\") i += 1;
			else if (ch === quote) quote = "";
			continue;
		}
		if (ch === '"' || ch === "`") {
			quote = ch;
			continue;
		}
		if (ch === "/" && line[i + 1] === "/") return line.slice(0, i);
	}
	return line;
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
		return { state: out.trim(), error: "" };
	} catch (err) {
		// KEPT, not discarded. A bare `catch` threw away gh's own diagnostic and the caller then
		// asserted one cause — "needs a token" — that it had not measured. `gh` is missing, the
		// token lacks `issues: read`, the issue was deleted, the API is rate-limited and the network
		// is down all land here, and they send an operator to five different places.
		const e = /** @type {{stderr?: Buffer|string, message?: string}} */ (err);
		const stderr = typeof e.stderr === "string" ? e.stderr : e.stderr?.toString("utf8");
		const reason = (stderr || e.message || String(err)).trim().split("\n")[0];
		return { state: "", error: reason || "gh failed with no diagnostic" };
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
	// THE HOLE THE FIRST VERSION HAD. `^\s*Issue:` matched nothing here, so a single-line entry —
	// a shape Go accepts, and one the test file already uses — was silently unchecked.
	t(
		JSON.stringify(issueNumbersIn('ex := map[string]AddOnExclusion{app: {Kind: K, Issue: "#42"}}\n')) === "[42]",
		"a SINGLE-LINE composite literal is read (the anchor bug)",
	);
	t(
		JSON.stringify(issueNumbersIn('\t\t{Kind: K, Issue: "#42", Clouds: nil},\n')) === "[42]",
		"…including one whose Issue is not the last field",
	);
	// …without the anchor swallowing a DIFFERENT field that happens to end in "Issue".
	t(
		JSON.stringify(issueNumbersIn('\t\tTrackingIssue: "#99",\n\t\tIssue: "#7",\n')) === "[7]",
		"a longer field name ending in Issue is not read as this field",
	);

	console.log("\n the emitter mirror");
	t(issueFieldLines('\t\tIssue: "#7",\n\t\tWhy: "x",\n').length === 1, "counts a readable field line");
	t(issueFieldLines('\t\tIssue: someConst,\n').length === 1, "counts an UNREADABLE field line too — that is the point");
	t(issueNumbersIn('\t\tIssue: someConst,\n').length === 0, "…which the number scan does not read, so the counts disagree");
	t(issueFieldLines('\t\tTrackingIssue: "#99",\n').length === 0, "does not count a different field");
	// The failure direction that matters: a real field must survive comment-stripping.
	t(
		stripLineComments('\t\tIssue: "#7", // was #999\n').includes('Issue: "#7",'),
		"stripping a trailing comment leaves the field intact",
	);
	// A `//` INSIDE a string must not truncate the line. The Why strings in this file already cite
	// paths and are one edit from citing a URL, and combined with the single-line literal form that
	// deletes a real `Issue:` before the scan ever sees it.
	t(
		stripLineComments('\t\tWhy: "see https://x/y",') === '\t\tWhy: "see https://x/y",',
		"a // inside a double-quoted string is not a comment",
	);
	t(
		JSON.stringify(issueNumbersIn(stripLineComments('{Why: "https://x", Issue: "#5"}\n'))) === "[5]",
		"…so a URL on the same line does not hide the field behind it",
	);
	t(
		stripLineComments("\t\tWhy: `raw//not a comment`,") === "\t\tWhy: `raw//not a comment`,",
		"a // inside a RAW (backtick) string is not a comment either",
	);
	t(
		stripLineComments('\t\tWhy: "he said \\"//\\" once", // real') === '\t\tWhy: "he said \\"//\\" once", ',
		"an escaped quote does not end the string early",
	);
	t(
		stripLineComments("\t\t// it's fine") === "\t\t",
		"an apostrophe in a comment does not open a string (rune literals are not tracked)",
	);

	console.log("\n the verdict");
	// verdict() takes states; readState() now returns {state, error} so gh's own words survive. The
	// bare `catch` that discarded them let the caller assert a cause it had not measured.
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

// TWO MODES, because the two halves have different failure characteristics and belong in different
// CI steps.
//
//   --scan-only   reads the file and validates the SCAN. Pure — no network, no token — so it is the
//                 BLOCKING step. It was previously reachable only from the network step, which is
//                 `continue-on-error`, so the "found NO Issue fields" tripwire — the one whose own
//                 message says "a guard that silently checks nothing is worse than no guard" —
//                 could never red the build. A regex that stopped matching produced an annotation
//                 on a green job and nothing else.
//   (default)     the same scan, then the GitHub call. Advisory in CI: an issue closing is a state
//                 change in GitHub, not in the diff.
const scanOnly = process.argv.includes("--scan-only");

let raw;
try {
	raw = readFileSync(path.join(ROOT, GUARDED), "utf8");
} catch (err) {
	// NAMED, not a raw Node stack. If the file is renamed or moved, "ENOENT ... at Object.readFileSync"
	// tells a reader nothing about what this guard wanted, and the guard's own contract — that it
	// must not silently check nothing — is exactly what a crash here would obscure.
	console.error(`::error::check-exclusion-issues: cannot read ${GUARDED} (${err instanceof Error ? err.message : String(err)}).`);
	console.error("  If that file was renamed or moved, update GUARDED in this script in the same PR.");
	console.error("  This is an error rather than a skip: a guard that cannot find its subject has");
	console.error("  checked nothing, and must not report success.");
	process.exit(1);
}

const source = stripLineComments(raw);
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

// EVERY mention accounted for. A line that names the field but yields no number is a field the
// scan could not read, and skipping it silently is the one failure mode this guard cannot afford:
// its own "all clear" would then be a statement about the regex, not about the file.
const mentions = issueFieldLines(source);
if (mentions.length !== numbers.length) {
	console.error(
		`::error::check-exclusion-issues: ${GUARDED} has ${mentions.length} line(s) naming an Issue field but ` +
			`${numbers.length} readable issue number(s) — at least one is in a shape this scan cannot read.`,
	);
	console.error('  The expected shape is `Issue: "#<digits>"`. Lines seen:');
	for (const line of mentions) console.error(`    ${line}`);
	console.error("  This is an error rather than a skip: an unreadable field is unchecked, and an");
	console.error("  unchecked field is indistinguishable from a checked one in the output below.");
	process.exit(1);
}

if (scanOnly) {
	console.log(`✓ scan: ${numbers.length} tracking issue(s) read from ${GUARDED} (${numbers.map((n) => `#${n}`).join(", ")})`);
	console.log("  Their STATE is not checked here — that needs the GitHub API. See the step after this one.");
	process.exit(0);
}

const states = new Map(numbers.map((n) => [n, readState(n)]));
const reasons = new Map([...states.entries()].map(([n, r]) => [n, r.error]));
const { closed, unreadable, open } = verdict(new Map([...states.entries()].map(([n, r]) => [n, r.state])));

for (const n of open) console.log(`  ✓ #${n} is OPEN`);

let bad = false;
if (unreadable.length > 0) {
	bad = true;
	console.error(`::error::check-exclusion-issues: could not read the state of ${unreadable.map((n) => `#${n}`).join(", ")}.`);
	// gh's OWN words, per issue. The previous message asserted one cause ("needs a token") that it
	// had not measured; a missing `gh`, a token without `issues: read`, a deleted issue, a rate
	// limit and a dead network all land here and send an operator to five different places.
	for (const n of unreadable) {
		console.error(`    #${n}: ${reasons.get(n) || "(gh reported no diagnostic)"}`);
	}
	console.error("  This is NOT a pass. Without an answer the check cannot tell an open issue from a");
	console.error("  closed one, and assuming open is how a stale exclusion survives the guard written");
	console.error("  to catch it. If the diagnostics above mention permissions, the job needs `issues: read`.");
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
