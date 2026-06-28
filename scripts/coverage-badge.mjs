// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
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

// Each project that emits a coverage-summary.json (turbo fan-out). Missing ones are skipped
// so the script still works if a project hasn't been built.
const SUMMARIES = [
	"apps/console/coverage/coverage-summary.json",
	"packages/ui/coverage/coverage-summary.json",
	"packages/plan-catalog/coverage/coverage-summary.json",
];

let covered = 0;
let total = 0;
for (const rel of SUMMARIES) {
	try {
		const lines = JSON.parse(readFileSync(join(root, rel), "utf8"))?.total?.lines;
		if (lines && typeof lines.covered === "number" && typeof lines.total === "number") {
			covered += lines.covered;
			total += lines.total;
		}
	} catch {
		console.warn(`• skipped ${rel} (no coverage summary)`);
	}
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
