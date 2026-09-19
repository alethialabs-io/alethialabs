// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
//
// ONE way to ask GitHub which files a pull request changed.
//
// ── WHY THIS IS SHARED RATHER THAN COPIED ────────────────────────────────────────────────────────
//
// The obvious call — `gh pr diff <n> --name-only` — refuses a large diff:
//
//     HTTP 406: Sorry, the diff exceeded the maximum number of lines (20000)
//     PullRequest.diff too_large
//
// Every guard that reads a PR's file list fails CLOSED on a read it could not make, which is right
// in general. The consequence is not: a dev→staging promotion carries every commit since the last
// promotion, so it is over that limit essentially always, and `protect-staging` requires those
// guards with NO bypass actors. The promotion is then unmergeable by anyone, for a reason that has
// nothing to do with what the guard measures (#4726, PR #4727).
//
// That fix landed in `check-pr-scope.mjs` at 10:10Z on 2026-09-17. At ~13:00Z
// `check-gate-baseline-slice-ownership.mjs` shipped with the same `gh pr diff` call — copied from
// the guard next door, which was the reasonable instinct — and the promotion went red again for
// the identical reason within the hour (#4748). A fix that lives in one consumer does not reach
// the second. So it lives here, and both import it.
//
// ── THE OTHER CEILING, WHICH IS NOT PAPERED OVER ─────────────────────────────────────────────────
//
// `pulls/<n>/files` paginates and has no line limit. It has a DIFFERENT limit — 3000 files — and
// that one is handled by REFUSING, not by falling back a second time. A truncated list is the one
// input a scope guard must never treat as whole: every file past the cut reads as "not in this PR",
// which is silently indistinguishable from a clean measurement.

/** The most paths `pulls/<n>/files` will ever return, however many the PR really changed. */
export const FILES_API_CAP = 3000;

/** @param {string} out @returns {string[]} non-empty trimmed lines */
export function lines(out) {
	return out
		.split("\n")
		.map((s) => s.trim())
		.filter(Boolean);
}

/**
 * Refuse a file list that may have been cut off by the API's own ceiling.
 * @param {string[]} files @param {number} [cap]
 * @returns {string[]} the same list, when it is provably whole
 */
export function refuseIfTruncated(files, cap = FILES_API_CAP) {
	if (files.length >= cap) {
		throw new Error(
			`pulls/<n>/files returned ${files.length} path(s), at or past its ${cap}-file ceiling, so the ` +
				`list may be truncated. Refusing rather than measuring a PR against a partial view of itself ` +
				`— an unseen file cannot collide with anything, which would read as clean.`,
		);
	}
	return files;
}

/**
 * The files a PR changes. Tries the diff endpoint, falls back to the files endpoint, refuses a
 * possibly-truncated answer.
 * @param {string|number} pr
 * @param {(args: string[]) => string} gh a function that shells out to `gh` and returns stdout
 * @param {(msg: string) => void} [log] where to report that the fallback was taken
 * @returns {string[]}
 */
export function changedFilesForPR(pr, gh, log = console.log) {
	try {
		return lines(gh(["pr", "diff", String(pr), "--name-only"]));
	} catch (err) {
		// Fall through on ANY failure, not only `too_large`: the fallback is strictly better-informed
		// than the primary, and if it fails too the error propagates and the caller still fails closed.
		log(
			`pr-changed-files: \`gh pr diff\` could not answer for #${pr} ` +
				`(${err instanceof Error ? err.message.split("\n")[0] : String(err)}); ` +
				`reading pulls/${pr}/files instead.`,
		);
	}
	return refuseIfTruncated(
		lines(gh(["api", `repos/{owner}/{repo}/pulls/${pr}/files`, "--paginate", "--jq", ".[].filename"])),
	);
}
