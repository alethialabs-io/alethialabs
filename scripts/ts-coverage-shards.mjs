#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
//
// The three steps around a SHARDED coverage run, as one CLI so ci.yml spells each of them once.
//
//   node scripts/ts-coverage-shards.mjs fingerprint --project apps/console --shard 2/4
//       In each shard job, after its tests: print what measured this shard (ts-coverage.mjs's own
//       `currentEnv`, plus the shard and project) as JSON. Uploaded next to the shard's
//       coverage-final.json.
//
//   node scripts/ts-coverage-shards.mjs merge --project apps/console --from shards --shards 4 [--out F]
//       In the ratchet job: validate that `shards/` holds exactly shards 1..4 of 4, each whole and
//       each measured in this job's environment; merge them by path (istanbul-lib-coverage, as
//       vitest's `--merge-reports` does); write `<project>/coverage/coverage-final.json` (or F) and
//       the provenance manifest beside it. ANY defect in the set exits 1 and writes nothing.
//       Refuses to overwrite an existing artefact: something else measuring the project in the same
//       job is a wiring error, and silently replacing it would hide which number the ratchet read.
//
//   node scripts/ts-coverage-shards.mjs compare --project apps/console --first A --second B
//       The equivalence proof (ci.yml `ts-shard-equivalence`): per-file covered/total for statements,
//       functions and branch arms, plus the per-directory numbers the ratchet gates on. Exits 1 on any
//       difference; differing raw hit SUMS are printed but do not fail (see compareCoverage).
//
//   node scripts/ts-coverage-shards.mjs --self-test
//       The istanbul merge semantics, end to end through this CLI. Needs the installed tree (it
//       imports istanbul-lib-coverage), so it runs in the ts-test job right before the real merge —
//       the hermetic refusal cases live in `ts-coverage.mjs --self-test`, which runs on every PR.
//
// See scripts/lib/ts-coverage-merge.mjs for why an incomplete set is an error rather than a
// smaller measurement, and ts-coverage.mjs's SHARDED INPUT header for how the ratchet consumes it.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { measure } from "./lib/ts-coverage-measure.mjs";
import {
	compareCoverage,
	MANIFEST,
	createMerger,
	listShards,
	loadShardCoverage,
	mergeCoverage,
	parseShardCount,
	parseShardSpec,
	renderManifest,
	ShardMergeError,
	verifyManifest,
} from "./lib/ts-coverage-merge.mjs";
import { coveragePath, currentEnv } from "./ts-coverage.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SELF = fileURLToPath(import.meta.url);

/** Print a single-line GitHub error annotation on stderr. @param {string} message */
function annotateError(message) {
	process.stderr.write(`::error::${message.replace(/\r?\n/g, " ").trim()}\n`);
}

/** Append markdown to the job summary when there is one; a summary that cannot be written changes nothing. */
function summary(md) {
	if (!process.env.GITHUB_STEP_SUMMARY) return;
	try {
		writeFileSync(process.env.GITHUB_STEP_SUMMARY, `${md}\n`, { flag: "a" });
	} catch {
		// not a reason to change the verdict
	}
}

/**
 * Resolve and check `--project`: it must be an existing directory under the repo root.
 *
 * @param {string|undefined} project
 * @returns {{project: string, projectAbsDir: string}}
 */
function resolveProject(project) {
	if (!project) throw new ShardMergeError("--project <path> is required (e.g. --project apps/console)");
	const projectAbsDir = path.join(ROOT, project);
	if (!existsSync(projectAbsDir)) throw new ShardMergeError(`no such project directory: ${project}`);
	return { project, projectAbsDir };
}

/** `fingerprint`: what measured this shard, as JSON on stdout. @param {Record<string, string>} o */
function runFingerprint(o) {
	const { project, projectAbsDir } = resolveProject(o.project);
	const { index, total } = parseShardSpec(o.shard);
	process.stdout.write(`${JSON.stringify({ shard: `${index}/${total}`, project, env: currentEnv(projectAbsDir) }, null, 2)}\n`);
}

/**
 * Sum per-directory pairs into one project-wide pair.
 *
 * @param {Map<string, {covered: number, total: number}>} dirs
 * @returns {{covered: number, total: number}}
 */
function sumDirs(dirs) {
	const t = { covered: 0, total: 0 };
	for (const v of dirs.values()) {
		t.covered += v.covered;
		t.total += v.total;
	}
	return t;
}

/** `merge`: validate the shard set, merge it, write artefact + manifest. @param {Record<string, string>} o */
async function runMerge(o) {
	const { project, projectAbsDir } = resolveProject(o.project);
	const shards = parseShardCount(o.shards);
	if (!o.from) throw new ShardMergeError("--from <dir of shard artefacts> is required");
	const out = o.out ? path.resolve(o.out) : coveragePath(projectAbsDir);
	const manifestPath = path.join(path.dirname(out), MANIFEST);
	for (const p of [out, manifestPath]) {
		if (existsSync(p)) {
			throw new ShardMergeError(`${path.relative(ROOT, p) || p} already exists — something else wrote ${project}'s coverage in this job; refusing to replace it with the merge`);
		}
	}

	// Every structural refusal first (cheap), then one shard at a time: parse, check, merge, drop.
	const listed = listShards({ dir: path.resolve(o.from), shards, env: currentEnv(projectAbsDir), project });
	const merger = await createMerger();
	const read = [];
	for (const shard of listed) {
		const { coverage, ...stats } = loadShardCoverage(shard, projectAbsDir);
		merger.add(coverage);
		read.push(stats);
	}
	const merged = merger.toJSON();
	const mergedDirs = measure(merged, projectAbsDir);
	const whole = sumDirs(mergedDirs);

	// A union merge can only ADD: every shard reports the full `coverage.include` universe, so the
	// merged statement total is at least any shard's, and a statement covered in a shard is covered in
	// the merge. A merge that shrinks either number is a merge bug, and the gate must not read it.
	for (const s of read) {
		if (whole.total < s.statements.total || whole.covered < s.statements.covered) {
			throw new ShardMergeError(
				`the merge (${whole.covered}/${whole.total}) is SMALLER than shard ${s.index}/${shards} alone (${s.statements.covered}/${s.statements.total}) — a union cannot shrink; refusing to write it`,
			);
		}
	}

	const mergedText = JSON.stringify(merged);
	mkdirSync(path.dirname(out), { recursive: true });
	writeFileSync(out, mergedText);
	writeFileSync(manifestPath, renderManifest({ project, shards, mergedText, perShard: read }));
	// Read back through the same check the ratchet will apply, so a write that did not land as
	// intended fails HERE, attributed to the merge.
	verifyManifest({ coverageText: readFileSync(out, "utf8"), manifestText: readFileSync(manifestPath, "utf8"), project, shards });

	const rows = read.map((s) => `| ${s.index}/${shards} | ${s.files} | ${s.statements.covered}/${s.statements.total} |`);
	const table = [
		`#### ${project}: merged coverage of ${shards} shards`,
		"",
		"| shard | files | statements covered/total |",
		"|---|---|---|",
		...rows,
		`| **merge** | ${Object.keys(merged).length} | **${whole.covered}/${whole.total}** |`,
		"",
	].join("\n");
	process.stdout.write(`${table}\n✓ wrote ${path.relative(ROOT, out)} and ${MANIFEST} (${mergedDirs.size} directories)\n`);
	summary(table);
}

/**
 * Load one coverage-final.json for `compare`, refusing an absent or empty one — comparing two empty
 * maps "finds no differences", which is the vacuous pass this command exists to rule out.
 *
 * @param {string|undefined} file
 * @param {string} flag
 * @returns {Record<string, unknown>}
 */
function loadForCompare(file, flag) {
	if (!file) throw new ShardMergeError(`${flag} <coverage-final.json> is required`);
	if (!existsSync(file)) throw new ShardMergeError(`${flag} ${file}: no such file`);
	let parsed;
	try {
		parsed = JSON.parse(readFileSync(file, "utf8"));
	} catch (err) {
		throw new ShardMergeError(`${flag} ${file}: not valid JSON: ${/** @type {Error} */ (err).message}`);
	}
	if (typeof parsed !== "object" || parsed === null || Object.keys(parsed).length === 0) {
		throw new ShardMergeError(`${flag} ${file}: holds no file records — nothing to compare`);
	}
	return parsed;
}

/** `compare`: the equivalence proof. Exits 1 on any covered/total difference. @param {Record<string, string>} o */
function runCompare(o) {
	const { project, projectAbsDir } = resolveProject(o.project);
	const a = loadForCompare(o.first, "--first");
	const b = loadForCompare(o.second, "--second");
	const { files, differences, hitDifferences } = compareCoverage(a, b);

	// The ratchet's own view, from its own walk: per-directory statement pairs.
	const da = measure(a, projectAbsDir);
	const db = measure(b, projectAbsDir);
	const dirDiffs = [];
	for (const d of [...new Set([...da.keys(), ...db.keys()])].sort()) {
		const x = da.get(d);
		const y = db.get(d);
		if (!x || !y || x.covered !== y.covered || x.total !== y.total) {
			dirDiffs.push(`${d}: ${x ? `${x.covered}/${x.total}` : "absent"} vs ${y ? `${y.covered}/${y.total}` : "absent"}`);
		}
	}
	const ta = sumDirs(da);
	const tb = sumDirs(db);

	const lines = [
		`#### ${project}: ${o.first} vs ${o.second}`,
		"",
		`- files compared: ${files}`,
		`- statements (the ratchet's metric): ${ta.covered}/${ta.total} vs ${tb.covered}/${tb.total}`,
		`- ratchet directories: ${da.size} vs ${db.size}, ${dirDiffs.length} differing`,
		`- files with a covered/total difference (statements, functions or branch arms): ${differences.length}`,
		`- files whose raw hit sums differ with identical covered sets (reported, not failed): ${hitDifferences.length}`,
		"",
	];
	if (dirDiffs.length > 0) lines.push("Differing ratchet directories:", "", ...dirDiffs.map((d) => `    ${d}`), "");
	if (differences.length > 0) lines.push("Differing files:", "", ...differences.map((d) => `    ${d}`), "");
	if (hitDifferences.length > 0) {
		lines.push("Hit-sum-only differences (first 50):", "", ...hitDifferences.slice(0, 50).map((d) => `    ${d}`), "");
	}
	const report = lines.join("\n");
	process.stdout.write(`${report}\n`);
	summary(report);
	if (differences.length > 0 || dirDiffs.length > 0) {
		annotateError(`${project}: the two coverage maps are NOT equivalent — ${differences.length} file(s), ${dirDiffs.length} ratchet director(ies) differ. See the step log for each one.`);
		process.exit(1);
	}
	process.stdout.write(`✓ ${project}: equivalent — every file's covered/total agrees for statements, functions and branch arms\n`);
}

let failures = 0;
/** Record one self-test assertion. */
function check(name, cond, detail) {
	if (cond) process.stdout.write(`  ✓ ${name}\n`);
	else {
		failures += 1;
		process.stdout.write(`  ✗ ${name}${detail ? ` — ${detail}` : ""}\n`);
	}
}

/**
 * One istanbul FileCoverage record: statements on lines 1..n, one function, one two-armed branch.
 *
 * @param {string} abs
 * @param {number[]} s statement hits
 * @param {number} f function hits
 * @param {[number, number]} b branch-arm hits
 */
function rec(abs, s, f = 0, b = [0, 0]) {
	const loc = (l) => ({ start: { line: l, column: 0 }, end: { line: l, column: 10 } });
	return {
		path: abs,
		statementMap: Object.fromEntries(s.map((_, i) => [String(i), loc(i + 1)])),
		s: Object.fromEntries(s.map((h, i) => [String(i), h])),
		fnMap: { 0: { name: "fn", decl: loc(1), loc: loc(1), line: 1 } },
		f: { 0: f },
		branchMap: { 0: { type: "if", line: 2, loc: loc(2), locations: [loc(2), loc(3)] } },
		b: { 0: b },
	};
}

/** Run this CLI as a subprocess. @returns {{status: number, out: string}} */
function cli(args) {
	try {
		return { status: 0, out: execFileSync(process.execPath, [SELF, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) };
	} catch (err) {
		const e = /** @type {{status?: number, stdout?: string, stderr?: string}} */ (err);
		return { status: e.status ?? -1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
	}
}

/** The merge semantics, through the real istanbul-lib-coverage and through this CLI. */
async function runSelfTest() {
	process.stdout.write("ts-coverage-shards --self-test\n\n istanbul merge semantics (what vitest --merge-reports does)\n");
	const P = path.join(ROOT, "apps/console");
	const A = `${P}/lib/a.ts`;
	const B = `${P}/lib/b.ts`;
	const s1 = { [A]: rec(A, [1, 0, 0], 1, [1, 0]), [B]: rec(B, [0, 0]) };
	const s2 = { [A]: rec(A, [0, 0, 2], 0, [0, 3]), [B]: rec(B, [0, 0]) };
	const before = JSON.stringify(s1);
	const m = await mergeCoverage([s1, s2]);
	check("hit counts ADD per statement", JSON.stringify(Object.values(m[A].s)) === "[1,0,2]", JSON.stringify(m[A].s));
	check("...per function", m[A].f[0] === 1);
	check("...and per branch arm", JSON.stringify(m[A].b[0]) === "[1,3]", JSON.stringify(m[A].b[0]));
	check("a statement map shared by both shards is not duplicated", Object.keys(m[A].statementMap).length === 3);
	check("a file no shard executed stays in the universe at zero", m[B] !== undefined && Object.values(m[B].s).every((h) => h === 0));
	check("the inputs are not mutated by the merge", JSON.stringify(s1) === before);
	const C = `${P}/scripts/lib/c.ts`;
	const m2 = await mergeCoverage([s1, { ...s2, [C]: rec(C, [1]) }]);
	check("a file only one shard loaded (outside the include root) is kept", m2[C] !== undefined && m2[C].s[0] === 1);
	const one = await mergeCoverage([s1]);
	check("merging one complete map is the identity on covered/total", compareCoverage(one, s1).differences.length === 0);
	const unsharded = { [A]: rec(A, [1, 0, 2], 1, [1, 3]), [B]: rec(B, [0, 0]) };
	check("the merge of the shards compares EQUAL to the run that executed both halves", compareCoverage(m, unsharded).differences.length === 0, JSON.stringify(compareCoverage(m, unsharded)));

	process.stdout.write("\n the CLI end to end — fingerprint, merge, refuse\n");
	const tmp = mkdtempSync(path.join(tmpdir(), "tscov-shards-cli-"));
	try {
		const lay = (dir, shards) => {
			shards.forEach((cov, i) => {
				const d = path.join(dir, `console-coverage-shard-${i + 1}-of-${shards.length}`);
				mkdirSync(d, { recursive: true });
				writeFileSync(path.join(d, "coverage-final.json"), JSON.stringify(cov));
				const fp = cli(["fingerprint", "--project", "apps/console", "--shard", `${i + 1}/${shards.length}`]);
				writeFileSync(path.join(d, "fingerprint.json"), fp.out);
			});
		};
		const fp = cli(["fingerprint", "--project", "apps/console", "--shard", "1/2"]);
		const parsed = (() => { try { return JSON.parse(fp.out); } catch { return null; } })();
		check("fingerprint prints the shard, the project and ts-coverage's environment", fp.status === 0 && parsed?.shard === "1/2" && parsed?.project === "apps/console" && typeof parsed?.env?.ee_dist === "boolean", fp.out);
		check("fingerprint refuses a shard spec that is not i/N", cli(["fingerprint", "--project", "apps/console", "--shard", "3"]).status === 1);

		lay(path.join(tmp, "ok"), [s1, s2]);
		const out = path.join(tmp, "merged", "coverage-final.json");
		const run = cli(["merge", "--project", "apps/console", "--from", path.join(tmp, "ok"), "--shards", "2", "--out", out]);
		check("a complete set merges and exits 0", run.status === 0, run.out);
		const written = existsSync(out) ? JSON.parse(readFileSync(out, "utf8")) : {};
		check("...the written artefact is the istanbul merge", compareCoverage(written, m).differences.length === 0);
		check("...and its manifest verifies against it", (() => {
			try {
				verifyManifest({ coverageText: readFileSync(out, "utf8"), manifestText: readFileSync(path.join(tmp, "merged", MANIFEST), "utf8"), project: "apps/console", shards: 2 });
				return true;
			} catch {
				return false;
			}
		})());
		const again = cli(["merge", "--project", "apps/console", "--from", path.join(tmp, "ok"), "--shards", "2", "--out", out]);
		check("an existing artefact is never overwritten", again.status === 1 && again.out.includes("already exists"), again.out);

		lay(path.join(tmp, "short"), [s1, s2]);
		const out3 = path.join(tmp, "m3", "coverage-final.json");
		const short = cli(["merge", "--project", "apps/console", "--from", path.join(tmp, "short"), "--shards", "3", "--out", out3]);
		check("2 shards where 3 are expected: exit 1, and NOTHING is written", short.status === 1 && !existsSync(out3), short.out);
		rmSync(path.join(tmp, "short", "console-coverage-shard-2-of-2"), { recursive: true });
		const out4 = path.join(tmp, "m4", "coverage-final.json");
		const lost = cli(["merge", "--project", "apps/console", "--from", path.join(tmp, "short"), "--shards", "2", "--out", out4]);
		check("a lost shard: exit 1, named, and NOTHING is written", lost.status === 1 && lost.out.includes("missing shard(s) 2/2") && !existsSync(out4), lost.out);

		const cmp = cli(["compare", "--project", "apps/console", "--first", out, "--second", out]);
		check("compare: a map against itself is equivalent", cmp.status === 0, cmp.out);
		const other = path.join(tmp, "other.json");
		writeFileSync(other, JSON.stringify({ [A]: rec(A, [1, 0, 0], 1, [1, 3]), [B]: rec(B, [0, 0]) }));
		const bad = cli(["compare", "--project", "apps/console", "--first", out, "--second", other]);
		check("compare: one statement lost is NOT equivalent (exit 1)", bad.status === 1 && bad.out.includes("lib/a.ts"), bad.out);
		writeFileSync(other, "{}");
		check("compare: an empty map is refused rather than found equal", cli(["compare", "--project", "apps/console", "--first", out, "--second", other]).status === 1);
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}

	process.stdout.write(`\n${failures === 0 ? "✓ all self-test assertions passed" : `✗ ${failures} self-test assertion(s) FAILED`}\n`);
	process.exit(failures === 0 ? 0 : 1);
}

/** Parse `--key value` / `--key=value` pairs after the subcommand. @returns {Record<string, string>} */
function parseOpts(argv, allowed) {
	/** @type {Record<string, string>} */
	const o = {};
	for (let i = 0; i < argv.length; i += 1) {
		const m = /^--([a-z-]+)(?:=(.*))?$/.exec(argv[i]);
		if (!m || !allowed.includes(m[1])) throw new ShardMergeError(`unknown argument ${argv[i]} (accepted: ${allowed.map((a) => `--${a}`).join(" ")})`);
		if (m[2] !== undefined) o[m[1]] = m[2];
		else {
			o[m[1]] = argv[i + 1] ?? "";
			i += 1;
		}
	}
	return o;
}

/** Dispatch the subcommand. Every ShardMergeError is a red step with the reason as an annotation. */
async function main() {
	const [cmd, ...rest] = process.argv.slice(2);
	try {
		if (cmd === "--self-test") await runSelfTest();
		else if (cmd === "fingerprint") runFingerprint(parseOpts(rest, ["project", "shard"]));
		else if (cmd === "merge") await runMerge(parseOpts(rest, ["project", "from", "shards", "out"]));
		else if (cmd === "compare") runCompare(parseOpts(rest, ["project", "first", "second"]));
		else {
			process.stderr.write("usage: ts-coverage-shards.mjs fingerprint|merge|compare|--self-test (see the header)\n");
			process.exit(2);
		}
	} catch (err) {
		if (!(err instanceof ShardMergeError)) throw err;
		annotateError(`ts-coverage-shards ${cmd}: ${err.message}`);
		process.exit(1);
	}
}

// Realpath-compared, as ts-coverage.mjs does and for the same measured reason (#3262).
if (process.argv[1] && import.meta.filename === realpathSync(process.argv[1])) await main();
