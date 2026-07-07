// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Self-hosted GO coverage badge. Reads the per-module `go test -coverprofile` outputs, sums the
// statement counts across all three Go modules into one aggregate %, and writes a shields.io
// "endpoint" badge JSON the README renders. CI regenerates + commits it on push to main.
//
// Coverprofile line format: `path.go:sLine.sCol,eLine.eCol numStmts count`
// Coverage = Σ(numStmts where count>0) / Σ(numStmts).
//
// Run after generating the profiles, e.g.:
//   (cd apps/cli && go test -coverprofile=cover.out ./...)            # repeat per module
//   node scripts/go-coverage-badge.mjs

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const PROFILES = [
	"apps/cli/cover.out",
	"apps/runner/cover.out",
	"packages/core/cover.out",
];

let covered = 0;
let total = 0;
for (const rel of PROFILES) {
	let text;
	try {
		text = readFileSync(join(root, rel), "utf8");
	} catch {
		console.warn(`• skipped ${rel} (no coverprofile)`);
		continue;
	}
	for (const line of text.split("\n")) {
		if (!line || line.startsWith("mode:")) continue;
		// "<file>:<range> <numStmts> <count>"
		const parts = line.trim().split(/\s+/);
		if (parts.length < 3) continue;
		const numStmts = Number(parts[parts.length - 2]);
		const count = Number(parts[parts.length - 1]);
		if (!Number.isFinite(numStmts)) continue;
		total += numStmts;
		if (count > 0) covered += numStmts;
	}
}

if (total === 0) {
	console.error("✗ No Go coverprofiles found — run `go test -coverprofile=cover.out ./...` per module first.");
	process.exit(1);
}

const pct = Math.round((covered / total) * 1000) / 10;

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
	label: "go coverage",
	message: `${pct}%`,
	color: color(pct),
};

const outPath = join(root, ".github/badges/go-coverage.json");
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, `${JSON.stringify(badge, null, 2)}\n`);

console.log(
	`✓ go coverage ${pct}% (${covered}/${total} statements) → .github/badges/go-coverage.json [${badge.color}]`,
);
