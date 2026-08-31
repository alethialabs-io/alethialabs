// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
//
// The ONE definition of "the TypeScript coverage number", shared by every consumer.
//
// It is a separate module for the same reason `scripts/lib/go-coverage-measure.sh` is: there is
// more than one consumer, and when two of them define the number differently, one of them is
// lying. `apps/cli/scripts/coverage.sh` reported 92.7% for a scope the profile put at 60.9% for
// its whole life, because the gate and the profile disagreed about what a statement was.
//
// ── WHY coverage-final.json AND NOT coverage-summary.json ───────────────────────────────────
//
// Three reasons, in order of weight.
//
// 1. `coverage-final.json` is the artefact vitest emits BY DEFAULT — "json" is in
//    `coverageConfigDefaults.reporter`, while "json-summary" is present in three of this repo's
//    configs only because scripts/coverage-badge.mjs needed it. A gate built on the non-default
//    artefact is a gate every NEW project silently escapes until somebody remembers a reporter
//    string. Built on the default, the gate arrives with the project.
//
// 2. It is the raw map, and the summary is a rollup OF it. Today they agree exactly. But four
//    integers have no internal structure, so a ratchet cannot CHECK them — whereas from the map
//    we assert `keys(statementMap).length === keys(s).length` on every file, which is a
//    corruption tripwire the summary structurally cannot offer.
//
// 3. It makes the metric provider-agnostic. Under the v8 provider one statement is exactly one
//    line (v8-to-istanbul's CovLine.toIstanbul emits whole-line ranges). Under `istanbul` it is
//    not — several statements share a line. A ratchet reading `summary.lines` would therefore be
//    measuring a DIFFERENT METRIC per project without ever saying so. Computing statements from
//    `s` means the definition is identical everywhere by construction.
//
// ── WHY STATEMENTS AND NOT LINES ────────────────────────────────────────────────────────────
//
// `lines` is DERIVED: istanbul's getLineCoverage() takes the max hit count over the statements
// sharing a line. Under an istanbul provider that derivation hides a regression where one of two
// statements on a line stops running. `statements` is the raw universe with no derivation.
//
// ── WHY THE UNIT IS A DIRECTORY ─────────────────────────────────────────────────────────────
//
// A Go package IS a directory, so a per-directory floor is the faithful analogue of the Go
// ratchet's per-package floor. Per FILE would red on every rename; per PROJECT would hide
// everything inside one number. Non-recursive, so `lib/authz` and `lib/authz/fga` are distinct
// keys — exactly as `cloud` and `cloud/aws` are distinct in the Go floors.

import path from "node:path";

/**
 * Thrown when the coverage artefact cannot be vouched for. Every caller treats this as
 * FAIL-OPEN: a ratchet must never compare against a map it does not trust.
 */
export class UnusableCoverageError extends Error {
	/** @param {string} message why the artefact cannot be trusted */
	constructor(message) {
		super(message);
		this.name = "UnusableCoverageError";
	}
}

/**
 * Count covered and total statements for one istanbul FileCoverage record.
 *
 * @param {string} relPath the file's path relative to the project root, for error messages
 * @param {unknown} fileCov one value from coverage-final.json
 * @returns {{covered: number, total: number}}
 */
function measureFile(relPath, fileCov) {
	if (typeof fileCov !== "object" || fileCov === null) {
		throw new UnusableCoverageError(`${relPath}: record is not an object`);
	}
	const record = /** @type {{statementMap?: unknown, s?: unknown}} */ (fileCov);
	const { statementMap, s } = record;
	if (typeof statementMap !== "object" || statementMap === null) {
		throw new UnusableCoverageError(`${relPath}: missing statementMap`);
	}
	if (typeof s !== "object" || s === null) {
		throw new UnusableCoverageError(`${relPath}: missing s (statement hit counts)`);
	}
	const total = Object.keys(statementMap).length;
	const hits = Object.values(s);
	// THE CORRUPTION TRIPWIRE. statementMap and s are two views of the same universe and are
	// written together; a length disagreement means the record is not internally consistent, and
	// nothing downstream should be trusted. coverage-summary.json cannot express this check —
	// that is reason 2 in the header, made concrete.
	if (hits.length !== total) {
		throw new UnusableCoverageError(
			`${relPath}: statementMap has ${total} entries but s has ${hits.length}`,
		);
	}
	let covered = 0;
	for (const hit of hits) {
		if (typeof hit !== "number" || !Number.isInteger(hit) || hit < 0) {
			throw new UnusableCoverageError(`${relPath}: non-integer statement hit count ${String(hit)}`);
		}
		if (hit > 0) covered += 1;
	}
	return { covered, total };
}

/**
 * Reduce a parsed coverage-final.json to per-directory covered/total statement pairs.
 *
 * @param {Record<string, unknown>} coverageFinal parsed coverage-final.json, keyed by ABSOLUTE path
 * @param {string} projectAbsDir absolute path of the project root the paths must lie under
 * @returns {Map<string, {covered: number, total: number}>} keyed by POSIX dir relative to the
 *          project root; a root-level file keys to "." (mirroring the Go floors' "." package).
 *          Insertion order is sorted, so callers get a stable diff for free.
 */
export function measure(coverageFinal, projectAbsDir) {
	if (typeof coverageFinal !== "object" || coverageFinal === null) {
		throw new UnusableCoverageError("coverage-final.json did not parse to an object");
	}
	/** @type {Map<string, {covered: number, total: number}>} */
	const byDir = new Map();
	for (const { rel, covered, total } of eachFile(coverageFinal, projectAbsDir)) {
		const dir = path.posix.dirname(rel) === "." ? "." : path.posix.dirname(rel);
		const acc = byDir.get(dir) ?? { covered: 0, total: 0 };
		acc.covered += covered;
		acc.total += total;
		byDir.set(dir, acc);
	}
	return new Map([...byDir.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/**
 * Every measured FILE, project-relative. The same walk `measure` aggregates — extracted so the two
 * cannot disagree about which files count or how a file is measured, which is the whole reason a
 * per-file view is trustworthy enough to act on.
 *
 * @param {object} coverageFinal
 * @param {string} projectAbsDir
 * @returns {Generator<{rel: string, covered: number, total: number}>}
 */
function* eachFile(coverageFinal, projectAbsDir) {
	for (const [absPath, fileCov] of Object.entries(coverageFinal)) {
		const rel = path.relative(projectAbsDir, absPath).split(path.sep).join("/");
		// `allowExternal` defaults to false, so a path outside the project root should be
		// impossible. If one appears, the artefact is not what we think it is.
		if (rel === "" || rel.startsWith("../") || path.isAbsolute(rel)) {
			throw new UnusableCoverageError(`${absPath} does not lie under ${projectAbsDir}`);
		}
		const { covered, total } = measureFile(rel, fileCov);
		yield { rel, covered, total };
	}
}

/**
 * Coverage per FILE rather than per directory.
 *
 * The floors — and therefore the ratchet, and therefore the merge queue — are per DIRECTORY, so a
 * directory that moves by one statement names a hundred files and no culprit. That is what made
 * #3342 un-diagnosable: `apps/console/lib/billing` measures 957 or 958 of 1753 depending on the
 * run, and nothing in the toolchain could say WHICH statement was flapping. Directory totals are
 * the gate; file rows are how you find out why it moved.
 *
 * @param {object} coverageFinal
 * @param {string} projectAbsDir
 * @returns {Map<string, {covered: number, total: number}>} keyed by project-relative file path
 */
export function measureByFile(coverageFinal, projectAbsDir) {
	if (typeof coverageFinal !== "object" || coverageFinal === null) {
		throw new UnusableCoverageError("coverage-final.json did not parse to an object");
	}
	/** @type {Map<string, {covered: number, total: number}>} */
	const byFile = new Map();
	for (const { rel, covered, total } of eachFile(coverageFinal, projectAbsDir)) byFile.set(rel, { covered, total });
	return new Map([...byFile.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/**
 * Has coverage fallen, comparing two integer pairs by CROSS-MULTIPLICATION?
 *
 * PASS  <=>  covered * floorTotal  >=  floorCovered * total
 *
 * No division, no float, no rounding ever enters the decision. This is not fastidiousness — it
 * is the single likeliest way this gate could wedge the repository. `packages/core/git` is
 * 185/291 = 63.5739%, which every tool DISPLAYS as "63.6%"; store the displayed value, compare
 * it against the measured one, and the gate fails with zero code change, on every PR, forever.
 *
 * BigInt because it costs one line and removes the overflow question entirely.
 *
 * @param {{covered: number, total: number}} now the measured pair
 * @param {{covered: number, total: number}} floor the recorded pair
 * @returns {boolean} true when `now` is strictly worse than `floor`
 */
export function regressed(now, floor) {
	return BigInt(now.covered) * BigInt(floor.total) < BigInt(floor.covered) * BigInt(now.total);
}

/**
 * Format an integer pair as a percentage, for MESSAGES ONLY. Never for a decision — see
 * `regressed`.
 *
 * @param {{covered: number, total: number}} pair
 * @returns {string} e.g. "63.6%", or "n/a" for an empty denominator
 */
export function formatPct(pair) {
	if (pair.total === 0) return "n/a";
	return `${((pair.covered / pair.total) * 100).toFixed(1)}%`;
}
