// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Floors-fingerprint reproducibility guard.
//
// A coverage-floors.json records the environment it was measured in, and ts-coverage.mjs DEMOTES
// every regression to a warning (exit 0) when the measuring environment differs from the recorded
// one. That demote is a deliberate safety valve: a number measured elsewhere is not evidence about
// the code. But it has a failure mode nothing checks — if a recorded axis is one the ENFORCING JOB
// can never reproduce, the gate is disarmed by construction. It would pass forever, quietly,
// looking exactly like a gate that is holding.
//
// The tool already defends the other direction: a key absent from an older floors file is treated
// as "unknown" and never demotes, so a stale file cannot disarm the gate. What is unguarded is a
// CURRENT file recording a value the enforcing job structurally cannot match.
//
// This guard answers that mechanically, because prose could not: on 2026-08-26 the rationale
// written on the `ee_dist` key asserted the exact reverse of the truth, and TWO sessions
// independently "verified" it and both concluded backwards — an inverted comment survives
// checking, because the reader who checks finds the workflow apparently agreeing.
//
// WHAT IT CHECKS, per project that has a committed floors file and a ratchet step in ci.yml:
//   os       — the enforcing job's `runs-on` must belong to the recorded OS family.
//   node     — the enforcing job's setup-node version must match the recorded MAJOR.
//   ee_dist  — a ROOT-level check, so it is a question about the JOB, not the project: `true`
//              requires the job to produce ee/dist at all — an explicit `Build @alethia/ee` step,
//              or an unfiltered `turbo run test` that reaches it from ANY workspace dependent.
//
// WHAT IT DOES NOT CHECK, said plainly so a pass is not read as more than it is:
//   coverage_provider — an installed package version, not knowable from the workflow text.
//   edition           — read from the ambient ALETHIA_EDITION at measure time.
// Those two are reported as UNVERIFIED rather than silently counted as checked.
//
// Projects with a ratchet step but NO floors file are reported as UNARMED. That is not a failure:
// arming a project changes what CI blocks on and is a maintainer decision. But it is named, so the
// row cannot read as covered.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const CI = ".github/workflows/ci.yml";
const RATCHET = /ts-coverage\.mjs\s+--project\s+(\S+)/g;

function die(msg, hint) {
	console.error(`check-floors-reproducible: ${msg}`);
	if (hint) console.error(hint);
	process.exit(1);
}

function readOrDie(f, what) {
	if (!existsSync(f)) die(`cannot read ${f} — ${what}`, "The guard cannot see what it exists to check.");
	return readFileSync(f, "utf8");
}

const ci = readOrDie(CI, "no workflow to resolve the enforcing job from");

/**
 * Split ci.yml into jobs by indentation, without a YAML parser (this guard must run in a
 * de-hydrated worktree, so it takes no dependencies — same constraint as check-authz-scope.mjs).
 *
 * @returns {Map<string, {name: string, body: string}>}
 */
function parseJobs(src) {
	const lines = src.split("\n");
	const jobs = new Map();
	let inJobs = false;
	let cur = null;
	let buf = [];
	const flush = () => {
		if (cur) jobs.set(cur, { name: cur, body: buf.join("\n") });
		cur = null;
		buf = [];
	};
	for (const l of lines) {
		if (/^jobs:\s*$/.test(l)) {
			inJobs = true;
			continue;
		}
		if (!inJobs) continue;
		if (/^\S/.test(l)) {
			flush();
			inJobs = false;
			continue;
		}
		const m = l.match(/^ {2}([A-Za-z0-9_-]+):\s*$/);
		if (m) {
			flush();
			cur = m[1];
			continue;
		}
		if (cur) buf.push(l);
	}
	flush();
	return jobs;
}

const jobs = parseJobs(ci);
if (jobs.size === 0) die(`parsed 0 jobs from ${CI}`, "That is a parser failure, not a clean workflow.");

/** project -> the job whose body invokes its ratchet. */
const enforcedBy = new Map();
for (const job of jobs.values()) {
	for (const m of job.body.matchAll(RATCHET)) {
		const proj = m[1];
		if (proj.startsWith('"') || proj.startsWith("$")) continue; // a loop variable, not a literal
		if (!enforcedBy.has(proj)) enforcedBy.set(proj, job);
	}
}
if (enforcedBy.size === 0) {
	die(
		`found no \`ts-coverage.mjs --project <name>\` step in ${CI}`,
		"Either the ratchet was removed or this guard's pattern rotted. Both need a human.",
	);
}

// --- does the enforcing job produce ee/dist? -------------------------------------------------
const turboCfg = existsSync("turbo.json") ? JSON.parse(readFileSync("turbo.json", "utf8")) : null;
const turboTasks = turboCfg ? turboCfg.tasks || turboCfg.pipeline || {} : {};
const testDependsOnBuild = ((turboTasks.test || {}).dependsOn || []).includes("^build");

/** Workspace package directories, from pnpm-workspace.yaml's globs (one level deep, as used here). */
function workspaceDirs() {
	const out = [];
	const ws = existsSync("pnpm-workspace.yaml") ? readFileSync("pnpm-workspace.yaml", "utf8") : "";
	const roots = new Set();
	for (const m of ws.matchAll(/^\s*-\s*["']?([^"'\n]+?)["']?\s*$/gm)) {
		const g = m[1].trim();
		if (g.startsWith("!") || !g) continue;
		roots.add(g.replace(/\/\*+$/, ""));
	}
	if (roots.size === 0) ["apps", "packages"].forEach((r) => roots.add(r));
	for (const r of roots) {
		if (existsSync(path.join(r, "package.json"))) out.push(r); // a bare package like `ee`
		if (!existsSync(r)) continue;
		try {
			for (const e of readdirSync(r, { withFileTypes: true })) {
				if (e.isDirectory()) out.push(path.join(r, e.name));
			}
		} catch {
			// not a directory — the bare-package case above already covered it
		}
	}
	return out;
}

// `ee_dist` is a ROOT-level existence check, not a per-project one — ts-coverage.mjs asks
// `existsSync(ROOT/ee/dist/index.js)`. So the question is about the JOB, not the project: once any
// task in the job builds the dist, every project measured in that same job sees it. Scoping this
// per-project was my first version's bug, and it produced a confident false positive on
// packages/ui — which depends on nothing enterprise, yet is correctly measured with the dist
// present because apps/console's test task built it earlier in the same `turbo run test`.

/** Every workspace package that reaches @alethia/ee through a stanza turbo would traverse. */
function eeDependents() {
	const out = [];
	for (const dir of workspaceDirs()) {
		const pkg = path.join(dir, "package.json");
		if (!existsSync(pkg)) continue;
		let d;
		try {
			d = JSON.parse(readFileSync(pkg, "utf8"));
		} catch {
			continue;
		}
		if (["dependencies", "optionalDependencies", "devDependencies"].some((k) => (d[k] || {})["@alethia/ee"] !== undefined)) {
			out.push(d.name || dir);
		}
	}
	return out;
}

const EE_DEPENDENTS = eeDependents();

function jobBuildsEeDist(job) {
	if (/Build @alethia\/ee|-F\s+@alethia\/ee\s+build/.test(job.body)) {
		return { yes: true, how: "an explicit build step" };
	}
	// `turbo run test` with no --filter fans out across the whole workspace, so any ee dependent's
	// test task drags @alethia/ee#build in via `test.dependsOn: ["^build"]`.
	const m = job.body.match(/turbo run [^\n]*\btest\b[^\n]*/);
	if (m && testDependsOnBuild && EE_DEPENDENTS.length > 0) {
		const filtered = /--filter/.test(m[0]);
		if (!filtered) {
			return {
				yes: true,
				how: `unfiltered \`turbo run test\` + \`test.dependsOn: ["^build"]\` reaches @alethia/ee via ${EE_DEPENDENTS.join(", ")}`,
			};
		}
		if (EE_DEPENDENTS.some((n) => m[0].includes(`--filter=${n}`))) {
			return { yes: true, how: `\`turbo run test\` filtered to an ee dependent (${EE_DEPENDENTS.join(", ")})` };
		}
	}
	return { yes: false, how: "no explicit build step, and no turbo path to @alethia/ee in this job" };
}

const OS_FAMILY = { ubuntu: "Linux", macos: "Darwin", windows: "Windows" };

const problems = [];
const unarmed = [];
const unverified = [];
let checked = 0;

for (const [project, job] of enforcedBy) {
	const fp = path.join(project, "coverage-floors.json");
	if (!existsSync(fp)) {
		unarmed.push(`${project} (enforced in job \`${job.name}\`, but no coverage-floors.json)`);
		continue;
	}
	const floors = JSON.parse(readFileSync(fp, "utf8"));
	const env = floors.env || floors.environment || floors.fingerprint || {};
	if (Object.keys(env).length === 0) {
		problems.push(`${project}: floors file records no environment fingerprint at all`);
		continue;
	}
	checked++;

	// os
	if (env.os !== undefined) {
		const ro = (job.body.match(/runs-on:\s*\[?\s*([A-Za-z0-9._-]+)/) || [])[1] || "";
		const fam = OS_FAMILY[Object.keys(OS_FAMILY).find((k) => ro.startsWith(k))] ?? null;
		if (fam && fam !== env.os) {
			problems.push(`${project}: floors record os=${env.os}, but job \`${job.name}\` runs on ${ro} (${fam})`);
		} else if (!fam) {
			unverified.push(`${project}.os (could not resolve \`runs-on\` for job \`${job.name}\`)`);
		}
	}

	// node major
	if (env.node !== undefined) {
		const nv = (job.body.match(/node-version:\s*["']?(\d+)/) || [])[1] || (ci.match(/NODE_VERSION:\s*["']?(\d+)/) || [])[1];
		if (nv && String(nv) !== String(env.node)) {
			problems.push(`${project}: floors record node=${env.node}, but job \`${job.name}\` sets up node ${nv}`);
		} else if (!nv) {
			unverified.push(`${project}.node (no node-version found for job \`${job.name}\`)`);
		}
	}

	// ee_dist — the axis this guard exists for
	if (env.ee_dist !== undefined) {
		const { yes, how } = jobBuildsEeDist(job);
		if (yes !== env.ee_dist) {
			problems.push(
				`${project}: floors record ee_dist=${env.ee_dist}, but job \`${job.name}\` ${yes ? "DOES" : "does NOT"} produce ee/dist — ${how}. ` +
					`Every regression in ${project} is demoted to a warning and the ratchet is disarmed.`,
			);
		}
	}

	for (const k of ["coverage_provider", "edition"]) {
		if (env[k] !== undefined) unverified.push(`${project}.${k} (not statically knowable)`);
	}
}

if (checked === 0) {
	die(
		`resolved ${enforcedBy.size} ratchet step(s) but checked 0 fingerprints`,
		"No project had a readable floors file. That is not a clean tree — it means nothing was verified.",
	);
}

if (unarmed.length > 0) {
	console.log(`NOTE — ${unarmed.length} project(s) have a ratchet step but no floors, so that step cannot fail:`);
	for (const u of unarmed) console.log(`  ${u}`);
	console.log("  Arming changes what CI blocks on: run `--update` deliberately, as a maintainer decision.");
	console.log("");
}

if (problems.length > 0) {
	console.error("Floors fingerprint records an axis its enforcing job cannot reproduce:");
	for (const p of problems) console.error(`  ${p}`);
	console.error("");
	console.error("A recorded axis the enforcing job can never match makes the ratchet pass forever.");
	console.error("Fix the JOB so it reproduces the recorded environment, or re-record the floors in");
	console.error("an environment the job actually has. Do not delete the axis — it exists because it");
	console.error("moves the number.");
	process.exit(1);
}

console.log(
	`OK — ${checked} floors fingerprint(s) reproducible by their enforcing job` +
		(unverified.length > 0 ? `; ${unverified.length} axis/axes UNVERIFIED (${unverified.join(", ")})` : ""),
);
