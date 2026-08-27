#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Runs knip over apps/console, behind two assertions about knip's own configuration.
//
// Both exist for the same reason, which is the failure mode this repo keeps producing: a
// check whose "nothing found" branch is indistinguishable from its "nothing wrong" branch.
//
//   1. ENTRY. knip walks the import graph from `entry`. If a glob resolves to no files,
//      knip treats nothing as reachable — and then reports a clean bill of health having
//      analysed nothing at all. A rename in `app/` is enough to do it.
//
//   2. IGNOREISSUES. Every key there is a file knip WOULD flag, suppressed deliberately.
//      When that file is deleted the suppression becomes dead weight, and — this is the
//      part that matters — a suppression naming a file that no longer exists is
//      indistinguishable from one doing real work. The list is a baseline whose only
//      permitted direction is DOWN, so a stale key is a ratchet that quietly stopped
//      ratcheting. Four of them went stale within an hour of the baseline being written,
//      when the lane deleting those modules merged first.
//
// Neither check knows anything about dead code. They assert that the thing which does is
// pointed at a real surface, and they fail — rather than printing OK — when it is not.

import { spawnSync } from "node:child_process";
import { existsSync, globSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const CONSOLE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG = join(CONSOLE_DIR, "knip.json");

/** Fails the run with a message that names the fix, not just the symptom. */
function fail(message) {
	console.error(`check:dead-code: ${message}`);
	process.exit(1);
}

if (typeof globSync !== "function") {
	// Node < 22. Refusing beats running: without globSync neither assertion can be made,
	// and a knip run nobody verified the surface of is the thing this script exists to stop.
	fail(
		"fs.globSync is unavailable (needs Node >= 22) — refusing to run knip without a verified entry surface",
	);
}

let config;
try {
	config = JSON.parse(readFileSync(CONFIG, "utf8"));
} catch (err) {
	fail(`cannot read ${CONFIG}: ${err.message}`);
}

const entry = config.entry ?? [];
if (entry.length === 0) {
	fail("knip.json declares no `entry` patterns — knip would analyse nothing");
}

// ── 1. every entry glob still matches something ───────────────────────────────────────
const emptyGlobs = entry.filter((g) => globSync(g, { cwd: CONSOLE_DIR }).length === 0);
if (emptyGlobs.length) {
	fail(
		`knip entry pattern(s) match NO files: ${emptyGlobs.join(", ")}.\n` +
			"  knip would then analyse nothing and report nothing — which is NOT the same as\n" +
			"  nothing being wrong. Re-point the pattern at wherever that surface moved.",
	);
}

// ── 2. every suppression still names a file that exists ───────────────────────────────
const suppressed = Object.keys(config.ignoreIssues ?? {});
const stale = suppressed.filter((p) => globSync(p, { cwd: CONSOLE_DIR }).length === 0);
if (stale.length) {
	fail(
		`ignoreIssues names ${stale.length} file(s) that no longer exist:\n` +
			stale.map((p) => `    ${p}`).join("\n") +
			"\n  Delete those keys. The baseline may only shrink, and a suppression for a deleted\n" +
			"  file is indistinguishable from one still doing work — which is how a ratchet stops\n" +
			"  ratcheting without anything going red.",
	);
}

const entryPaths = entry.reduce((n, g) => n + globSync(g, { cwd: CONSOLE_DIR }).length, 0);
console.error(
	`check:dead-code: ${entry.length} entry patterns resolve to ${entryPaths} paths; ` +
		`${suppressed.length} suppressions all name existing files`,
);

// ── knip itself ───────────────────────────────────────────────────────────────────────
//
// Resolved from the workspace rather than taken from PATH. Under `pnpm run` the local
// .bin is on PATH and a bare "knip" works; run directly as `node scripts/check-dead-code.mjs`
// it is not, and spawnSync returns ENOENT — which without this lookup would have surfaced as
// a red run that never analysed anything, the exact shape the rest of this file guards against.
function findKnip() {
	let dir = CONSOLE_DIR;
	for (;;) {
		const bin = join(dir, "node_modules", ".bin", "knip");
		if (existsSync(bin)) return bin;
		const parent = dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}

const bin = findKnip();
if (!bin) {
	fail(
		"knip is not installed in this workspace (no node_modules/.bin/knip from apps/console upward).\n" +
			"  Run `pnpm install` first — refusing to report a clean tree from a check that never ran.",
	);
}

const knip = spawnSync(bin, ["--no-progress"], {
	cwd: CONSOLE_DIR,
	stdio: "inherit",
	shell: process.platform === "win32",
});
if (knip.error) fail(`could not run knip: ${knip.error.message}`);
process.exit(knip.status ?? 1);
