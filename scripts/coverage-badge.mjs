// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Self-hosted coverage badge — no third-party service. Merges the per-project Vitest
// coverage summaries into one line-coverage %, and writes a shields.io "endpoint" badge JSON
// the README renders. CI regenerates + commits it on push to main (see ci.yml `coverage-badge`).
//
// Run after the test suites have produced their coverage: `pnpm exec turbo run test` then
// `node scripts/coverage-badge.mjs`.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// The projects to merge come from scripts/ts-coverage-sweep.json — the committed record of which
// vitest projects declare a coverage block, and the same record the ratchet and the determinism
// probe read.
//
// It used to be a hand-typed list of three, against a record of six, with a `catch` that WARNED
// and moved on. So the published badge quietly described half the repository — apps/marketing, ee
// and packages/format contributed nothing to a number the README presents as "coverage" — and its
// "I could not read that project" branch was indistinguishable from its "everything is fine"
// branch. That is the same shape as the Go badge advertising 21.6% against a real 61.2% for five
// weeks, and it is why a missing summary is now an ERROR that names the project.
const SWEEP = "scripts/ts-coverage-sweep.json";
const projects = JSON.parse(readFileSync(join(root, SWEEP), "utf8"))?.coverage_emitting_projects;
if (!Array.isArray(projects) || projects.length === 0) {
	console.error(`✗ ${SWEEP} records no coverage-emitting projects — refusing to publish a badge over nothing.`);
	process.exit(1);
}

let covered = 0;
let total = 0;
const missing = [];
for (const project of projects) {
	const rel = `${project}/coverage/coverage-summary.json`;
	let lines;
	try {
		lines = JSON.parse(readFileSync(join(root, rel), "utf8"))?.total?.lines;
	} catch {
		missing.push(`${rel} (not readable)`);
		continue;
	}
	if (!lines || typeof lines.covered !== "number" || typeof lines.total !== "number") {
		missing.push(`${rel} (no total.lines — is "json-summary" in its vitest reporter list?)`);
		continue;
	}
	covered += lines.covered;
	total += lines.total;
	console.log(`• ${project}: ${lines.covered}/${lines.total} lines`);
}

if (missing.length > 0) {
	console.error(`✗ ${missing.length} of ${projects.length} recorded project(s) produced no usable coverage summary:`);
	for (const m of missing) console.error(`    ${m}`);
	console.error("  A badge merged over a subset UNDER-REPORTS and looks identical to one that is right.");
	console.error("  Run `pnpm exec turbo run test` first; if a project genuinely stopped emitting");
	console.error(`  coverage, remove it from ${SWEEP} in the same PR.`);
	process.exit(1);
}

if (total === 0) {
	console.error("✗ No coverage summaries found — run `pnpm exec turbo run test` first.");
	process.exit(1);
}

const pct = Math.round((covered / total) * 1000) / 10; // one decimal

/** shields.io named color by coverage threshold. */
function color(p) {
	if (p >= 80) return "brightgreen";
	if (p >= 60) return "green";
	if (p >= 50) return "yellowgreen";
	if (p >= 40) return "yellow";
	if (p >= 25) return "orange";
	return "red";
}

const badge = {
	schemaVersion: 1,
	label: "coverage",
	message: `${pct}%`,
	color: color(pct),
};

const outPath = join(root, ".github/badges/coverage.json");
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, `${JSON.stringify(badge, null, 2)}\n`);

console.log(
	`✓ coverage ${pct}% (${covered}/${total} lines) → .github/badges/coverage.json [${badge.color}]`,
);
