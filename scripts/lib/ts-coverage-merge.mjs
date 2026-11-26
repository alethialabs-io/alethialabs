// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
//
// MERGING SHARDED coverage-final.json ARTEFACTS — and refusing to, loudly, when the set is not whole.
//
// ci.yml runs the console's unit suite as N shards (`vitest run --coverage --shard=i/N`), each on its
// own runner. Each shard writes a coverage-final.json that is PARTIAL by construction: it carries the
// hit counts of the test files that shard ran, plus every other `coverage.include` file at zero. The
// ratchet (scripts/ts-coverage.mjs) must only ever see the whole — so this module turns N partials
// into one artefact, and the ONE property it exists for is:
//
//     an incomplete set of shards is an ERROR, never a smaller measurement.
//
// That is the opposite of the ratchet's own fail-open rule, deliberately. The ratchet fails open
// because its inputs vary with code a PR legitimately changes. Nothing a PR changes can make a shard
// go missing: a missing, duplicated, mislabelled or foreign shard means the PIPELINE is broken, and
// measuring the rest would either demote the gate (F8: a vanished directory) or — worse — compare a
// partial numerator against a full denominator and report a fake regression that names nobody's code.
// So every check here throws ShardMergeError, and every caller turns that into a red step.
//
// ── THE MERGE SEMANTICS ARE VITEST'S OWN ─────────────────────────────────────────────────────────────
//
// Vitest's documented answer to sharded coverage is `--reporter=blob` + `vitest --merge-reports`, and
// for the v8 provider that ends in `BaseCoverageProvider.mergeReports`, which is literally:
//
//     const coverageMap = this.createCoverageMap();
//     for (const coverage of coverageMaps) coverageMap.merge(coverage);
//
// — istanbul-lib-coverage's CoverageMap.merge over each shard's map (untested files included, since
// a sharded run is still `allTestsRun: true`). This module does exactly that, over the
// coverage-final.json each shard already writes, with the same library pinned at the version vitest
// resolves (istanbul-lib-coverage@3.2.2, a root devDependency for this reason). Per file, istanbul
// keys statements/functions/branches by SOURCE LOCATION and ADDS hit counts; a location only one side
// knows is kept. So a statement is covered in the merge iff some shard executed it — which is the
// definition the unsharded run applies across its own test files.
//
// Whether that equality holds on the real suite is an empirical question, and ci.yml's
// `ts-shard-equivalence` dispatch answers it: it runs the suite unsharded on the same commit and
// `compareCoverage` below fails on any per-file covered/total difference.
//
// istanbul-lib-coverage is imported LAZILY, inside `mergeCoverage` only. Everything else here — the
// shard-set validation, the manifest, the comparison — is dependency-free, so ts-coverage.mjs's
// hermetic --self-test (the `guards` job, no installed tree) can drive every refusal path on every PR.

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { measure, UnusableCoverageError } from "./ts-coverage-measure.mjs";

/** Thrown for every reason a set of shard artefacts cannot be merged into a whole. Never fail-open. */
export class ShardMergeError extends Error {
	/** @param {string} message what is wrong with the shard set, specifically */
	constructor(message) {
		super(message);
		this.name = "ShardMergeError";
	}
}

/** A shard directory: `<anything>-shard-<i>-of-<N>` (the artifact name), or bare `shard-<i>-of-<N>`. */
export const SHARD_DIR = /^(?:.+-)?shard-(\d+)-of-(\d+)$/;

/** The provenance record written next to a merged coverage-final.json. */
export const MANIFEST = "shard-merge.json";

/** The two files every shard directory must carry, and nothing else is read. */
export const SHARD_COVERAGE = "coverage-final.json";
export const SHARD_FINGERPRINT = "fingerprint.json";

/**
 * Parse a shard count given on a command line. Refuses anything below 2: one shard is not sharding,
 * and `0` would make every loop below vacuous — a merge of nothing that "found no problems".
 *
 * @param {unknown} raw
 * @returns {number}
 */
export function parseShardCount(raw) {
	const s = String(raw ?? "");
	if (!/^\d+$/.test(s) || Number(s) < 2) {
		throw new ShardMergeError(`shard count must be an integer >= 2, got ${JSON.stringify(raw)}`);
	}
	return Number(s);
}

/**
 * Parse `i/N` as vitest's `--shard` spells it.
 *
 * @param {unknown} raw
 * @returns {{index: number, total: number}}
 */
export function parseShardSpec(raw) {
	const m = /^(\d+)\/(\d+)$/.exec(String(raw ?? ""));
	if (!m) throw new ShardMergeError(`shard must be spelled i/N (as vitest's --shard), got ${JSON.stringify(raw)}`);
	const index = Number(m[1]);
	const total = parseShardCount(m[2]);
	if (index < 1 || index > total) throw new ShardMergeError(`shard index ${index} is outside 1..${total}`);
	return { index, total };
}

/**
 * The environment axes of two fingerprints that disagree, compared EXACTLY over the union of keys.
 *
 * Stricter than the ratchet's F7 comparison (which ignores a provider patch and an absent key) on
 * purpose: F7 asks "is this measurement comparable to floors recorded months ago", this asks "were
 * these N partial measurements taken by the same instrument in the same run". The second has no
 * legitimate drift at all.
 *
 * @param {Record<string, unknown>} a
 * @param {Record<string, unknown>} b
 * @returns {string[]} `key: a vs b` for every disagreeing axis
 */
export function envDifferences(a, b) {
	const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
	return keys.filter((k) => String(a[k]) !== String(b[k])).map((k) => `${k}: ${String(a[k])} vs ${String(b[k])}`);
}

/**
 * Validate a directory of shard artefacts WITHOUT loading their coverage: exactly shards 1..N of N,
 * each with both files, each fingerprinted as its own slot, this project, and this environment.
 * Cheap, so every structural refusal happens before the first (large) coverage file is parsed.
 *
 * N comes from the CALLER, never from what arrived: inferring it from the directory listing is how a
 * lost shard becomes a smaller N and a clean-looking merge.
 *
 * @param {{dir: string, shards: number, env: Record<string, unknown>, project: string}} opts
 *   `env` is the merging job's own fingerprint; every shard must match it exactly, so the environment
 *   the ratchet reads afterwards (in the merging job) is a true description of where the numbers came from.
 * @returns {{index: number, total: number, dir: string}[]} in shard order
 */
export function listShards({ dir, shards, env, project }) {
	const total = parseShardCount(shards);
	if (!existsSync(dir) || !statSync(dir).isDirectory()) {
		throw new ShardMergeError(`${dir}: no shard directory — none of the ${total} shard artefacts arrived`);
	}
	/** @type {Map<number, string>} */
	const byIndex = new Map();
	const strays = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const m = entry.isDirectory() ? SHARD_DIR.exec(entry.name) : null;
		if (!m) {
			strays.push(entry.name);
			continue;
		}
		const [index, of] = [Number(m[1]), Number(m[2])];
		if (of !== total) throw new ShardMergeError(`${entry.name}: a shard of ${of}, but this merge expects ${total} — a matrix and its merge disagree about N`);
		if (index < 1 || index > total) throw new ShardMergeError(`${entry.name}: shard index ${index} is outside 1..${total}`);
		if (byIndex.has(index)) throw new ShardMergeError(`${entry.name}: shard ${index}/${total} arrived twice (also ${byIndex.get(index)})`);
		byIndex.set(index, entry.name);
	}
	if (strays.length > 0) {
		throw new ShardMergeError(`${dir}: unexpected entr(ies) ${strays.join(", ")} — only shard-<i>-of-${total} directories belong here`);
	}
	const missing = [];
	for (let i = 1; i <= total; i += 1) if (!byIndex.has(i)) missing.push(`${i}/${total}`);
	if (missing.length > 0) {
		throw new ShardMergeError(`missing shard(s) ${missing.join(", ")} — ${byIndex.size} of ${total} arrived; refusing to measure a partial suite as a whole`);
	}

	const out = [];
	for (let i = 1; i <= total; i += 1) {
		const sdir = path.join(dir, /** @type {string} */ (byIndex.get(i)));
		const label = `shard ${i}/${total}`;
		const covFile = path.join(sdir, SHARD_COVERAGE);
		const fpFile = path.join(sdir, SHARD_FINGERPRINT);
		if (!existsSync(covFile)) throw new ShardMergeError(`${label}: no ${SHARD_COVERAGE} — the shard ran no coverage, or its upload lost it`);
		if (!existsSync(fpFile)) throw new ShardMergeError(`${label}: no ${SHARD_FINGERPRINT} — cannot tell what measured it`);

		let fingerprint;
		try {
			fingerprint = JSON.parse(readFileSync(fpFile, "utf8"));
		} catch (err) {
			throw new ShardMergeError(`${label}: ${SHARD_FINGERPRINT} is not valid JSON: ${/** @type {Error} */ (err).message}`);
		}
		if (fingerprint?.shard !== `${i}/${total}`) {
			throw new ShardMergeError(`${label}: its fingerprint says it is shard ${JSON.stringify(fingerprint?.shard)} — an artefact in the wrong slot`);
		}
		if (fingerprint?.project !== project) {
			throw new ShardMergeError(`${label}: its fingerprint names project ${JSON.stringify(fingerprint?.project)}, not ${project}`);
		}
		if (typeof fingerprint.env !== "object" || fingerprint.env === null) {
			throw new ShardMergeError(`${label}: its fingerprint records no environment`);
		}
		const drift = envDifferences(fingerprint.env, env);
		if (drift.length > 0) {
			throw new ShardMergeError(
				`${label} was measured in a different environment from this merge (${drift.join("; ")} — shard vs here). ` +
					"The ratchet reads THIS job's environment as the measurement's, so it would be describing numbers it did not take.",
			);
		}
		out.push({ index: i, total, dir: sdir });
	}
	return out;
}

/**
 * Load one listed shard's coverage-final.json and put it through the ratchet's own structural
 * tripwire (statementMap/s agreement, integer hits, every path under the project root) — per shard,
 * BEFORE merging, so a corrupt shard is named as itself rather than surfacing later as an
 * unattributable F6 on the merge.
 *
 * @param {{index: number, total: number, dir: string}} shard one entry from listShards
 * @param {string} projectAbsDir
 * @returns {{index: number, coverage: Record<string, unknown>, files: number, statements: {covered: number, total: number}}}
 */
export function loadShardCoverage(shard, projectAbsDir) {
	const label = `shard ${shard.index}/${shard.total}`;
	let coverage;
	try {
		coverage = JSON.parse(readFileSync(path.join(shard.dir, SHARD_COVERAGE), "utf8"));
	} catch (err) {
		throw new ShardMergeError(`${label}: ${SHARD_COVERAGE} is not valid JSON (truncated upload?): ${/** @type {Error} */ (err).message}`);
	}
	if (typeof coverage !== "object" || coverage === null || Array.isArray(coverage) || Object.keys(coverage).length === 0) {
		throw new ShardMergeError(`${label}: ${SHARD_COVERAGE} holds no file records`);
	}
	let dirs;
	try {
		dirs = measure(coverage, projectAbsDir);
	} catch (err) {
		if (err instanceof UnusableCoverageError) throw new ShardMergeError(`${label}: ${err.message}`);
		throw err;
	}
	const statements = { covered: 0, total: 0 };
	for (const v of dirs.values()) {
		statements.covered += v.covered;
		statements.total += v.total;
	}
	return { index: shard.index, coverage, files: Object.keys(coverage).length, statements };
}

/**
 * listShards + loadShardCoverage for every shard, all held in memory at once. For small inputs (the
 * self-tests); the real merge streams shard by shard instead (see createMerger).
 *
 * @param {{dir: string, shards: number, projectAbsDir: string, env: Record<string, unknown>, project: string}} opts
 */
export function readShards({ dir, shards, projectAbsDir, env, project }) {
	return listShards({ dir, shards, env, project }).map((s) => loadShardCoverage(s, projectAbsDir));
}

/**
 * An accumulating merge, exactly as vitest's own `--merge-reports` does it: istanbul-lib-coverage
 * CoverageMap.merge, one shard at a time, in shard order.
 *
 * `add` TAKES OWNERSHIP of the map it is given: istanbul merges INTO the first record it saw for a
 * path, so a caller that reuses an added object sees it rewritten. That is the point — the real
 * console artefacts are tens of megabytes each, and streaming them through one map (parse, add,
 * drop) keeps one shard plus the merge in memory instead of all N plus N clones.
 *
 * @returns {Promise<{add: (coverage: Record<string, unknown>) => void, toJSON: () => Record<string, unknown>}>}
 */
export async function createMerger() {
	const mod = await import("istanbul-lib-coverage");
	const lib = mod.default ?? mod;
	const map = lib.createCoverageMap({});
	return {
		add: (coverage) => map.merge(coverage),
		toJSON: () => /** @type {Record<string, unknown>} */ (map.toJSON()),
	};
}

/**
 * Merge whole maps without touching them (each is cloned before createMerger takes ownership).
 *
 * @param {Record<string, unknown>[]} coverages
 * @returns {Promise<Record<string, unknown>>}
 */
export async function mergeCoverage(coverages) {
	const merger = await createMerger();
	for (const c of coverages) merger.add(structuredClone(c));
	return merger.toJSON();
}

/** @param {string} text @returns {string} lowercase hex sha256 */
export function sha256(text) {
	return createHash("sha256").update(text).digest("hex");
}

/**
 * The provenance record for a merged artefact: which project, how many shards, and the hash of the
 * exact bytes written, so the ratchet can prove it is measuring THIS merge and not a file something
 * else put at the same path.
 *
 * @param {{project: string, shards: number, mergedText: string, perShard: {index: number, files: number, statements: {covered: number, total: number}}[]}} opts
 * @returns {string} the manifest JSON, newline-terminated
 */
export function renderManifest({ project, shards, mergedText, perShard }) {
	return `${JSON.stringify(
		{
			project,
			shards,
			sha256: sha256(mergedText),
			perShard: perShard.map((s) => ({ shard: `${s.index}/${shards}`, files: s.files, statements: s.statements })),
		},
		null,
		2,
	)}\n`;
}

/**
 * Prove a coverage-final.json is the complete merge of `shards` shards for `project`. Throws
 * ShardMergeError when it is not — including when there is no manifest at all, which is what an
 * artefact that never went through the merge (one shard's partial file copied into place, an
 * unsharded run in a job that is supposed to measure shards) looks like.
 *
 * @param {{coverageText: string, manifestText: string|null, project: string, shards: number}} opts
 * @returns {{perShard: {shard: string, files: number}[]}}
 */
export function verifyManifest({ coverageText, manifestText, project, shards }) {
	const total = parseShardCount(shards);
	if (manifestText === null) {
		throw new ShardMergeError(`${project}: no ${MANIFEST} beside coverage-final.json — this artefact did not come from merging ${total} shards, so it may be one shard's partial`);
	}
	let m;
	try {
		m = JSON.parse(manifestText);
	} catch (err) {
		throw new ShardMergeError(`${project}: ${MANIFEST} is not valid JSON: ${/** @type {Error} */ (err).message}`);
	}
	if (m?.project !== project) throw new ShardMergeError(`${project}: ${MANIFEST} is for ${JSON.stringify(m?.project)}`);
	if (m?.shards !== total) throw new ShardMergeError(`${project}: ${MANIFEST} records a merge of ${JSON.stringify(m?.shards)} shards, this step expects ${total}`);
	if (!Array.isArray(m?.perShard) || m.perShard.length !== total) {
		throw new ShardMergeError(`${project}: ${MANIFEST} lists ${Array.isArray(m?.perShard) ? m.perShard.length : "no"} shard(s), expected ${total}`);
	}
	if (m?.sha256 !== sha256(coverageText)) {
		throw new ShardMergeError(`${project}: coverage-final.json is not the file the merge wrote (sha256 differs from ${MANIFEST}) — something replaced or truncated it`);
	}
	return { perShard: m.perShard };
}

/**
 * covered/total for one istanbul file record, over statements, functions and branch ARMS — plus the
 * raw hit sums, which no gate reads and which are reported, not compared (see compareCoverage).
 *
 * @param {any} rec
 * @returns {{s: [number, number], f: [number, number], b: [number, number], hits: {s: number, f: number, b: number}}}
 */
function fileTotals(rec) {
	const s = Object.values(rec?.s ?? {});
	const f = Object.values(rec?.f ?? {});
	const arms = Object.values(rec?.b ?? {}).flat();
	const sum = (xs) => xs.reduce((a, x) => a + (typeof x === "number" ? x : 0), 0);
	const cov = (xs) => xs.filter((x) => typeof x === "number" && x > 0).length;
	return {
		s: [cov(s), s.length],
		f: [cov(f), f.length],
		b: [cov(arms), arms.length],
		hits: { s: sum(s), f: sum(f), b: sum(arms) },
	};
}

/**
 * Compare two coverage-final.json maps file by file — the unsharded run and the merge of the shards.
 *
 * `differences` (the FAILING set): a file present on one side only, or any file whose covered/total
 * differs for statements, functions or branch arms. Statements are what the ratchet reads; functions
 * and branches are compared too so "equivalent" means equivalent, not "equal in the one column we gate".
 *
 * `hitDifferences` (REPORTED, not failing): files whose raw hit SUMS differ while every covered/total
 * agrees. The unsharded run merges RAW v8 counts across test files before converting; the shards each
 * convert, then istanbul adds per location. Nothing reads a count beyond "> 0", so a count that
 * differs with identical covered sets changes no number any gate or badge computes — but it is
 * printed, so the claim "nothing else moved" can be checked rather than believed.
 *
 * @param {Record<string, unknown>} a
 * @param {Record<string, unknown>} b
 * @returns {{files: number, differences: string[], hitDifferences: string[]}}
 */
export function compareCoverage(a, b) {
	const differences = [];
	const hitDifferences = [];
	const paths = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
	for (const p of paths) {
		if (!(p in a)) {
			differences.push(`${p}: only in the second map`);
			continue;
		}
		if (!(p in b)) {
			differences.push(`${p}: only in the first map`);
			continue;
		}
		const x = fileTotals(a[p]);
		const y = fileTotals(b[p]);
		const moved = ["s", "f", "b"].filter((k) => x[k][0] !== y[k][0] || x[k][1] !== y[k][1]);
		if (moved.length > 0) {
			differences.push(`${p}: ${moved.map((k) => `${k} ${x[k][0]}/${x[k][1]} vs ${y[k][0]}/${y[k][1]}`).join(", ")}`);
		} else if (x.hits.s !== y.hits.s || x.hits.f !== y.hits.f || x.hits.b !== y.hits.b) {
			hitDifferences.push(`${p}: hit sums s ${x.hits.s} vs ${y.hits.s}, f ${x.hits.f} vs ${y.hits.f}, b ${x.hits.b} vs ${y.hits.b}`);
		}
	}
	return { files: paths.length, differences, hitDifferences };
}
