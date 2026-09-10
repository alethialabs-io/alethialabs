#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
//
// A WRONG `scope:` LINE IS COUNTED AS DISJOINT, AND NOTHING ASKED (#4442).
//
// `scripts/coordinate.sh` compares the `scope:` globs of claimed-or-ready units and prints one of
// four verdicts — overlap · clean · clean-with-gaps · not-checked. It has no fifth, and the missing
// one is the dangerous one: **compared against a scope that does not describe the unit's work.**
//
// An ABSENT scope is named under NOT CHECKED — loud, and correct. A WRONG scope is silently counted
// as disjoint, and the anti-tangle invariant then reports green over a real collision. A wrong scope
// line is worse than a missing one, because it buys a verdict.
//
// It happened on 2026-09-09: #4309 declared the seven files its INSTRUMENT pr touched, while its
// remaining work was "the other 50 alpha-over-ink sites" spread across the console. Its
// implementation PR changed 35 files, 30 outside that scope, including five under
// `components/alerts/**` owned by #4270 and three under `components/connectors/**` owned by #4268 —
// both with PRs in flight. `coordinate.sh --report` said, correctly and uselessly, "compared, no
// overlap: 26 of 26". It compared what was declared. What was declared was written for a different
// PR.
//
// ── WHAT THIS ASKS, AND WHERE IT CAN ASK IT ──────────────────────────────────────────────────────
//
// Only a PR knows which files a unit actually touched, so the question can only be asked at PR time:
// resolve the issue from `Closes #<n>`, and hold every changed file against THAT issue's globs.
//
// ── TWO SEVERITIES, AND THE LINE BETWEEN THEM IS THE POINT ───────────────────────────────────────
//
// A file outside the declared scope is not automatically a defect worth blocking a PR for. What makes
// it one is that ANOTHER OPEN UNIT'S SCOPE CLAIMS IT — that is a tangle in progress, the thing the
// invariant exists to prevent, and the case where two instances are about to edit one file believing
// the board said they would not. So:
//
//   ERROR    a changed file outside the closing issue's scope AND inside another open unit's scope.
//            Named with both unit numbers, because the remedy depends on which of them is wrong.
//   WARNING  a changed file outside the scope that no other unit claims. The scope line is still
//            wrong and should be widened, but nothing is tangled, and blocking here would red every
//            PR that touches an incidental generated file.
//
// ── WHY A MISSING SCOPE IS A WARNING HERE AND NOT AN ERROR ───────────────────────────────────────
//
// Because it is already loud somewhere better: `coordinate.sh` names it under NOT CHECKED on every
// run. Failing here as well would block a PR closing any unscoped issue — including the `epic` and
// `needs:human` units that legitimately carry no scope — to report something already reported.
//
// The obvious objection is that this makes DELETING a scope line the cheapest way past this check.
// It does, and the escape is visible: a unit with no scope moves from "compared" to "NOT CHECKED" in
// the board report, and the report prints "compared N of M" precisely so that M − N cannot grow
// unnoticed. An escape that shows up in the other instrument is a different thing from a silent one.
//
// ── ONE VOCABULARY, READ NOT COPIED ──────────────────────────────────────────────────────────────
//
// The closing keywords are NOT retyped here. `scripts/lib/board-pr.sh` owns them in
// `BOARD_PR_CLOSING_KW`, and that file exists because there were two copies and one was wrong —
// `(close|fix|resolve)(s|d)?` expands to `fixs`/`fixd`, so "Fixes #n" matched nothing for as long as
// nobody looked. This script PARSES that assignment out of that file, so a fourth copy cannot drift
// from it: change the vocabulary there and this follows, and if the line cannot be found this refuses
// rather than falling back to a guess.
//
// The glob predicate is likewise `scripts/lib/scope-overlap.mjs`'s `globsOverlap`, the one matcher
// `coordinate.sh` and `decompose-validate.mjs` already share. A concrete path is a wildcard-free
// glob, so containment is the same call — no second semantics.
//
// ── WHAT IT DELIBERATELY DOES NOT DO ─────────────────────────────────────────────────────────────
//
// It does not fix the fenced-`scope:` gap, now #4473. `scope-overlap.mjs:39-47` records half of it —
// a ```-fenced `scope:` line at column 0 is read as a declaration — and the other half is that the
// regex is `m` but not `g`, so it takes only the FIRST match. Together they mean a body quoting
// another unit's scope line ABOVE its own has its own declaration ignored, which is precisely what
// #4442's body did until it was de-fanged by hand.
//
// This script reads scopes through that same function ON PURPOSE, and so inherits the gap until #4473
// closes: a stricter reader here would make the PR-time verdict and the board-time verdict disagree,
// which is the drift both files exist to end. The fix belongs where the parser is, and #4473 says why
// it has to move `decompose-validate.mjs`'s copy with it.
//
// Usage:
//   node scripts/ci/check-pr-scope.mjs --self-test    # hermetic: fixtures + mutation controls
//   node scripts/ci/check-pr-scope.mjs                # live: reads PR_NUMBER / PR_TITLE / PR_BODY

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { globsOverlap, isWorkableBoardUnit, readScope } from "../lib/scope-overlap.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const BOARD_PR = "scripts/lib/board-pr.sh";

/**
 * The closing keywords, READ from `board-pr.sh` rather than retyped.
 *
 * @param {string} text contents of scripts/lib/board-pr.sh
 * @returns {string[]} the keyword alternatives, lower-case
 * @throws when the assignment is absent or yields nothing — a vocabulary this cannot read is not an
 *   empty vocabulary, and treating it as one would match no PR and pass every one of them.
 */
export function closingKeywords(text) {
	const m = /^BOARD_PR_CLOSING_KW='\(([^)]+)\)/m.exec(text);
	if (!m) {
		throw new Error(
			`could not find BOARD_PR_CLOSING_KW in ${BOARD_PR}. That file owns the closing-keyword ` +
				`vocabulary and this check reads it rather than keeping a copy; if the assignment moved, ` +
				`move this reader with it. Refusing rather than guessing, because a guess here matches no ` +
				`PR and then passes every one of them.`,
		);
	}
	const kws = m[1]
		.split("|")
		.map((s) => s.trim().toLowerCase())
		.filter(Boolean);
	if (kws.length === 0) {
		throw new Error(`BOARD_PR_CLOSING_KW in ${BOARD_PR} parsed to zero keywords`);
	}
	return kws;
}

/**
 * Issue numbers this text closes. Title and body together, matching `close-on-dev-merge.yml`, which
 * is what actually closes them — a check that read only the body would pass a PR that this repo's
 * own automation treats as closing.
 *
 * `\b` after the number so `#84` does not match `#842`, the same boundary `board_pr_links` states.
 *
 * @param {string} text
 * @param {string[]} keywords
 * @returns {number[]} ascending, de-duplicated
 */
export function closingRefs(text, keywords) {
	const re = new RegExp(`\\b(?:${keywords.join("|")})\\s+#(\\d+)\\b`, "gi");
	const out = new Set();
	for (const m of text.matchAll(re)) out.add(Number(m[1]));
	return [...out].sort((a, b) => a - b);
}

/**
 * THE WHOLE DECISION, and it is pure so the self-test needs no network and no repository.
 *
 * @param {object} input
 * @param {string[]} input.changedFiles paths, repo-relative
 * @param {number[]} input.refs issues this PR closes
 * @param {Map<number, {globs: string[], status: string, title?: string}>} input.scopes per closing issue
 * @param {{number: number, title?: string, labels?: {name: string}[], body?: string}[]} input.board open units
 * @returns {{verdict: string, errors: string[], warnings: string[], notes: string[], compared: number}}
 */
export function analyse({ changedFiles, refs, scopes, board }) {
	const errors = [];
	const warnings = [];
	const notes = [];

	if (refs.length === 0) {
		return {
			verdict: "NOT-APPLICABLE",
			errors,
			warnings,
			notes: [
				"this PR closes no issue, so there is no declared scope to hold it against. Not a pass " +
					"and not a failure — a PR may legitimately close nothing (a promotion, a follow-up " +
					"commit, a chore).",
			],
			compared: 0,
		};
	}

	// BLINDNESS. A PR that closes an issue and changed nothing is not a clean PR; it is a question
	// this check could not answer, and the answer it would otherwise print is "every file is in
	// scope", which is true of the empty set and means nothing.
	if (changedFiles.length === 0) {
		return {
			verdict: "BLIND",
			errors: [
				`PR closes ${refs.map((n) => `#${n}`).join(", ")} and reports ZERO changed files. ` +
					`"every changed file is in scope" is vacuously true of an empty list, so this is a ` +
					`failed measurement rather than a clean one — the diff could not be read.`,
			],
			warnings,
			notes,
			compared: 0,
		};
	}

	// The union of the closing issues' globs: a PR closing two units is in scope for either's files.
	/** @type {string[]} */
	const declared = [];
	const unscoped = [];
	for (const n of refs) {
		const s = scopes.get(n);
		if (!s) {
			errors.push(
				`#${n} is named as closed by this PR and its body could not be read, so the scope it ` +
					`declares is unknown. Refusing to report agreement with a scope nobody fetched.`,
			);
			continue;
		}
		if (s.status !== "declared" || s.globs.length === 0) {
			unscoped.push(n);
			continue;
		}
		declared.push(...s.globs);
	}
	if (errors.length > 0) {
		return { verdict: "BLIND", errors, warnings, notes, compared: 0 };
	}
	for (const n of unscoped) {
		warnings.push(
			`#${n} declares no readable \`scope:\` line, so this PR's files cannot be held against it. ` +
				`coordinate.sh names the same unit under NOT CHECKED on every run; this is that, seen from ` +
				`the PR side.`,
		);
	}
	if (declared.length === 0) {
		return {
			verdict: "NOT-APPLICABLE",
			errors,
			warnings,
			notes: [
				`none of ${refs.map((n) => `#${n}`).join(", ")} declares a scope, so there is nothing to ` +
					`compare. Reported, not passed.`,
			],
			compared: 0,
		};
	}

	// Who else claims a file: only units `claim-work.sh` could actually hand out, which is the same
	// population coordinate.sh compares. `claimed` counts — a unit someone holds is exactly the one a
	// second edit would tangle with.
	const others = board.filter((u) => !refs.includes(u.number) && isWorkableBoardUnit(u));
	/** @type {Map<string, number[]>} */
	const ownersOf = new Map();
	for (const u of others) {
		const s = readScope(u.body ?? "");
		if (s.status !== "declared") continue;
		for (const f of changedFiles) {
			if (s.globs.some((g) => globsOverlap(f, g))) {
				ownersOf.set(f, [...(ownersOf.get(f) ?? []), u.number]);
			}
		}
	}

	let inScope = 0;
	for (const f of changedFiles) {
		if (declared.some((g) => globsOverlap(f, g))) {
			inScope += 1;
			continue;
		}
		const owners = ownersOf.get(f);
		if (owners && owners.length > 0) {
			errors.push(
				`${f} is outside the scope of ${refs.map((n) => `#${n}`).join("/")} and inside the scope ` +
					`of ${owners.map((n) => `#${n}`).join(", ")}. That is a tangle in progress: the board ` +
					`says another unit owns this file. Either widen this unit's \`scope:\` because the work ` +
					`genuinely grew — say so on the issue — or the file belongs to that unit and this PR ` +
					`should not carry it.`,
			);
		} else {
			warnings.push(
				`${f} is outside the scope of ${refs.map((n) => `#${n}`).join("/")} and no other open ` +
					`unit claims it. Nothing is tangled, so this does not fail — but the \`scope:\` line no ` +
					`longer describes the work and should be widened on the issue.`,
			);
		}
	}

	notes.push(
		`${changedFiles.length} changed file(s), ${inScope} inside the declared scope, ` +
			`${declared.length} glob(s) from ${refs.length} closing issue(s), ` +
			`${others.length} other open unit(s) consulted for ownership.`,
	);
	return {
		verdict: errors.length > 0 ? "COLLISIONS" : "CLEAN",
		errors,
		warnings,
		notes,
		compared: changedFiles.length,
	};
}

// ── live inputs ──────────────────────────────────────────────────────────────────────────────────

/** Shell out to `gh`, returning stdout. */
function gh(args) {
	return execFileSync("gh", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

/** The files this PR changes, from the API rather than a local diff — the guards job is a shallow
 *  checkout, so `git diff base...head` has no base to reach. */
function liveChangedFiles(pr) {
	const out = gh(["pr", "diff", String(pr), "--name-only"]);
	return out
		.split("\n")
		.map((s) => s.trim())
		.filter(Boolean);
}

function main() {
	const argv = process.argv.slice(2);
	if (argv.includes("--self-test")) process.exit(selfTest() ? 0 : 1);
	if (argv.length > 0) {
		console.error(`::error::check-pr-scope: unknown argument(s): ${argv.join(" ")}`);
		process.exit(2);
	}

	const pr = (process.env.PR_NUMBER ?? "").trim();
	const title = process.env.PR_TITLE ?? "";
	const body = process.env.PR_BODY ?? "";

	// NOT a PR build. Skipped loudly: silence here is indistinguishable from a pass.
	if (!pr) {
		console.log(
			"check-pr-scope: no PR_NUMBER in the environment — this runs on `pull_request` only. " +
				"Nothing measured, nothing claimed.",
		);
		process.exit(0);
	}

	let keywords;
	try {
		keywords = closingKeywords(readFileSync(resolve(ROOT, BOARD_PR), "utf8"));
	} catch (err) {
		console.error(`::error::check-pr-scope: ${err instanceof Error ? err.message : String(err)}`);
		process.exit(1);
	}

	const refs = closingRefs(`${title}\n${body}`, keywords);
	let changedFiles = [];
	const scopes = new Map();
	let board = [];
	if (refs.length > 0) {
		try {
			changedFiles = liveChangedFiles(pr);
			for (const n of refs) {
				const raw = JSON.parse(gh(["issue", "view", String(n), "--json", "body,title"]));
				scopes.set(n, { ...readScope(raw.body ?? ""), title: raw.title });
			}
			board = JSON.parse(
				gh([
					"issue",
					"list",
					"--state",
					"open",
					"--limit",
					"300",
					"--json",
					"number,title,labels,body",
				]),
			);
		} catch (err) {
			console.error(
				`::error::check-pr-scope: could not read the PR diff, an issue body or the board ` +
					`(${err instanceof Error ? err.message : String(err)}). That is no measurement, not a ` +
					`clean one.`,
			);
			process.exit(1);
		}
	}

	const a = analyse({ changedFiles, refs, scopes, board });
	for (const w of a.warnings) console.log(`::warning::check-pr-scope: ${w}`);
	for (const n of a.notes) console.log(`check-pr-scope: ${n}`);
	if (a.errors.length > 0) {
		for (const e of a.errors) console.error(`::error::check-pr-scope: ${e}`);
		console.error(
			`::error::check-pr-scope: ${a.errors.length} finding(s). A \`scope:\` line that does not ` +
				`describe the work buys a "no overlap" verdict it has not earned — which is how #4309's PR ` +
				`came to edit five files #4270 owned while the board reported clean.`,
		);
		process.exit(1);
	}
	console.log(
		`check-pr-scope: ${a.verdict} — PR #${pr} closes ${refs.length} issue(s), ` +
			`${a.compared} changed file(s) compared, ${a.warnings.length} warning(s).`,
	);
}

// ── self-test ────────────────────────────────────────────────────────────────────────────────────

function selfTest() {
	let fails = 0;
	/** @param {string} name @param {boolean} cond @param {string} [detail] */
	const ok = (name, cond, detail) => {
		if (cond) {
			console.log(`ok   ${name}`);
			return;
		}
		fails += 1;
		console.error(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
	};

	const unit = (number, globs, extra = {}) => ({
		number,
		title: `unit ${number}`,
		labels: [{ name: "class:backend" }, ...(extra.labels ?? [])],
		body: globs === null ? "no scope here" : `scope: ${globs.join(" ")}`,
	});
	const scopeOf = (globs) => new Map([[1, { ...readScope(`scope: ${globs.join(" ")}`) }]]);

	// ── the vocabulary is READ, and a file it cannot read is a refusal ──
	ok(
		"the closing keywords are parsed out of board-pr.sh",
		(() => {
			const kws = closingKeywords(
				"BOARD_PR_CLOSING_KW='(close|closes|closed|fix|fixes|fixed|resolve|resolves|resolved) +'\n",
			);
			return kws.length === 9 && kws.includes("fixes") && kws.includes("resolved");
		})(),
	);
	ok(
		"...and `fixes` is among them, which the shorthand this replaced never matched",
		closingKeywords("BOARD_PR_CLOSING_KW='(close|closes|fixes) +'\n").includes("fixes"),
	);
	ok(
		"a board-pr.sh without the assignment REFUSES rather than reporting no keywords",
		(() => {
			try {
				closingKeywords("# nothing here\n");
				return false;
			} catch {
				return true;
			}
		})(),
	);

	// ── closing refs: the vocabulary discriminates ──
	const KW = ["close", "closes", "closed", "fix", "fixes", "fixed", "resolve", "resolves", "resolved"];
	ok("`Closes #12` closes 12", closingRefs("Closes #12", KW).join() === "12");
	ok("`Fixes #12` closes 12", closingRefs("Fixes #12", KW).join() === "12");
	ok("case is ignored", closingRefs("CLOSED #12", KW).join() === "12");
	ok("`Part of #12` closes nothing", closingRefs("Part of #12", KW).length === 0);
	ok(
		"a bare title ref `(#12)` closes nothing — the squash convention is a mention",
		closingRefs("feat: a thing (#12)", KW).length === 0,
	);
	ok("#84 is not #842", closingRefs("Closes #842", KW).join() === "842");
	ok("two refs are both found, ascending", closingRefs("Closes #9 and fixes #4", KW).join() === "4,9");

	// ── the decision ──
	ok(
		"a file inside the declared scope is clean",
		analyse({
			changedFiles: ["apps/cli/cmd/token.go"],
			refs: [1],
			scopes: scopeOf(["apps/cli/cmd/**"]),
			board: [],
		}).verdict === "CLEAN",
	);

	// THE DEFECT. Outside this unit's scope, inside another unit's — a tangle in progress.
	const tangle = analyse({
		changedFiles: ["apps/console/components/alerts/panel.tsx"],
		refs: [1],
		scopes: scopeOf(["scripts/check-shared-surface.mjs"]),
		board: [unit(4270, ["apps/console/components/alerts/**"])],
	});
	ok("a file another open unit owns is an ERROR", tangle.verdict === "COLLISIONS" && tangle.errors.length === 1);
	ok(
		"...and the error names BOTH units, because which one is wrong decides the remedy",
		tangle.errors[0].includes("#1") && tangle.errors[0].includes("#4270"),
	);

	// Outside the scope but unowned: the scope is wrong, nothing is tangled.
	const loose = analyse({
		changedFiles: ["docs/somewhere/else.md"],
		refs: [1],
		scopes: scopeOf(["scripts/only.mjs"]),
		board: [unit(4270, ["apps/console/components/alerts/**"])],
	});
	ok("an unclaimed out-of-scope file is a WARNING, not a failure", loose.verdict === "CLEAN" && loose.warnings.length === 1);

	// A unit that is not claimable owns nothing for this purpose — `epic`, `blocked`, `needs:human`.
	for (const label of ["epic", "blocked", "needs:human"]) {
		const skipped = analyse({
			changedFiles: ["apps/console/components/alerts/panel.tsx"],
			refs: [1],
			scopes: scopeOf(["scripts/only.mjs"]),
			board: [unit(4270, ["apps/console/components/alerts/**"], { labels: [{ name: label }] })],
		});
		ok(
			`a \`${label}\` unit is not treated as an owner — claim-work.sh would never hand it out`,
			skipped.verdict === "CLEAN",
			`got ${skipped.verdict}`,
		);
	}

	// ── the three ways this must not pass quietly ──
	ok(
		"a PR closing nothing is NOT-APPLICABLE and says so",
		(() => {
			const r = analyse({ changedFiles: ["a.ts"], refs: [], scopes: new Map(), board: [] });
			return r.verdict === "NOT-APPLICABLE" && r.notes.length === 1 && r.errors.length === 0;
		})(),
	);
	ok(
		"a PR that closes an issue and changed NOTHING is BLIND, not clean",
		analyse({ changedFiles: [], refs: [1], scopes: scopeOf(["a/**"]), board: [] }).verdict === "BLIND",
	);
	ok(
		"an unfetchable issue body is BLIND, not clean",
		analyse({ changedFiles: ["a.ts"], refs: [7], scopes: new Map(), board: [] }).verdict === "BLIND",
	);
	ok(
		"an issue with NO scope line warns and does not fail",
		(() => {
			const r = analyse({
				changedFiles: ["a.ts"],
				refs: [1],
				scopes: new Map([[1, readScope("no scope line at all")]]),
				board: [],
			});
			return r.errors.length === 0 && r.warnings.length === 1;
		})(),
	);

	// ── MUTATION CONTROLS: each asserts the check would NOTICE the thing it protects ──
	ok(
		"mutation: widening the scope to cover the file clears the error",
		analyse({
			changedFiles: ["apps/console/components/alerts/panel.tsx"],
			refs: [1],
			scopes: scopeOf(["apps/console/components/alerts/**"]),
			board: [unit(4270, ["apps/console/components/alerts/**"])],
		}).verdict === "CLEAN",
	);
	ok(
		"mutation: a prefix glob subsumes a deeper path, as scope-overlap defines it",
		analyse({
			changedFiles: ["apps/cli/cmd/deep/nested/file.go"],
			refs: [1],
			scopes: scopeOf(["apps/cli/cmd/**"]),
			board: [],
		}).verdict === "CLEAN",
	);
	ok(
		"mutation: a sibling directory does NOT count as in scope",
		analyse({
			changedFiles: ["apps/cli/pkg/other.go"],
			refs: [1],
			scopes: scopeOf(["apps/cli/cmd/**"]),
			board: [],
		}).warnings.length === 1,
	);

	// ── THE REGRESSION CASE, CAPTURED FROM THE INCIDENT AND NOT COMPOSED ─────────────────────────
	//
	// #4309's declared scope as it stood on 2026-09-09 (quoted verbatim in #4442's own body) against
	// four of the 35 files its PR #4441 actually changed, and the two owning units' real `scope:`
	// lines. The live PR no longer reproduces it — #4309's scope has since been widened to 35 globs,
	// exactly matching its diff — which is why the evidence is pinned here instead of left as
	// "run it against #4441 and see".
	//
	// The board is a FIXTURE and not the live board on purpose: #4270 owned five of the alerts files
	// at the time and has since merged, so a live read gets fewer findings every day. A regression
	// case whose subject decays is not a regression case.
	const incidentScope = readScope(
		"scope: scripts/check-shared-surface.mjs apps/console/shared-surface-allowlist.yaml " +
			"apps/console/components/shell/nav-row.tsx apps/console/components/shell/switcher-trigger.tsx " +
			"packages/ui/src/facet-filter.tsx packages/ui/src/multi-combobox.tsx " +
			"packages/ui/src/funnel-filter.tsx",
	);
	const incident = analyse({
		changedFiles: [
			// in scope — the instrument files the scope line was written for
			"scripts/check-shared-surface.mjs",
			"packages/ui/src/funnel-filter.tsx",
			// owned by #4268
			"apps/console/components/connectors/connection-ui.tsx",
			"apps/console/components/connectors/connector-detail-sheet.tsx",
			"apps/console/components/connectors/connectors-page.tsx",
			// owned by #4275
			"apps/console/components/runners/release-notes-popover.tsx",
			// out of scope, unowned
			"apps/console/app/(private)/[org]/~/jobs/[id]/page.tsx",
		],
		refs: [4309],
		scopes: new Map([[4309, incidentScope]]),
		board: [
			{
				number: 4268,
				labels: [{ name: "class:backend" }],
				body:
					"scope: apps/console/e2e/flows/connectors.spec.ts apps/console/e2e/flows/connectors.negative.spec.ts " +
					"apps/console/e2e/connectors.spec.ts apps/console/components/connectors/**",
			},
			{
				number: 4275,
				labels: [{ name: "class:backend" }],
				body:
					"scope: apps/console/e2e/flows/runners.spec.ts apps/console/e2e/flows/runners.negative.spec.ts " +
					"apps/console/e2e/helpers/seed-runners.ts apps/console/components/runners/**",
			},
		],
	});
	ok("INCIDENT: #4441 against #4309's scope-as-declared FAILS", incident.verdict === "COLLISIONS");
	ok(
		"...naming all four files another unit owned",
		incident.errors.length === 4,
		`got ${incident.errors.length}`,
	);
	ok(
		"...attributing the connectors files to #4268",
		incident.errors.filter((e) => e.includes("#4268")).length === 3,
	);
	ok(
		"...and the runners file to #4275",
		incident.errors.filter((e) => e.includes("#4275")).length === 1,
	);
	ok(
		"...while the unowned out-of-scope file is only a warning",
		incident.warnings.length === 1,
		`got ${incident.warnings.length}`,
	);
	// And the control: with the scope it carries TODAY, the same diff is clean. Without this, the
	// case above could pass because the checker fails everything.
	ok(
		"CONTROL: the same files under a scope that covers them are CLEAN",
		analyse({
			changedFiles: [
				"apps/console/components/connectors/connection-ui.tsx",
				"apps/console/components/runners/release-notes-popover.tsx",
			],
			refs: [4309],
			scopes: new Map([
				[
					4309,
					readScope(
						"scope: apps/console/components/connectors/** apps/console/components/runners/**",
					),
				],
			]),
			board: [
				{ number: 4268, labels: [{ name: "class:backend" }], body: "scope: apps/console/components/connectors/**" },
			],
		}).verdict === "CLEAN",
	);

	console.log(fails === 0 ? "\ncheck-pr-scope self-test: all passed" : `\ncheck-pr-scope self-test: ${fails} FAILED`);
	return fails === 0;
}

if (import.meta.url === `file://${process.argv[1]}`) main();
