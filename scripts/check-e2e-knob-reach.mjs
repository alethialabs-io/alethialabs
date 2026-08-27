// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
//
// Fails when the e2e harness READS an `ALETHIA_E2E_*` knob that no CI dispatch can SET.
//
// WHY THIS EXISTS
//
// A knob the harness reads but the workflow never sets is a scenario that cannot be run at any
// price, and it fails in the quietest possible way: the code is written, its unit tests pass, the
// flag is documented, and every run silently takes the default forever. There is no red, because
// nothing is wrong — the question simply cannot be asked.
//
// This repo has paid for that three times:
//
//   * #2775 — `ALETHIA_E2E_BYO_IAC` was a step-level `env:` key that no dimension could set, so the
//     entire BYO-IaC custody chain had never executed in CI. "Written, shipped, never run."
//   * #2591 — the day-2 ArgoCD-URL probe failed on the first run that ever had a URL. The issue
//     names the discriminating experiment exactly ("one aws floor run with E2E_DAY2_ACCESS_TIMEOUT
//     =10m") and it could not be dispatched, because that knob reached nothing.
//   * #2717 class (b) — falco/loki/vault sit `Progressing` at the end of the add-on budget, and
//     "the budget is short" versus "this will never converge" are a ceiling apart. The knob that
//     tells them apart, `ALETHIA_E2E_ARGO_TIMEOUT`, was likewise unreachable.
//
// THE METHOD
//
// The harness is the reference, not a hand-kept list: every `ALETHIA_E2E_*` name that appears in
// `test/e2e/**.go` is a knob something reads. A name the nightly workflow mentions ANYWHERE is
// reachable — an `env:` key, a `$GITHUB_ENV` export from the resolver, a comment naming it. That is
// deliberately generous: this check answers "could a dispatch ever influence this?", and being
// stricter would fail on the resolver's export form, which is a legitimate second mechanism.
//
// THE ALLOWLIST IS A RATCHET, in both directions. See scripts/e2e/knobs-local-only.txt.

import fs from "node:fs";
import path from "node:path";

const HARNESS_DIR = "test/e2e";
const WORKFLOW = ".github/workflows/e2e-nightly.yml";
const RESOLVER = "scripts/e2e/resolve-dimension.sh";
const ALLOWFILE = "scripts/e2e/knobs-local-only.txt";

const KNOB = /\bALETHIA_E2E_[A-Z0-9_]+\b/g;

const repoRoot = process.cwd();
const fail = [];

/** Every `ALETHIA_E2E_*` name appearing in the harness's Go sources, recursively. */
function knobsReadByHarness(dir) {
	const found = new Set();
	for (const entry of fs.readdirSync(path.join(repoRoot, dir), { withFileTypes: true })) {
		const rel = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			for (const k of knobsReadByHarness(rel)) found.add(k);
		} else if (entry.name.endsWith(".go")) {
			for (const m of fs.readFileSync(path.join(repoRoot, rel), "utf8").matchAll(KNOB)) {
				found.add(m[0]);
			}
		}
	}
	return found;
}

/** Every name the CI side mentions — workflow or resolver, in any form. */
function knobsReachableFromCI() {
	const found = new Set();
	for (const f of [WORKFLOW, RESOLVER]) {
		if (!fs.existsSync(path.join(repoRoot, f))) {
			fail.push(`${f} is missing — refusing to report reachability against a file that is not there`);
			continue;
		}
		for (const m of fs.readFileSync(path.join(repoRoot, f), "utf8").matchAll(KNOB)) found.add(m[0]);
	}
	return found;
}

function declaredLocalOnly() {
	if (!fs.existsSync(path.join(repoRoot, ALLOWFILE))) {
		fail.push(`${ALLOWFILE} is missing`);
		return new Set();
	}
	return new Set(
		fs
			.readFileSync(path.join(repoRoot, ALLOWFILE), "utf8")
			.split("\n")
			.map((l) => l.trim())
			.filter((l) => l !== "" && !l.startsWith("#")),
	);
}

const read = knobsReadByHarness(HARNESS_DIR);
const reachable = knobsReachableFromCI();
const declared = declaredLocalOnly();

// A scan that found nothing must NOT read as "nothing is wrong". If the extractor stops matching —
// the harness moves, the naming convention changes — every downstream set is empty and every
// comparison passes. That is the failure mode this whole file exists to prevent, so it is checked
// first and it is fatal.
if (read.size === 0) {
	fail.push(`no ALETHIA_E2E_* knobs found under ${HARNESS_DIR}/ — the extractor has stopped matching, so NOTHING was checked`);
}

const unreachable = [...read].filter((k) => !reachable.has(k) && !declared.has(k)).sort();
for (const k of unreachable) {
	fail.push(`${k} is read by the harness but no dispatch can set it — wire it in ${WORKFLOW}, or declare it in ${ALLOWFILE} with the reason`);
}

// Ratchet, direction two: a declared knob that became reachable must leave the list, or the list
// grows stale and stops meaning anything.
const nowReachable = [...declared].filter((k) => reachable.has(k)).sort();
for (const k of nowReachable) {
	fail.push(`${k} is declared local-only in ${ALLOWFILE} but IS now reachable from CI — remove the line, so the list can only shrink`);
}

// Ratchet, direction three: a declared knob the harness no longer reads is a line about nothing.
const gone = [...declared].filter((k) => !read.has(k)).sort();
for (const k of gone) {
	fail.push(`${k} is declared in ${ALLOWFILE} but the harness no longer reads it — remove the stale line`);
}

for (const k of [...read].sort()) {
	const how = reachable.has(k) ? "wired" : declared.has(k) ? "local-only (declared)" : "UNREACHABLE";
	console.log(`  ${how.padEnd(22)} ${k}`);
}
console.log(`\nchecked ${read.size} knob(s) read by ${HARNESS_DIR}/`);

if (fail.length > 0) {
	for (const f of fail) console.error(`::error::check-e2e-knob-reach: ${f}`);
	console.error(`\ncheck-e2e-knob-reach: ${fail.length} problem(s).`);
	process.exit(1);
}
console.log("OK — every knob the harness reads is either reachable from a dispatch or declared local-only");
