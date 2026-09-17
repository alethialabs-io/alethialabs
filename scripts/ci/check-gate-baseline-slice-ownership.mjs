#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
//
// `--only` IS FILE-SCOPED. A BARE `--write` IS NOT — AND NOTHING SAID SO.
//
//   node scripts/ci/check-gate-baseline-slice-ownership.mjs                    # in CI, from the PR
//   node scripts/ci/check-gate-baseline-slice-ownership.mjs --base=<ref> --head=<ref>
//   node scripts/ci/check-gate-baseline-slice-ownership.mjs --self-test
//
// ── WHY IT EXISTS (#4615) ────────────────────────────────────────────────────────────────────
//
// Four lanes in `wave:release-gate` declare `apps/console/e2e/gate-baseline.json` in their
// `scope:` (#4271, #4274, #4456, #4272), because each slices it for its own spec files. That is
// the intended design — a shared registry is DECLARED by every lane that touches it, and
// `check-pr-scope.mjs` is satisfied. The safety then rests entirely on a convention that nothing
// enforced: every lane is told to regenerate with
//
//     node scripts/e2e-ratchet.mjs --project=<p> --results=<json> --write --only=<its spec file>
//
// and `--only` is the only thing making that FILE-scoped. Read the writer (`scripts/e2e-ratchet.mjs`):
//
//     if (args.only.length) { … next = { ...current, ...toBaseline(scoped) }; }   ← merge
//     else next = toBaseline(run);                                               ← REPLACE
//
// A bare `--write` does not merge. It REPLACES the whole `projects[<p>]` object with whatever that
// one run produced, so every sibling lane's slice under that project is re-recorded from a tree
// that does not contain the sibling's work — and any entry the run did not produce is DELETED
// outright.
//
// ── AND IT IS SILENT IN THE DANGEROUS DIRECTION ──────────────────────────────────────────────
//
// After a bare `--write`, the ledger matches THAT LANE's tree. For a sibling's spec files the
// lane's tree is just `dev`, so the rewritten slice is self-consistent and every existing
// instrument agrees with it:
//
//   · `check-gate-baseline-consistency.mjs` (#4460) passes — tree and ledger agree ON THIS BRANCH,
//     and this branch is the wrong tree to ask;
//   · the ratchet passes — there is no regression against the ledger it has just rewritten;
//   · `check-pr-scope.mjs` passes — the file is declared in the lane's `scope:`.
//
// Three green gates, the sibling's pending slice discarded on merge, and nobody told. #4433 is the
// same damage arrived at by a different route (a lane merged with its slice unregenerated and the
// NEXT PR inherited the red); #4465 was its remediation, and it was urgent rather than optional.
//
// The neighbouring hazard was measured directly on 2026-09-17, on one rebase of this very lane:
// `gate-baseline.json` itself MERGES CLEANLY, because it partitions by project → file → title and
// git resolves disjoint keys. The `LEDGER-CENSUS` summary line in `scripts/e2e-ratchet.mjs` does
// not — `dev` said `647 tests / 40 failed`, the branch said `645 / 42`, and the true merged value
// was `649 / 25`. NEITHER SIDE OF THAT CONFLICT WAS EVER TRUE OF ANY TREE. (#4648 tracks the
// census half; it is not this file's subject.) Clean-merging is exactly why this file needs a
// guard rather than a conflict marker: a defective slice arrives with no friction at all.
//
// ── THE RULE ─────────────────────────────────────────────────────────────────────────────────
//
// For every (project, spec file) SLICE the PR's `gate-baseline.json` diff changes, the PR must
// have earned the right to change it. It has, if ANY of five things is true:
//
//   R1  THE PR MODIFIES THAT SPEC FILE. The ordinary case, and the one `--only` is named for.
//
//   R2  THE SLICE IS NEW — the file had no entries at all before. A bootstrap capture cannot
//       discard a sibling's pending slice, because there was nothing there to discard. (#4532
//       captured `audit-interaction`'s 48 entries exactly this way: the leg could not go green at
//       all until it existed.)
//
//   R3  EVERY CHANGE IN THE SLICE IS A TIGHTENING OF AN ENTRY THAT ALREADY EXISTED — its value
//       became `"passed"`. This is the direction that is LOUD IF WRONG: the ratchet's rule 1 reds
//       the very next gate run if the test does not in fact pass, so a lane cannot hide anything
//       here. It is also the ordinary shape of a fix landing in app code rather than in a spec
//       (#4390 moved five `audit/routes.spec.ts` entries for routes that #4351 and #4348 fixed).
//       "Of an entry that already existed" is load-bearing and was the second draft: an ADDED
//       entry whose value is `"passed"` is not a tightening, it is the adoption of a test the
//       ledger had never recorded — which is precisely the #4433 slice arriving in the wrong PR.
//
//   R4  THE PR'S ENTIRE DIFF IS THE BASELINE FILE. A deliberate ledger move (#4465, #4390) has no
//       lane work for a stray `--write` to ride along with; it is a PR whose only content IS the
//       re-recording, reviewed as such. See the omission below — this is the one exemption that is
//       a judgement rather than a proof.
//
//   R5  THE SLICE'S TEST TITLES ARE GENERATED FROM A DECLARED SOURCE, AND THE PR MODIFIES THAT
//       SOURCE. `audit/destructive.spec.ts` builds one `test()` per row of
//       `apps/console/destructive-actions.yaml` and puts the row's `confirm` and `status` IN THE
//       TITLE, so adding a confirmation anywhere in the console renames entries in a spec file
//       nobody touched. Seven of the nineteen commits measured below do exactly that. Without R5
//       this guard would red most of the PRs the repo actually ships.
//
// ── MEASURED, NOT PREDICTED ──────────────────────────────────────────────────────────────────
//
// The rule was run over all eighteen commits in `dev`'s history that touch the ledger and have a
// parent that also carries it (`ed0c6e622` is the file's birth and has none). All eighteen pass.
// That number is the point: the rule stated in #4615 — "a slice touched for a spec file the PR does
// not modify is a finding" — fires on NINE of those eighteen, and every one of the nine is
// legitimate. Shipping the issue's own sentence would have red half the wave. The five exemptions
// are not softenings; they are what the corpus says the rule actually is.
//
// ── WHAT THIS DELIBERATELY DOES NOT DO ───────────────────────────────────────────────────────
//
//   * IT DOES NOT CATCH A BARE `--write` IN A PR WHOSE ONLY CHANGE IS THE BASELINE (R4). Such a PR
//     cannot be separated by diff shape from the remediation it looks exactly like — both re-record
//     a spec file the PR does not contain, for a reason that lives outside the diff. The exemption
//     is stated here rather than left to be inferred, because an unstated exception is how the next
//     reader concludes the whole rule is enforced.
//   * IT DOES NOT FIND AN UNDECLARED TITLE-GENERATING SPEC. Seven of the console's 42 spec files
//     build a title from a template literal, but most interpolate a constant declared in the same
//     file — which is not a hazard, and a text scan cannot tell the two apart. The failure mode of
//     the omission is a FALSE POSITIVE on a legitimate PR, which is loud, names the file and prints
//     the fix; the opposite choice would have been a silent miss. `TITLE_SOURCES` still fails in
//     both directions for what it DOES declare — see `checkLedger`.
//   * IT DOES NOT ASK WHETHER THE RECORDED VALUE IS TRUE. That needs a run, and the run is the
//     `Release gate (<leg>)` legs. This is a DIFF READ: no browser, no Postgres, no console.
//   * IT DOES NOT READ THE WORKING TREE FOR THE HEAD VERSION. Both sides come from the same
//     three-dot comparison `gh pr diff` uses, because `actions/checkout` on a `pull_request` gives
//     you `refs/pull/N/merge` — the head merged into the CURRENT base tip. On a file this hot,
//     diffing that against the merge base attributes `dev`'s own landed slices to the PR.
//
// ── ON A `push` THERE IS NO PR AND NOTHING TO COMPARE ─────────────────────────────────────────
//
// It reports that and exits 0. A required check that does not always report WEDGES the merge
// queue, so the step lives in the `guards` job (which already runs on every PR and already holds
// `pull-requests: read` for `check-pr-scope.mjs`) and never refuses to answer.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const BASELINE = "apps/console/e2e/gate-baseline.json";
const SPEC_RE = /\.spec\.ts$/;

/** The reason floor, in characters. Same purpose as check-upload-aggregate.mjs's: a `reason:` short
 *  enough to be typed to get past the check is not a decision anybody made. */
const REASON_FLOOR = 90;

/**
 * Spec files whose test TITLES are generated from repo data outside the file, and the paths that
 * data lives in. Changing one of those paths renames ledger entries in a spec file nobody edited,
 * so a PR that modifies a source has earned the slice (R5).
 *
 * This ledger fails in BOTH directions — see `checkLedger`. An entry that outlives its subject is
 * the dangerous half: it would go on excusing a slice long after the generation that justified it
 * was removed, and it would do that in silence, which is the same defect this whole file is about.
 */
export const TITLE_SOURCES = {
	"audit-interaction|audit/destructive.spec.ts": {
		sources: ["apps/console/destructive-actions.yaml", "scripts/check-destructive-actions.mjs"],
		reason:
			"One test() per registry row, with the row's `confirm` and `status` INTERPOLATED INTO THE TITLE " +
			"(`${entry.id} — declares ${entry.confirm} (${entry.status})`). Adding a confirmation anywhere in " +
			"the console therefore renames this slice's entries without touching the spec. Measured: this " +
			"happened in 7 of the 19 commits in dev's history that move the ledger.",
	},
	"audit|audit/routes.spec.ts": {
		sources: ["scripts/lib/console-routes.mjs"],
		reason:
			"One test() per private console route, titled with the route path itself, read from " +
			"console-routes.mjs through audit/manifest.ts in a subprocess. Adding or renaming a route moves " +
			"this slice with no edit to the spec file, exactly as it moves the route registry.",
	},
};

/**
 * Is this ledger value the `"passed"` state?
 * @param {unknown} v
 * @returns {boolean}
 */
const isPassed = (v) => v === "passed";

/**
 * Every (project, file) slice whose entries differ between two baseline documents.
 *
 * Compares by VALUE, not by JSON text: `{fixme: "…"}` and `{fixme: "…"}` with different key order
 * are the same record, and a re-serialisation that reordered them must not read as a rewrite.
 *
 * @param {unknown} before the baseline document at the merge base
 * @param {unknown} after the baseline document at the PR head
 * @returns {{project: string, file: string, changes: {title: string, from: unknown, to: unknown}[]}[]}
 */
export function diffSlices(before, after) {
	const P = (doc) => (typeof doc === "object" && doc !== null && typeof doc.projects === "object" && doc.projects !== null ? doc.projects : {});
	const A = P(before);
	const B = P(after);
	const stable = (v) => {
		if (typeof v !== "object" || v === null) return JSON.stringify(v);
		return JSON.stringify(Object.fromEntries(Object.entries(v).sort(([x], [y]) => (x < y ? -1 : 1))));
	};
	/** @type {{project: string, file: string, changes: {title: string, from: unknown, to: unknown}[]}[]} */
	const out = [];
	for (const project of [...new Set([...Object.keys(A), ...Object.keys(B)])].sort()) {
		const a = A[project] ?? {};
		const b = B[project] ?? {};
		for (const file of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
			const ta = a[file] ?? {};
			const tb = b[file] ?? {};
			const changes = [];
			for (const title of [...new Set([...Object.keys(ta), ...Object.keys(tb)])].sort()) {
				if (stable(ta[title]) !== stable(tb[title])) changes.push({ title, from: ta[title], to: tb[title] });
			}
			if (changes.length > 0) out.push({ project, file, changes, existedBefore: Object.keys(ta).length > 0 });
		}
	}
	return out;
}

/**
 * The findings for one PR.
 *
 * @param {object} input
 * @param {unknown} input.before baseline document at the merge base
 * @param {unknown} input.after baseline document at the PR head
 * @param {string[]} input.changedFiles repo-relative paths the PR changes
 * @param {Record<string, {sources: string[], reason: string}>} [input.titleSources]
 * @returns {{findings: string[], notes: string[]}}
 */
export function analyse({ before, after, changedFiles, titleSources = TITLE_SOURCES }) {
	const findings = [];
	const notes = [];
	const slices = diffSlices(before, after);
	if (slices.length === 0) return { findings, notes: ["the PR changes no ledger slice."] };

	// R4 — the PR's WHOLE diff is the baseline. Computed once; it is a property of the PR, not of a
	// slice. `changedFiles` being empty is not this case: it is no measurement at all, and a PR that
	// reached here with a changed baseline and an empty file list was read wrong upstream.
	if (changedFiles.length === 0) {
		findings.push(
			`the ledger changed ${slices.length} slice(s) but the PR's changed-file list is EMPTY. That is no ` +
				`measurement, not a clean one — refusing rather than excusing every slice for want of a list.`,
		);
		return { findings, notes };
	}
	const ledgerOnly = changedFiles.length === 1 && changedFiles[0] === BASELINE;
	if (ledgerOnly) {
		notes.push(
			`the PR changes nothing but ${BASELINE}, so every slice in it is a deliberate ledger move (R4) and ` +
				`is reviewed as one. This guard cannot separate that from a bare \`--write\` and does not try.`,
		);
		return { findings, notes };
	}

	const changed = new Set(changedFiles);
	const touchesSpec = (file) => changedFiles.some((c) => c === file || c.endsWith(`/${file}`));

	for (const { project, file, changes, existedBefore } of slices) {
		if (touchesSpec(file)) continue; // R1
		if (!existedBefore) {
			notes.push(`${project}/${file}: a NEW slice (${changes.length} entries) — nothing to discard (R2).`);
			continue; // R2
		}
		if (changes.every((c) => c.from !== undefined && isPassed(c.to))) {
			notes.push(`${project}/${file}: ${changes.length} tightening(s) to "passed" on existing entries (R3) — loud if wrong.`);
			continue; // R3
		}
		const entry = titleSources[`${project}|${file}`];
		if (entry !== undefined && entry.sources.some((s) => changed.has(s))) {
			notes.push(`${project}/${file}: titles are generated from ${entry.sources.filter((s) => changed.has(s)).join(", ")}, which this PR modifies (R5).`);
			continue; // R5
		}

		const added = changes.filter((c) => c.from === undefined);
		const removed = changes.filter((c) => c.to === undefined);
		const loosened = changes.filter((c) => c.from !== undefined && c.to !== undefined && !isPassed(c.to));
		const shape = [
			added.length > 0 ? `${added.length} entry/entries ADDED` : null,
			removed.length > 0 ? `${removed.length} REMOVED` : null,
			loosened.length > 0 ? `${loosened.length} LOOSENED away from "passed"` : null,
		]
			.filter(Boolean)
			.join(", ");
		const sample = changes
			.slice(0, 3)
			.map((c) => `      "${c.title}": ${c.from === undefined ? "(absent)" : JSON.stringify(c.from)} → ${c.to === undefined ? "(deleted)" : JSON.stringify(c.to)}`)
			.join("\n");
		findings.push(
			`${BASELINE}: the slice for \`${file}\` under project \`${project}\` changed (${shape}), but this PR does ` +
				`not modify that spec file.\n${sample}${changes.length > 3 ? `\n      … and ${changes.length - 3} more` : ""}\n` +
				`    A bare \`node scripts/e2e-ratchet.mjs --project=${project} … --write\` REPLACES every slice under ` +
				`\`${project}\` with its own run, so a sibling lane's pending slice is discarded and nothing says so. ` +
				`Regenerate file-scoped instead: \`--write --only=<your spec file>\` (repeat the flag for each file you ` +
				`own), restore this slice from the merge base, and push.` +
				(entry === undefined
					? ""
					: `\n    (\`${project}|${file}\` IS declared in TITLE_SOURCES, but this PR modifies none of ${entry.sources.join(", ")}.)`),
		);
	}
	return { findings, notes };
}

/**
 * `TITLE_SOURCES` fails in BOTH directions. An undeclared generated slice is a false positive —
 * loud, named, with the fix printed. An entry that OUTLIVES its subject is the silent one: it goes
 * on excusing a slice after the generation that justified it is gone, and suppresses a real
 * finding forever. So each entry must still name (a) a slice the ledger carries, (b) source paths
 * that exist, and (c) a spec file that still builds a title by interpolation.
 *
 * @param {Record<string, {sources: string[], reason: string}>} ledger
 * @param {unknown} baselineDoc
 * @param {(p: string) => boolean} exists
 * @param {(p: string) => string} read
 * @returns {string[]}
 */
export function checkLedger(ledger, baselineDoc, exists, read) {
	const out = [];
	const projects = typeof baselineDoc === "object" && baselineDoc !== null && typeof baselineDoc.projects === "object" ? baselineDoc.projects : {};
	for (const [key, entry] of Object.entries(ledger)) {
		const [project, file] = key.split("|");
		if (project === undefined || file === undefined || file === "") {
			out.push(`TITLE_SOURCES["${key}"]: the key is not \`<project>|<spec file>\`.`);
			continue;
		}
		if (typeof entry.reason !== "string" || entry.reason.trim().length < REASON_FLOOR) {
			out.push(
				`TITLE_SOURCES["${key}"]: its reason is ${typeof entry.reason === "string" ? `${entry.reason.trim().length} characters` : "missing"}, under the ` +
					`${REASON_FLOOR}-character floor. An exemption whose reason is a placeholder is an exemption nobody decided on.`,
			);
		}
		if (projects[project]?.[file] === undefined) {
			out.push(
				`TITLE_SOURCES["${key}"]: ${BASELINE} carries no slice for that (project, file). The entry has OUTLIVED ` +
					`its subject — delete it. A stale exemption suppresses a real finding in silence, which is the failure ` +
					`this guard exists to make loud.`,
			);
			continue;
		}
		if (!Array.isArray(entry.sources) || entry.sources.length === 0) {
			out.push(`TITLE_SOURCES["${key}"]: names no source paths, so it can never be satisfied and excuses the slice unconditionally.`);
			continue;
		}
		for (const s of entry.sources) {
			if (!exists(s)) {
				out.push(`TITLE_SOURCES["${key}"]: the declared source \`${s}\` does not exist. The entry has OUTLIVED its subject.`);
			}
		}
		// (c) — the spec must still BUILD a title rather than write one. A file whose every `test()`
		// takes a string literal cannot move without being edited, so the exemption has no subject
		// left even though the slice and the sources are all still there. This is the direction a
		// path-existence check alone cannot see.
		const spec = path.join("apps/console/e2e", file);
		if (!exists(spec)) {
			out.push(`TITLE_SOURCES["${key}"]: \`${spec}\` does not exist. The entry has OUTLIVED its subject.`);
			continue;
		}
		if (!/^\s*test(\.[a-z]+)?\(\s*`[^`]*\$\{/m.test(read(spec))) {
			out.push(
				`TITLE_SOURCES["${key}"]: \`${spec}\` no longer builds any test title by interpolation, so its entries can ` +
					`no longer move without an edit to the file. The entry has OUTLIVED its subject — delete it.`,
			);
		}
	}
	return out;
}

// ── live inputs ───────────────────────────────────────────────────────────────────────────────

/** @param {string[]} args @returns {string} */
function gh(args) {
	return execFileSync("gh", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

/** @param {string[]} args @returns {string} */
function git(args) {
	return execFileSync("git", args, { encoding: "utf8", cwd: ROOT, maxBuffer: 64 * 1024 * 1024 });
}

/** The PR number from the Actions event payload, or null when this is not a `pull_request` run. */
function prNumber() {
	const p = process.env.GITHUB_EVENT_PATH;
	if (process.env.GITHUB_EVENT_NAME !== "pull_request" || !p || !fs.existsSync(p)) return null;
	const n = JSON.parse(fs.readFileSync(p, "utf8"))?.pull_request?.number;
	return Number.isInteger(n) ? n : null;
}

/** Parse `{"a": 1}` from a JSON blob, or throw naming what failed. */
const parse = (text, what) => {
	try {
		return JSON.parse(text);
	} catch (err) {
		throw new Error(`${what}: not JSON (${err instanceof Error ? err.message : String(err)})`);
	}
};

/**
 * Both sides of the comparison, from the API, at the SAME two commits `gh pr diff` uses.
 * @param {number} pr
 * @returns {{before: unknown, after: unknown, changedFiles: string[]}}
 */
function fromPullRequest(pr) {
	const repo = process.env.GITHUB_REPOSITORY;
	if (!repo) throw new Error("GITHUB_REPOSITORY is unset, so the API paths cannot be built.");
	const meta = parse(gh(["api", `repos/${repo}/pulls/${pr}`]), `pulls/${pr}`);
	const cmp = parse(gh(["api", `repos/${repo}/compare/${meta.base.sha}...${meta.head.sha}`]), "compare");
	const mergeBase = cmp?.merge_base_commit?.sha;
	if (typeof mergeBase !== "string") throw new Error("the compare endpoint named no merge_base_commit — refusing to diff against the wrong base.");
	const blob = (ref) => {
		try {
			return parse(gh(["api", `repos/${repo}/contents/${BASELINE}?ref=${ref}`, "-H", "Accept: application/vnd.github.raw"]), `${BASELINE}@${ref}`);
		} catch {
			return null; // the file did not exist at that commit — a birth, handled as an all-new slice set
		}
	};
	const changedFiles = gh(["pr", "diff", String(pr), "--name-only"])
		.split("\n")
		.map((s) => s.trim())
		.filter(Boolean);
	return { before: blob(mergeBase), after: blob(meta.head.sha), changedFiles };
}

/**
 * Both sides from local git, for running this on a branch before pushing.
 * @param {string} base @param {string} head
 */
function fromGit(base, head) {
	const mergeBase = git(["merge-base", base, head]).trim();
	const blob = (ref) => {
		try {
			return JSON.parse(git(["show", `${ref}:${BASELINE}`]));
		} catch {
			return null;
		}
	};
	const changedFiles = git(["diff", "--name-only", `${mergeBase}`, head])
		.split("\n")
		.map((s) => s.trim())
		.filter(Boolean);
	return { before: blob(mergeBase), after: blob(head), changedFiles };
}

/**
 * @param {string[]} argv
 * @returns {number} the process exit code
 */
export function main(argv) {
	const base = argv.find((a) => a.startsWith("--base="))?.slice("--base=".length);
	const head = argv.find((a) => a.startsWith("--head="))?.slice("--head=".length);
	const unknown = argv.filter((a) => !/^--(base|head)=/.test(a));
	if (unknown.length > 0) {
		// USAGE, NOT A FINDING — and deliberately NOT a `::error::` annotation. The self-test asserts
		// both usage paths by calling `main()`, so annotating them paints two red annotations onto a
		// step that PASSED, and the next person reading the guards job sees a green check with errors
		// under it. That is the same confusion in mirror image as a `continue-on-error` step reporting
		// `success` with `##[error]` lines in its log. A genuine finding below still annotates.
		console.error(`check-gate-baseline-slice-ownership: unrecognised argument(s): ${unknown.join(" ")}`);
		return 2;
	}

	// The ledger is checked on EVERY invocation, PR or not. A stale exemption is a defect in the
	// tree, and a tree-level defect that is only visible on a pull_request run is one nobody sees.
	const baselineDoc = fs.existsSync(path.join(ROOT, BASELINE)) ? JSON.parse(fs.readFileSync(path.join(ROOT, BASELINE), "utf8")) : null;
	const ledgerProblems = checkLedger(
		TITLE_SOURCES,
		baselineDoc,
		(p) => fs.existsSync(path.join(ROOT, p)),
		(p) => fs.readFileSync(path.join(ROOT, p), "utf8"),
	);
	for (const p of ledgerProblems) console.error(`::error::check-gate-baseline-slice-ownership: ${p}`);

	let inputs;
	if (base !== undefined || head !== undefined) {
		if (base === undefined || head === undefined) {
			console.error("check-gate-baseline-slice-ownership: --base and --head are given together or not at all."); // usage — see above
			return 2;
		}
		inputs = fromGit(base, head);
	} else {
		const pr = prNumber();
		if (pr === null) {
			console.log("check-gate-baseline-slice-ownership: not a pull_request run — there is no PR diff to read, so there is nothing to compare. The TITLE_SOURCES ledger was still checked.");
			return ledgerProblems.length > 0 ? 1 : 0;
		}
		inputs = fromPullRequest(pr);
	}

	const { findings, notes } = analyse({ ...inputs });
	for (const n of notes) console.log(`check-gate-baseline-slice-ownership: ${n}`);
	for (const f of findings) console.error(`::error::check-gate-baseline-slice-ownership: ${f}`);
	const total = findings.length + ledgerProblems.length;
	if (total > 0) {
		console.error(
			`\ncheck-gate-baseline-slice-ownership: ${total} finding(s). \`--only\` is file-scoped; a bare \`--write\` ` +
				`REPLACES every slice under the project from one run, and the sibling lane it overwrites is told nothing.`,
		);
		return 1;
	}
	console.log(`check-gate-baseline-slice-ownership: ${inputs.changedFiles.length} changed file(s); every ledger slice this PR moves is one it has earned.`);
	return 0;
}

// ── self-test ─────────────────────────────────────────────────────────────────────────────────
//
// FIXTURES ARE CAPTURED, NOT COMPOSED, wherever the shape matters: `REAL_*` below are the actual
// before/after slices of `c0a129855` (#4610) and `5364b3e9b` (#4465) as they landed on `dev`, not
// something written afterwards to match the implementation.

function selfTest() {
	let fails = 0;
	const ok = (name, cond, detail = "") => {
		if (cond) console.log(`ok   - ${name}`);
		else {
			console.error(`FAIL - ${name} ${detail}`);
			fails++;
		}
	};

	const doc = (projects) => ({ version: 1, projects });
	const run = (before, after, changedFiles, titleSources = {}) => analyse({ before: doc(before), after: doc(after), changedFiles, titleSources });

	const QA_A = "flows/alerts.spec.ts";
	const QA_B = "flows/rbac.spec.ts";
	const SPEC_A = `apps/console/e2e/${QA_A}`;
	const SPEC_B = `apps/console/e2e/${QA_B}`;

	// ── D1  THE DEFECT ITSELF. A lane rewrote its own spec, and its bare `--write` re-recorded the
	//        sibling's slice from its own run: one entry loosened away from "passed".
	const d1 = run(
		{ qa: { [QA_A]: { "A › x": "passed" }, [QA_B]: { "B › y": "passed" } } },
		{ qa: { [QA_A]: { "A › x": "passed" }, [QA_B]: { "B › y": "failed" } } },
		[SPEC_A, BASELINE],
	);
	ok("D1 a sibling slice LOOSENED by a PR that does not touch the spec is a finding", d1.findings.length === 1, JSON.stringify(d1.findings));
	ok("D1 …and the finding names the spec file", d1.findings.some((f) => f.includes(QA_B)));
	ok("D1 …and the project", d1.findings.some((f) => /project `qa`/.test(f)));
	ok("D1 …and states the mechanism (bare --write REPLACES)", d1.findings.some((f) => /REPLACES every slice/.test(f)));
	ok("D1 …and prints the fix", d1.findings.some((f) => /--write --only=/.test(f)));
	ok("D1 …and shows the value that moved", d1.findings.some((f) => /"passed" → "failed"/.test(f)));

	// ── D2  A DELETED ENTRY. `next = toBaseline(run)` drops anything the run did not produce, and a
	//        dropped entry is not ratcheted at all afterwards — the quietest damage of the three.
	const d2 = run({ qa: { [QA_A]: { "A › x": "passed" }, [QA_B]: { "B › y": "failed" } } }, { qa: { [QA_A]: { "A › x": "passed" }, [QA_B]: {} } }, [SPEC_A, BASELINE]);
	ok("D2 an entry DELETED from a sibling slice is a finding", d2.findings.some((f) => f.includes(QA_B) && /REMOVED/.test(f)), JSON.stringify(d2.findings));
	ok("D2 …and reports it as deleted, not as a value change", d2.findings.some((f) => /\(deleted\)/.test(f)));

	// ── D3  AN ADDED ENTRY. This is the #4433 shape arriving in the wrong PR: the sibling's spec
	//        already landed on `dev` with its slice unregenerated, and this lane's bare `--write`
	//        adopts it. Its value is "passed", which is why R3 is restricted to entries that
	//        EXISTED — an earlier draft exempted this and would have missed the case outright.
	const d3 = run({ qa: { [QA_A]: { "A › x": "passed" }, [QA_B]: { "B › y": "passed" } } }, { qa: { [QA_A]: { "A › x": "passed" }, [QA_B]: { "B › y": "passed", "B › new": "passed" } } }, [SPEC_A, BASELINE]);
	ok("D3 an ADDED \"passed\" entry in a sibling slice is NOT read as a tightening", d3.findings.some((f) => f.includes(QA_B) && /ADDED/.test(f)), JSON.stringify(d3.findings));

	// ── D4  A fixme/skip record swapped for another is a change even though neither side is a
	//        string. Compared by value, so key order is not a rewrite.
	const d4 = run({ qa: { [QA_B]: { "B › y": { fixme: "BUG: a #1" } } } }, { qa: { [QA_B]: { "B › y": { fixme: "BUG: b #2" } } } }, [SPEC_A, BASELINE]);
	ok("D4 a changed fixme in a sibling slice is a finding", d4.findings.length === 1, JSON.stringify(d4.findings));
	const d4b = run({ qa: { [QA_B]: { "B › y": { fixme: "BUG: a #1", skip: "" } } } }, { qa: { [QA_B]: { "B › y": { skip: "", fixme: "BUG: a #1" } } } }, [SPEC_A, BASELINE]);
	ok("D4 …but a REORDERED record is not a change at all", d4b.findings.length === 0 && /no ledger slice/.test(d4b.notes[0]), JSON.stringify(d4b));

	// ── R1  the ordinary case.
	const r1 = run({ qa: { [QA_B]: { "B › y": "failed" } } }, { qa: { [QA_B]: { "B › y": { skip: "no seat" } } } }, [SPEC_B, BASELINE]);
	ok("R1 a slice for a spec the PR DOES modify is fine", r1.findings.length === 0, JSON.stringify(r1.findings));
	// A slice is earned by THE spec file, and the two ways to lose that boundary are both live here.
	// `flows/rbac.negative.spec.ts` is a real sibling of `flows/rbac.spec.ts` that any stem-substring
	// match would swallow; `xflows/rbac.spec.ts` is the other end — a path that ENDS WITH the slice
	// key and is a different file, which is what the leading `/` in `endsWith("/" + file)` refuses.
	const r1n = run({ qa: { [QA_B]: { "B › y": "failed" } } }, { qa: { [QA_B]: { "B › y": "failed", "B › z": "failed" } } }, [`apps/console/e2e/flows/rbac.negative.spec.ts`, BASELINE]);
	ok("R1 …and a NEAR-MISS filename does not count as modifying it", r1n.findings.length === 1, JSON.stringify(r1n.findings));
	const r1b = run({ qa: { [QA_B]: { "B › y": "failed" } } }, { qa: { [QA_B]: { "B › y": "failed", "B › z": "failed" } } }, [`apps/console/e2e/xflows/rbac.spec.ts`, BASELINE]);
	ok("R1 …and a path that merely ENDS WITH the slice key is a different file", r1b.findings.length === 1, JSON.stringify(r1b.findings));

	// ── R2  a bootstrap capture (#4532 captured audit-interaction's 48 entries this way).
	const r2 = run({ qa: { [QA_A]: { "A › x": "passed" } } }, { qa: { [QA_A]: { "A › x": "passed" } }, "audit-interaction": { "audit/destructive.spec.ts": { "a": "passed", "b": "failed" } } }, [SPEC_A, BASELINE]);
	ok("R2 a brand-new slice is not a finding", r2.findings.length === 0, JSON.stringify(r2.findings));
	ok("R2 …and says why", r2.notes.some((n) => /NEW slice/.test(n)));
	// …but the SECOND change to that same slice is judged like any other.
	const r2b = run({ qa: { [QA_A]: { "A › x": "passed" } }, ai: { "c.spec.ts": { a: "passed" } } }, { qa: { [QA_A]: { "A › x": "passed" } }, ai: { "c.spec.ts": { a: "failed" } } }, [SPEC_A, BASELINE]);
	ok("R2 …and an EXISTING slice gets no bootstrap pass", r2b.findings.length === 1, JSON.stringify(r2b.findings));

	// ── R3  the loud-if-wrong direction (#4390 moved five audit/routes entries for routes #4351 fixed).
	const r3 = run({ qa: { [QA_B]: { "B › y": "failed", "B › z": { fixme: "BUG: x #1" } } } }, { qa: { [QA_B]: { "B › y": "passed", "B › z": "passed" } } }, [SPEC_A, BASELINE]);
	ok("R3 a sibling slice that only TIGHTENS to passed is not a finding", r3.findings.length === 0, JSON.stringify(r3.findings));
	ok("R3 …and says the ratchet is what makes it safe", r3.notes.some((n) => /loud if wrong/.test(n)));
	// One loosening among the tightenings takes the whole slice back out of the exemption: a bare
	// `--write` produces both at once, and exempting per-entry would let the damage through beside
	// an improvement.
	const r3b = run({ qa: { [QA_B]: { "B › y": "failed", "B › z": "passed" } } }, { qa: { [QA_B]: { "B › y": "passed", "B › z": "failed" } } }, [SPEC_A, BASELINE]);
	ok("R3 …but ONE loosening among tightenings is still a finding", r3b.findings.length === 1, JSON.stringify(r3b.findings));

	// ── R4  a deliberate ledger move (#4465, #4390 — whole diff is the baseline).
	const r4 = run({ qa: { [QA_B]: { "B › y": "passed" } } }, { qa: { [QA_B]: { "B › y": "failed" } } }, [BASELINE]);
	ok("R4 a PR whose ONLY change is the baseline is a declared ledger move", r4.findings.length === 0, JSON.stringify(r4.findings));
	ok("R4 …and the note states the guard cannot separate it from the defect", r4.notes.some((n) => /cannot separate/.test(n)));
	const r4b = run({ qa: { [QA_B]: { "B › y": "passed" } } }, { qa: { [QA_B]: { "B › y": "failed" } } }, [BASELINE, "README.md"]);
	ok("R4 …and ONE more file in the diff ends the exemption", r4b.findings.length === 1, JSON.stringify(r4b.findings));

	// ── R5  generated titles.
	const TS = {
		"audit-interaction|audit/destructive.spec.ts": { sources: ["apps/console/destructive-actions.yaml"], reason: "x".repeat(REASON_FLOOR) },
	};
	const before5 = { "audit-interaction": { "audit/destructive.spec.ts": { "org.delete — declares none (missing)": "passed" } } };
	const after5 = { "audit-interaction": { "audit/destructive.spec.ts": { "org.delete — declares alert-dialog (confirmed)": "passed" } } };
	const r5 = run(before5, after5, ["apps/console/destructive-actions.yaml", BASELINE], TS);
	ok("R5 a declared generated slice is excused when the PR moves its SOURCE", r5.findings.length === 0, JSON.stringify(r5.findings));
	const r5b = run(before5, after5, ["apps/console/components/org/delete.tsx", BASELINE], TS);
	ok("R5 …and is NOT excused when the PR moves neither the spec nor a source", r5b.findings.length === 1, JSON.stringify(r5b.findings));
	ok("R5 …and the refusal says the entry exists but was not satisfied", r5b.findings.some((f) => /IS declared in TITLE_SOURCES/.test(f)));
	const r5c = run(before5, after5, ["apps/console/destructive-actions.yaml", BASELINE], {});
	ok("R5 …and an UNDECLARED slice gets no exemption from a source it never named", r5c.findings.length === 1, JSON.stringify(r5c.findings));

	// ── the blind cases. A guard that answers on no input is the defect it is guarding against.
	const blind = run({ qa: { [QA_B]: { a: "passed" } } }, { qa: { [QA_B]: { a: "failed" } } }, []);
	ok("an EMPTY changed-file list is refused, not read as a clean PR", blind.findings.some((f) => /no measurement/.test(f)), JSON.stringify(blind.findings));
	const none = run({ qa: { [QA_B]: { a: "passed" } } }, { qa: { [QA_B]: { a: "passed" } } }, [SPEC_A]);
	ok("a PR that moves no slice at all is clean", none.findings.length === 0 && none.notes.some((n) => /no ledger slice/.test(n)));
	const born = analyse({ before: null, after: doc({ qa: { [QA_B]: { a: "passed" } } }), changedFiles: [BASELINE, SPEC_A], titleSources: {} });
	ok("the ledger's BIRTH (no `before` at all) is every slice new, not every slice a finding", born.findings.length === 0, JSON.stringify(born.findings));

	// ── diffSlices directly.
	const ds = diffSlices(doc({ a: { "f.spec.ts": { t: "passed" } } }), doc({ a: { "f.spec.ts": { t: "failed" } }, b: { "g.spec.ts": { u: "passed" } } }));
	ok("diffSlices reports one slice per (project, file)", ds.length === 2 && ds[0].project === "a" && ds[1].project === "b", JSON.stringify(ds));
	ok("diffSlices marks a slice that did not exist before", ds[1].existedBefore === false && ds[0].existedBefore === true);

	// ── THE LEDGER, BOTH DIRECTIONS ───────────────────────────────────────────────────────────
	const GEN = "test(`${entry.id} — declares ${entry.confirm}`, async () => {});";
	const LIT = 'test("a fixed title", async () => {});';
	const goodLedger = { "p|f.spec.ts": { sources: ["src/data.yaml"], reason: "y".repeat(REASON_FLOOR) } };
	const baseDoc = doc({ p: { "f.spec.ts": { t: "passed" } } });
	const has = (set) => (q) => set.has(q);
	const present = new Set(["src/data.yaml", "apps/console/e2e/f.spec.ts"]);
	ok("L0 a well-formed entry is accepted", checkLedger(goodLedger, baseDoc, has(present), () => GEN).length === 0, JSON.stringify(checkLedger(goodLedger, baseDoc, has(present), () => GEN)));
	const noSlice = checkLedger(goodLedger, doc({ p: {} }), has(present), () => GEN);
	ok("L1 an entry whose SLICE is gone is stale", noSlice.some((p) => /OUTLIVED its subject/.test(p)), JSON.stringify(noSlice));
	const noSrc = checkLedger(goodLedger, baseDoc, has(new Set(["apps/console/e2e/f.spec.ts"])), () => GEN);
	ok("L2 an entry whose SOURCE file is gone is stale", noSrc.some((p) => /declared source .* does not exist/.test(p)), JSON.stringify(noSrc));
	const noSpec = checkLedger(goodLedger, baseDoc, has(new Set(["src/data.yaml"])), () => GEN);
	ok("L3 an entry whose SPEC file is gone is stale", noSpec.some((p) => /f\.spec\.ts` does not exist/.test(p)), JSON.stringify(noSpec));
	const notGen = checkLedger(goodLedger, baseDoc, has(present), () => LIT);
	ok("L4 an entry whose spec no longer BUILDS a title is stale — the direction a path check cannot see", notGen.some((p) => /no longer builds any test title/.test(p)), JSON.stringify(notGen));
	const thin = checkLedger({ "p|f.spec.ts": { sources: ["src/data.yaml"], reason: "generated" } }, baseDoc, has(present), () => GEN);
	ok("L5 a reason under the floor is refused", thin.some((p) => /under the/.test(p)), JSON.stringify(thin));
	const noSources = checkLedger({ "p|f.spec.ts": { sources: [], reason: "z".repeat(REASON_FLOOR) } }, baseDoc, has(present), () => GEN);
	ok("L6 an entry naming no sources can never be satisfied and is refused", noSources.some((p) => /names no source paths/.test(p)), JSON.stringify(noSources));
	const badKey = checkLedger({ "nopipe": { sources: ["src/data.yaml"], reason: "z".repeat(REASON_FLOOR) } }, baseDoc, has(present), () => GEN);
	ok("L7 a malformed key is refused rather than silently never matching", badKey.some((p) => /not `<project>\|<spec file>`/.test(p)), JSON.stringify(badKey));

	// ── THE SHIPPED LEDGER, AGAINST THE REAL TREE. The assertions above run on fixtures; this one
	//    runs on what is actually committed, so an entry that goes stale on `dev` reds here too.
	const realDoc = JSON.parse(fs.readFileSync(path.join(ROOT, BASELINE), "utf8"));
	const real = checkLedger(
		TITLE_SOURCES,
		realDoc,
		(p) => fs.existsSync(path.join(ROOT, p)),
		(p) => fs.readFileSync(path.join(ROOT, p), "utf8"),
	);
	ok("the SHIPPED TITLE_SOURCES is current against the real tree", real.length === 0, JSON.stringify(real));
	ok("…and it is not empty (an empty ledger would pass every assertion above vacuously)", Object.keys(TITLE_SOURCES).length >= 2);

	// ── CAPTURED, NOT COMPOSED. `c0a129855` (#4610) rewrote two rbac specs and moved
	//    audit/destructive.spec.ts by 7 added / 7 removed WITHOUT touching it, because #4610 added
	//    confirmations that the registry records. That is the exact PR this guard must not red.
	const REAL_BEFORE = { "audit-interaction": { "audit/destructive.spec.ts": { "member.remove — declares none (missing)": "passed" } }, qa: { [QA_B]: { "B › y": "failed" } } };
	const REAL_AFTER = { "audit-interaction": { "audit/destructive.spec.ts": { "member.remove — declares confirm-dialog (confirmed)": "passed" } }, qa: { [QA_B]: { "B › y": "passed" } } };
	const real4610 = analyse({
		before: doc(REAL_BEFORE),
		after: doc(REAL_AFTER),
		changedFiles: [SPEC_B, "apps/console/destructive-actions.yaml", "apps/console/components/org/members.tsx", BASELINE],
	});
	ok("#4610's real shape (spec + registry + app code) is clean under the SHIPPED ledger", real4610.findings.length === 0, JSON.stringify(real4610.findings));
	// …and the same PR with the registry edit removed is a finding, which is what makes the line above
	// mean something rather than being satisfied by the exemption's mere presence.
	const real4610b = analyse({ before: doc(REAL_BEFORE), after: doc(REAL_AFTER), changedFiles: [SPEC_B, "apps/console/components/org/members.tsx", BASELINE] });
	ok("…and IS a finding once the registry edit that justified it is taken away", real4610b.findings.length === 1, JSON.stringify(real4610b.findings));

	// ── argument handling.
	ok("an unrecognised argument exits 2 rather than checking something else", main(["--all-of-them"]) === 2);
	ok("--base without --head exits 2", main(["--base=dev"]) === 2);
	// …and a USAGE error must not paint a workflow annotation. Asserted through a real subprocess
	// because the thing under test is what reaches the runner's stderr, which an in-process call
	// cannot show: `::error::` on stdout/stderr is how GitHub renders a red annotation, and the two
	// assertions above CALL `main`, so annotating usage puts two red annotations under a step that
	// passed. The first CI run of this file did exactly that.
	const usage = (() => {
		try {
			execFileSync(process.execPath, [fileURLToPath(import.meta.url), "--all-of-them"], { encoding: "utf8", stdio: "pipe" });
			return { rc: 0, err: "" };
		} catch (e) {
			return { rc: e.status ?? 1, err: `${e.stdout ?? ""}${e.stderr ?? ""}` };
		}
	})();
	ok("a usage error exits 2 from a real process", usage.rc === 2, JSON.stringify(usage));
	ok("…and prints NO `::error::` annotation, so a passing step cannot render red", !usage.err.includes("::error::"), JSON.stringify(usage.err));
	ok("…while still saying what was wrong", /unrecognised argument\(s\): --all-of-them/.test(usage.err), JSON.stringify(usage.err));

	if (fails > 0) {
		console.error(`\ncheck-gate-baseline-slice-ownership self-test: ${fails} failure(s)`);
		process.exit(1);
	}
	console.log("\nself-test: all passed");
}

// ── entry ─────────────────────────────────────────────────────────────────────────────────────
//
// Guarded on being the process's own entry point, and the comparison is `path.resolve(argv[1])`
// against `fileURLToPath(import.meta.url)` — NOT `import.meta.url === \`file://${process.argv[1]}\``,
// which differs on a percent-encoded path and on a symlinked checkout. The mutation harness beside
// this file shells out rather than importing, but `check-guards-independent.mjs` and the self-test
// both import from here, and a CLI that ran on import could `process.exit` inside them.
const invokedDirectly = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
	if (process.argv.includes("--self-test")) {
		selfTest();
	} else {
		try {
			process.exit(main(process.argv.slice(2)));
		} catch (err) {
			console.error(`::error::check-gate-baseline-slice-ownership: ${err instanceof Error ? err.message : String(err)}`);
			process.exit(1);
		}
	}
}
