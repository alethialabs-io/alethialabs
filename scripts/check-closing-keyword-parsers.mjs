#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
//
// TWO parsers decide what a PR's closing keywords mean, and they must agree.
//
//   .github/workflows/close-on-dev-merge.yml   closes the issue      (destructive direction)
//   scripts/lib/board-pr.sh  $BOARD_PR_CLOSING_KW                    (claimability direction)
//
// WHY THIS EXISTS, measured. Both carried the same defect: a bare keyword match, so prose ABOUT a
// closing keyword read as one. FOUR issues were closed by it in a single day, in THREE shapes —
// and every one of them was a sentence explaining that the PR did NOT close the thing:
//
//   NEGATION
//   · 2026-09-22 16:54Z — #4919's "This does not close #3855." CLOSED #3855.
//     The thread promised "A PR follows that makes a negated closing keyword stop closing an
//     issue." No PR was opened.
//   · 2026-09-22 21:41Z — #4924's "It does not close #3855" CLOSED #3855 again, five hours later.
//
//   RELATIVE CLAUSE — grammatically a closing reference; only the meaning says otherwise
//   · #4940's "That is what closes #3348, which is why this says `Refs` and not `Closes`"
//     CLOSED #3348 — the sentence stating it deliberately used `Refs`.
//
//   QUOTED KEYWORD — the keyword NAMED, not used
//   · #4935's "Changed from `Closes #4110` to `Refs #4110` — deliberately" CLOSED #4110 — the note
//     recording that the reference had been changed away from `Closes` so it would STAY OPEN.
//
// The first two families are lookbehinds. The third is not decidable that way and is handled by
// stripping code spans before matching, which IS mechanically sound. The second parser is
// the one nobody saw: in `board-pr.sh` the same text makes `has_closing_pr` answer true, so
// `claim-work.sh` refuses to hand the unit out — silently, with no issue visibly shutting and
// nothing to notice. A fix applied to one renderer and not the other is how this survives.
//
// So this guard checks BOTH, and checks that they are the SAME pattern. Fixing one and not the
// other is the failure mode it exists to make impossible.
//
// WHAT IT DOES NOT CHECK, stated so this is not read as more than it is:
//   · It does not parse the workflow's shell. It asserts the pattern STRING appears in it.
//     A rewrite that stops using that pattern would pass this and still be wrong.
//   · The lookbehinds are fixed-width by construction. "does not, in fact, close #n" is NOT
//     rejected — only an immediately-preceding negator is. That bound is deliberate: a wider
//     window starts rejecting real closing refs, and the safe direction here is to over-close
//     nothing rather than to under-close everything.
//   · `without closing #n` is not covered (gerund, not a listed tense).
//
// Usage:  node scripts/check-closing-keyword-parsers.mjs [--self-test]

import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WORKFLOW = ".github/workflows/close-on-dev-merge.yml";
const LIB = "scripts/lib/board-pr.sh";

/** The three lookbehinds both sites must carry, in order. */
const GUARD = "(?<!not )(?<!n.t )(?<!never )(?<!what )(?<!that )(?<!which )";
/** A keyword inside backticks is NAMED, not used. Not decidable by lookbehind — stripped first. */
const STRIP = 'gsub("(?s)```.*?```"; " ")';
const KEYWORDS = "(close|closes|closed|fix|fixes|fixed|resolve|resolves|resolved)";

/**
 * The shared corpus. `expect` is every issue number a correct parser returns, in order.
 * Each row exists because it is a shape that actually occurs in this repo's PR bodies.
 */
const CORPUS = [
	{ text: "Closes #4112", expect: [4112], why: "the ordinary case" },
	{ text: "closes #1, fixes #2", expect: [1, 2], why: "several refs, several tenses" },
	{ text: "Note: closes #7", expect: [7], why: "a word CONTAINING 'not' must not reject" },
	{ text: "Fixes #99 and does not close #100", expect: [99], why: "one real, one negated, same line" },
	{ text: "It does not close #3855", expect: [], why: "#4924 — closed #3855 at 21:41Z" },
	{ text: "**This does not close #3855.**", expect: [], why: "#4919 — closed #3855 at 16:54Z" },
	{ text: "doesn't close #10", expect: [], why: "contraction" },
	{ text: "never closes #10", expect: [], why: "never" },
	{ text: "cannot close #55", expect: [], why: "cannot — ends in 'not '" },
	{ text: "This PR does not fix #42 either", expect: [], why: "a negated non-close tense" },
	{ text: "That is what closes #3348, which is why this says Refs", expect: [], why: "#4940 — closed #3348: a relative clause, in the sentence saying it used Refs" },
	{ text: "Changed from `Closes #4110` to `Refs #4110` — deliberately", expect: [], why: "#4935 — closed #4110: the keyword QUOTED in the note saying it had been changed away from Closes" },
	{ text: "the commit that fixes #9", expect: [], why: "relative clause, other tense" },
	{ text: "```\nCloses #999\n```\nand Closes #5", expect: [5], why: "a fenced block is not an assertion; the real one beside it still counts" },
	{ text: "", expect: [], why: "empty body must not throw" },
];

/** Run the canonical pattern through jq — the same engine both call sites use. */
function refsOf(text) {
	const program =
		'$t | gsub("(?s)```.*?```"; " ") | gsub("`[^`\\n]*`"; " ") ' +
		`| [ match("(?i)${GUARD}${KEYWORDS} +#([0-9]+)"; "g") | .captures[1].string ] ` +
		`| map(tonumber) | unique`;
	const out = execFileSync("jq", ["-rn", "--arg", "t", text, program], { encoding: "utf8" });
	return JSON.parse(out.trim() || "[]");
}

function checkCorpus() {
	const failures = [];
	for (const row of CORPUS) {
		let got;
		try {
			got = refsOf(row.text);
		} catch (error) {
			failures.push(`  threw on ${JSON.stringify(row.text)}: ${error.message}`);
			continue;
		}
		if (JSON.stringify(got) !== JSON.stringify(row.expect)) {
			failures.push(
				`  ${JSON.stringify(row.text)}\n    expected [${row.expect}] got [${got}]  (${row.why})`,
			);
		}
	}
	return failures;
}

function checkBothSitesCarryTheGuard() {
	const failures = [];
	for (const path of [WORKFLOW, LIB]) {
		let text;
		try {
			text = readFileSync(resolve(ROOT, path), "utf8");
		} catch {
			failures.push(`  ${path}: cannot read — the guard cannot vouch for a file it never saw`);
			continue;
		}
		if (!text.includes(GUARD)) {
			failures.push(
				`  ${path}: does not carry the negation guard ${GUARD}\n` +
					"    A negated keyword would be treated as a closing reference here.",
			);
		}
		if (!text.includes(KEYWORDS)) {
			failures.push(`  ${path}: does not carry the shared keyword alternation — the two have drifted`);
		}
		if (!text.includes(STRIP)) {
			failures.push(
				`  ${path}: does not strip fenced/inline code before matching.\n` +
					"    A keyword QUOTED in backticks would be treated as asserted — which is how #4110\n" +
					"    was closed by the very note recording that its reference had been changed to `Refs`.",
			);
		}
	}
	failures.push(...checkVocabularyStaysAPlainAlternation());
	return failures;
}

/**
 * `BOARD_PR_CLOSING_KW` is a VOCABULARY and must stay a plain alternation. FOUR consumers read it
 * and they do not agree on what it is:
 *
 *   · board-pr.sh + close-on-dev-merge.yml  use it as a REGEX FRAGMENT
 *   · coordinate.sh closing_keywords_json() strips `^(` / `)$` and splits on `|`  → a keyword LIST
 *   · scripts/ci/check-pr-scope.mjs:102     matches /^BOARD_PR_CLOSING_KW='\(([^)]+)\)/
 *
 * The list-readers assume the value opens with `(` and closes at the FIRST `)`. Baking the negation
 * lookbehinds into it therefore made the first capture `?<!not `, which
 * `scope-overlap.mjs:579 closingRefsIn` compiled into `/\b(?:?<!not)\s+#(\d+)\b/gi` —
 * "SyntaxError: Nothing to repeat" — taking the whole `Authz / open-core guards` job down.
 *
 * That is why the guard lives in its own `BOARD_PR_NEGATION_GUARD` and is COMPOSED at each matcher.
 * This check exists so the next person who reaches for the obvious shortcut is stopped by a test
 * rather than by a red required job.
 */
function checkVocabularyStaysAPlainAlternation() {
	const failures = [];
	let text;
	try {
		text = readFileSync(resolve(ROOT, LIB), "utf8");
	} catch {
		return [`  ${LIB}: cannot read`];
	}

	const assignment = /^BOARD_PR_CLOSING_KW='([^']*)'/m.exec(text);
	if (assignment === null) {
		return [
			`  ${LIB}: could not find the BOARD_PR_CLOSING_KW assignment. Four consumers parse that ` +
				"line; if it moved, move them with it rather than letting this check go quiet.",
		];
	}
	const value = assignment[1];

	// The shape the list-readers require: `(a|b|c) +` and nothing before the opening paren.
	if (!/^\([a-z|]+\) \+$/.test(value)) {
		failures.push(
			`  ${LIB}: BOARD_PR_CLOSING_KW is ${JSON.stringify(value)}, which is not a plain\n` +
				"    alternation of the form '(a|b|c) +'.\n" +
				"    coordinate.sh and check-pr-scope.mjs parse this value as a keyword LIST by stripping\n" +
				"    the outer parens — anything else silently becomes a broken regex downstream in\n" +
				"    scope-overlap.mjs. Put matcher-only syntax in BOARD_PR_NEGATION_GUARD and compose it.",
		);
	}

	// And the guard must exist as its own variable, or there is nothing to compose.
	if (!/^BOARD_PR_NEGATION_GUARD='/m.test(text)) {
		failures.push(
			`  ${LIB}: BOARD_PR_NEGATION_GUARD is not defined. The negation guard must be a separate\n` +
				"    variable composed onto the vocabulary, never baked into it.",
		);
	}
	return failures;
}

/** Prove the corpus can FAIL: run it against the unguarded pattern and require the two regressions. */
function selfTest() {
	const failures = [];

	const unguarded = (text) => {
		const program =
			`[ $t | match("(?i)${KEYWORDS} +#([0-9]+)"; "g") | .captures[1].string ] | map(tonumber) | unique`;
		return JSON.parse(execFileSync("jq", ["-rn", "--arg", "t", text, program], { encoding: "utf8" }).trim() || "[]");
	};

	// 1 · the guarded pattern passes the whole corpus
	const live = checkCorpus();
	if (live.length > 0) {
		failures.push(`the guarded pattern fails its own corpus:\n${live.join("\n")}`);
	}

	// 2 · the UNGUARDED pattern must reproduce the two real incidents — otherwise the corpus is
	//     not exercising the defect and would pass over a reintroduction.
	for (const row of CORPUS.filter((r) => r.expect.length === 0 && r.text.includes("#"))) {
		const got = unguarded(row.text);
		if (got.length === 0) {
			failures.push(
				`the corpus row ${JSON.stringify(row.text)} does not distinguish guarded from unguarded — ` +
					"it would pass even with the defect reintroduced",
			);
		}
	}

	// 3 · both files carry the guard
	failures.push(...checkBothSitesCarryTheGuard());

	if (failures.length > 0) {
		console.error("✗ check-closing-keyword-parsers self-test:");
		for (const f of failures) console.error(`  ${f}`);
		process.exit(1);
	}
	console.log(
		`✓ check-closing-keyword-parsers self-test: ${CORPUS.length} corpus row(s); ` +
			"every negated row is caught by the guard AND would be missed without it; both call sites carry it.",
	);
}

function main() {
	if (process.argv.includes("--self-test")) return selfTest();

	const failures = [...checkBothSitesCarryTheGuard(), ...checkCorpus()];
	if (failures.length > 0) {
		console.error("✗ check-closing-keyword-parsers: a negated closing keyword would close an issue.\n");
		for (const f of failures) console.error(f);
		console.error(
			"\nBoth parsers must carry the same negation guard. See #3855, closed twice in one day by\n" +
				"PR bodies that said they did NOT close it.",
		);
		process.exit(1);
	}
	console.log(
		`✓ check-closing-keyword-parsers: both call sites carry the negation guard, ${CORPUS.length} corpus row(s) agree.`,
	);
}

main();
